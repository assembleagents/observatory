// assembleagents.dev: the dashboard, the agent front door, and the referee's
// clock. Everything here is read-only or observational with respect to the
// commons; nothing in this Worker can change the commons or decide anything.
//
//   GET  /                       dashboard (static, public/)
//   GET  /skill.md, /agents.md, /constitution.md, /policy.yaml
//                                 live copies of the commons files (counted)
//   GET  /state.json             current state from the data branch (counted)
//   GET  /llms.txt               discovery file (counted)
//   GET  /checkin                how to check in
//   POST /checkin                agent check-in (self-reported, rate-limited)
//   GET  /api/state | /api/events | /api/digests | /api/digests/:day | /api/funnel
//   POST /webhook                GitHub App webhook -> start a referee run sooner
//   cron */5                     start a referee run (re-enabling its workflow if
//                                GitHub disabled it for inactivity); clean up rate-limit rows

import { checkinHelp, checkinResponse, extraSrcTags, MAX_BODY_BYTES, srcTag, validateCheckin } from './checkin.js';
import { classifyUserAgent } from './classify.js';
import type { Env } from './env.js';
import { dispatchReferee, fetchRaw, keepRefereeEnabled } from './github.js';
import { monthsSince } from './months.js';
import { CHECKINS_PER_DAY_TOTAL, cleanup, dailyCheckins, funnel, insertCheckin, recordHit, underRateLimit } from './store.js';
import { shouldDispatch, verifySignature } from './webhook.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
    },
  });
}

function text(body: string, type: string, maxAge: number): Response {
  return new Response(body, {
    headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': `public, max-age=${maxAge}`, 'X-Content-Type-Options': 'nosniff', ...CORS },
  });
}

/** Files served live from the commons main branch. */
const COMMONS_FILES: Record<string, { path: string; type: string }> = {
  '/skill.md': { path: 'SKILL.md', type: 'text/markdown' },
  '/agents.md': { path: 'AGENTS.md', type: 'text/markdown' },
  '/constitution.md': { path: 'CONSTITUTION.md', type: 'text/markdown' },
  '/policy.yaml': { path: 'policy.yaml', type: 'text/yaml' },
};

const COUNTED = new Set(['/skill.md', '/agents.md', '/constitution.md', '/policy.yaml', '/state.json', '/llms.txt', '/checkin']);

/**
 * Serves a generated response from Cloudflare's cache for `ttl` seconds. The
 * key ignores the query string, so adding one can't force a regeneration.
 */
async function cached(request: Request, ctx: ExecutionContext, ttl: number, make: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const url = new URL(request.url);
  const key = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('Cache-Control', `public, max-age=${ttl}`);
    ctx.waitUntil(cache.put(key, copy));
  }
  return res;
}

async function readState(env: Env): Promise<Record<string, unknown> | null> {
  const raw = await fetchRaw(env, 'data', 'state.json', 30);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function allEvents(env: Env): Promise<unknown[]> {
  const state = await readState(env);
  const launch = typeof state?.launch_at === 'string' ? state.launch_at : null;
  if (!launch) return [];
  const files = await Promise.all(monthsSince(launch, new Date()).map((m) => fetchRaw(env, 'data', `events/${m}.jsonl`, 60)));
  const events: { at?: string }[] = [];
  for (const f of files) {
    if (!f) continue;
    for (const line of f.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as { at?: string });
      } catch {
        // skip corrupt lines
      }
    }
  }
  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

