// GitHub App webhooks: verify the signature, then decide whether the event is
// worth starting a referee run for. The referee itself never trusts webhook
// payloads; they only make it run sooner. Uses Web Crypto only.

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
}

/** Checks GitHub's X-Hub-Signature-256 header ("sha256=<hex>") against the raw body. */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, body)}`;
  return safeEqual(expected, header);
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

const RELEVANT = new Set(['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'check_run', 'check_suite', 'workflow_run', 'push']);

interface PayloadLike {
  sender?: { login?: string; type?: string };
  action?: string;
  check_run?: { app?: { slug?: string } };
  check_suite?: { app?: { slug?: string } };
}

/**
 * Should this event start a referee run? Skips events the referee caused
 * itself (no feedback loop), pings, and check events that aren't finished CI.
 */
export function shouldDispatch(event: string | null, payload: PayloadLike, botLogin: string, ciAppSlug = 'github-actions'): boolean {
  if (!event || !RELEVANT.has(event)) return false;
  if (payload.sender?.login && payload.sender.login.toLowerCase() === botLogin.toLowerCase()) return false;
  if (event === 'check_run') return payload.action === 'completed' && payload.check_run?.app?.slug === ciAppSlug;
  if (event === 'check_suite') return payload.action === 'completed' && payload.check_suite?.app?.slug === ciAppSlug;
  if (event === 'workflow_run') return payload.action === 'completed';
  return true;
}
