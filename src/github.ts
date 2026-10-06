// The observatory's only contact with GitHub: reading public files from the
// commons (no token), and with a token that can only manage the referee's
// workflow runs: starting the referee, and re-enabling its workflow when
// GitHub switches it off for inactivity.

import type { Env } from './env.js';
import { workflowFix } from './workflow.js';

const UA = 'assemble-observatory';

export function rawUrl(env: Env, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${env.OWNER}/${env.COMMONS_REPO}/${ref}/${path}`;
}

/** Fetches a public file from the commons, cached at Cloudflare's edge for `ttl` seconds. Null on 404. */
export async function fetchRaw(env: Env, ref: string, path: string, ttl: number): Promise<string | null> {
  const res = await fetch(rawUrl(env, ref, path), { headers: { 'User-Agent': UA }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw ${path}: ${res.status}`);
  return res.text();
}

const DEBOUNCE_MS = 45_000;

function apiHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.DISPATCH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
}

const WORKFLOW_CHECK_MS = 60 * 60_000;

/** At most hourly: re-enables the referee workflow if GitHub disabled it for inactivity. */
export async function keepRefereeEnabled(env: Env, now = Date.now()): Promise<'checked' | 'enabled' | 'skipped' | 'no-token'> {
  if (!env.DISPATCH_TOKEN) return 'no-token';
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('last_workflow_check').first<{ value: string }>();
  if (row && now - Number(row.value) < WORKFLOW_CHECK_MS) return 'skipped';
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('last_workflow_check', String(now)).run();

  const url = `https://api.github.com/repos/${env.OWNER}/${env.REFEREE_REPO}/actions/workflows/${env.REFEREE_WORKFLOW}`;
  const res = await fetch(url, { headers: apiHeaders(env) });
  if (!res.ok) throw new Error(`workflow state: ${res.status} ${await res.text()}`);
  const { state } = (await res.json()) as { state?: string };
  const fix = workflowFix(state);
  if (fix === 'warn') console.warn(`the referee workflow is ${state ?? 'in an unknown state'}; leaving it alone`);
  if (fix !== 'enable') return 'checked';
  const enabled = await fetch(`${url}/enable`, { method: 'PUT', headers: apiHeaders(env) });
  if (enabled.status !== 204) throw new Error(`enable workflow: ${enabled.status} ${await enabled.text()}`);
  console.log('re-enabled the referee workflow (GitHub had disabled it for inactivity)');
  return 'enabled';
}

/**
 * Starts a referee run via workflow_dispatch, at most once per 45s.
 * GitHub's concurrency group keeps one run going and one queued, so extra
 * dispatches are harmless; the debounce just avoids wasting API calls.
 */
export async function dispatchReferee(env: Env, reason: string, now = Date.now()): Promise<'dispatched' | 'debounced' | 'no-token'> {
  if (!env.DISPATCH_TOKEN) return 'no-token';
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('last_dispatch').first<{ value: string }>();
  if (row && now - Number(row.value) < DEBOUNCE_MS) return 'debounced';
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('last_dispatch', String(now)).run();

  const url = `https://api.github.com/repos/${env.OWNER}/${env.REFEREE_REPO}/actions/workflows/${env.REFEREE_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...apiHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) throw new Error(`dispatch (${reason}) failed: ${res.status} ${await res.text()}`);
  return 'dispatched';
}