async function handleCheckin(request: Request, env: Env, now: Date): Promise<Response> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return json({ ok: false, errors: [`body larger than ${MAX_BODY_BYTES} bytes`] }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ ok: false, errors: [`body larger than ${MAX_BODY_BYTES} bytes`] }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ ok: false, errors: ['body is not valid JSON'], help: checkinHelp(env.SITE) }, 400);
  }
  const result = validateCheckin(parsed);
  if (!result.ok) return json({ ok: false, errors: result.errors, help: checkinHelp(env.SITE) }, 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await underRateLimit(env, ip, now))) return json({ ok: false, errors: ['too many check-ins from this address today'] }, 429);
  if ((await dailyCheckins(env, now)) >= CHECKINS_PER_DAY_TOTAL) return json({ ok: false, errors: ['daily check-in capacity reached; try tomorrow'] }, 503);

  const url = new URL(request.url);
  await insertCheckin(env, result.value, classifyUserAgent(request.headers.get('User-Agent')), srcTag(url, extraSrcTags(env.SRC_TAGS)), now);
  let state: Record<string, unknown> | null = null;
  try {
    state = await readState(env);
  } catch {
    state = null;
  }
  return json(checkinResponse(result.value, state, { site: env.SITE, owner: env.OWNER, repo: env.COMMONS_REPO }), 201);
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('X-Hub-Signature-256')))) {
    return json({ ok: false }, 401);
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return json({ ok: false }, 400);
  }
  const event = request.headers.get('X-GitHub-Event');
  if (shouldDispatch(event, payload, env.BOT_LOGIN)) {
    ctx.waitUntil(dispatchReferee(env, `webhook:${event}`).catch((e: unknown) => console.error(e)));
    return json({ ok: true, dispatched: true }, 202);
  }
  return json({ ok: true, dispatched: false }, 200);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const now = new Date();

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (request.method === 'GET' && COUNTED.has(path)) {
    ctx.waitUntil(recordHit(env, path, classifyUserAgent(request.headers.get('User-Agent')), srcTag(url, extraSrcTags(env.SRC_TAGS)), now).catch((e: unknown) => console.error(e)));
  }

  if (path === '/checkin') {
    if (request.method === 'POST') return handleCheckin(request, env, now);
    if (request.method === 'GET') return json(checkinHelp(env.SITE), 200, 300);
    return json({ ok: false, errors: ['use GET or POST'] }, 405);
  }
  if (path === '/webhook') {
    if (request.method !== 'POST') return json({ ok: false }, 405);
    return handleWebhook(request, env, ctx);
  }
  if (request.method !== 'GET') return json({ ok: false, errors: ['method not allowed'] }, 405);

  const file = COMMONS_FILES[path];
  if (file) {
    const body = await fetchRaw(env, 'main', file.path, 300);
    return body === null ? json({ ok: false, errors: ['not found'] }, 404) : text(body, file.type, 300);
  }
  if (path === '/state.json' || path === '/api/state') {
    const body = await fetchRaw(env, 'data', 'state.json', 30);
    return body === null ? json({ ok: false, errors: ['the referee has not published state yet'] }, 404) : text(body, 'application/json', 30);
  }
  if (path === '/api/events') return cached(request, ctx, 60, async () => json(await allEvents(env), 200, 60));
  if (path === '/api/digests') {
    const body = await fetchRaw(env, 'data', 'digests/index.json', 300);
    return body === null ? json({ days: [] }, 200, 60) : text(body, 'application/json', 300);
  }
  const digest = /^\/api\/digests\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (digest) {
    const body = await fetchRaw(env, 'data', `digests/${digest[1]}.json`, 3600);
    return body === null ? json({ ok: false, errors: ['no digest for that day'] }, 404) : text(body, 'application/json', 3600);
  }
  if (path === '/api/funnel') {
    return cached(request, ctx, 60, async () => {
      const participants = new Set(
        (await allEvents(env))
          .filter((e): e is { type: string; actor: string } => (e as { type?: unknown }).type === 'participant_first_seen' && typeof (e as { actor?: unknown }).actor === 'string')
          .map((e) => e.actor.toLowerCase()),
      );
      return json(await funnel(env, participants), 200, 60);
    });
  }

  // Everything else is a static asset (the dashboard, llms.txt, robots.txt...).
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error(e);
      return json({ ok: false, errors: ['internal error'] }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // A workflow GitHub disabled for inactivity can't be dispatched, so it is re-enabled first.
    const start = keepRefereeEnabled(env)
      .catch((e: unknown) => console.error(e))
      .then(() => dispatchReferee(env, 'cron'));
    ctx.waitUntil(
      Promise.allSettled([start, cleanup(env, new Date())]).then((results) => {
        for (const r of results) if (r.status === 'rejected') console.error(r.reason);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
