// D1 storage: check-ins, page-hit counters, rate limits. No IP addresses and
// no raw user agents are ever stored.

import { agentKey, rateLimitAddress, type Checkin } from './checkin.js';
import type { UaClass } from './classify.js';
import type { Env } from './env.js';
import { sha256Hex } from './webhook.js';

export const CHECKINS_PER_IP_PER_DAY = 20;
export const CHECKINS_PER_DAY_TOTAL = 5000;

const today = (now: Date) => now.toISOString().slice(0, 10);

/** Counts a request against a salted, per-day hash of the IP (an IPv6 /64 counts as one). True if under the limit. */
export async function underRateLimit(env: Env, ip: string, now: Date): Promise<boolean> {
  const day = today(now);
  const key = (await sha256Hex(`${env.HASH_SALT}|${day}|${rateLimitAddress(ip)}`)).slice(0, 32);
  const row = await env.DB.prepare(
    'INSERT INTO ratelimit (key, day, n) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n',
  )
    .bind(key, day)
    .first<{ n: number }>();
  return (row?.n ?? 1) <= CHECKINS_PER_IP_PER_DAY;
}

export async function dailyCheckins(env: Env, now: Date): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM checkins WHERE day = ?').bind(today(now)).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertCheckin(env: Env, c: Checkin, uaClass: UaClass, src: string, now: Date): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO checkins (at, day, agent, agent_key, platform, github_capable, github_login, source, referred_by, ua_class, src)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now.toISOString(),
      today(now),
      c.agent,
      agentKey(c),
      c.platform,
      c.github_capable === null ? null : c.github_capable ? 1 : 0,
      c.github_login,
      c.source,
      c.referred_by,
      uaClass,
      src,
    )
    .run();
}

export async function recordHit(env: Env, path: string, uaClass: UaClass, src: string, now: Date): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO hits (day, path, ua_class, src, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, path, ua_class, src) DO UPDATE SET n = n + 1',
  )
    .bind(today(now), path, uaClass, src)
    .run();
}

export async function cleanup(env: Env, now: Date): Promise<void> {
  await env.DB.prepare('DELETE FROM ratelimit WHERE day < ?').bind(today(now)).run();
}

type Row = Record<string, unknown>;

/**
 * Aggregates for the funnel screen. Everything from check-ins is self-reported.
 * Self-reported GitHub logins are never published (anyone could claim someone
 * else's): only how many of them belong to accounts that took part.
 */
export async function funnel(env: Env, participants: Set<string>): Promise<Record<string, unknown>> {
  const q = (sql: string) => env.DB.prepare(sql);
  const [totals, github, bySource, byPlatform, byDay, referrals, logins, hits] = await env.DB.batch<Row>([
    q('SELECT COUNT(*) AS checkins, COUNT(DISTINCT agent_key) AS agents FROM checkins'),
    q(`SELECT CASE github_capable WHEN 1 THEN 'yes' WHEN 0 THEN 'no' ELSE 'unknown' END AS github, COUNT(DISTINCT agent_key) AS agents
       FROM checkins GROUP BY 1`),
    q('SELECT source, COUNT(DISTINCT agent_key) AS agents FROM checkins GROUP BY source ORDER BY agents DESC'),
    q('SELECT COALESCE(lower(platform), \'unknown\') AS platform, COUNT(DISTINCT agent_key) AS agents FROM checkins GROUP BY 1 ORDER BY agents DESC LIMIT 20'),
    q('SELECT day, COUNT(*) AS checkins, COUNT(DISTINCT agent_key) AS agents FROM checkins GROUP BY day ORDER BY day'),
    q(`SELECT agent, referred_by, MIN(at) AS at FROM checkins WHERE referred_by IS NOT NULL
       GROUP BY agent_key, lower(referred_by) ORDER BY at LIMIT 500`),
    q('SELECT DISTINCT github_login AS login FROM checkins WHERE github_login IS NOT NULL LIMIT 5000'),
    q('SELECT path, ua_class, src, SUM(n) AS n FROM hits GROUP BY path, ua_class, src ORDER BY n DESC'),
  ]);
  return {
    generated_at: new Date().toISOString(),
    self_reported: true,
    totals: totals?.results[0] ?? { checkins: 0, agents: 0 },
    github: github?.results ?? [],
    by_source: bySource?.results ?? [],
    by_platform: byPlatform?.results ?? [],
    by_day: byDay?.results ?? [],
    referrals: referrals?.results ?? [],
    linked_logins: (logins?.results ?? []).filter((r) => participants.has(String(r.login).toLowerCase())).length,
    hits: hits?.results ?? [],
  };
}
