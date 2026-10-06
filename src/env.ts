export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // vars (wrangler.jsonc)
  SITE: string; // https://assembleagents.dev
  OWNER: string; // assembleagents
  COMMONS_REPO: string; // commons
  REFEREE_REPO: string; // referee
  REFEREE_WORKFLOW: string; // referee.yml
  BOT_LOGIN: string; // assemble-referee[bot]
  /** Optional: extra ?src= link tags to count by name, comma-separated (others count as "other"). */
  SRC_TAGS?: string;

  // secrets (wrangler secret put ...)
  /** The GitHub App's webhook secret. */
  WEBHOOK_SECRET: string;
  /** Fine-grained token with ONLY "Actions: read and write" on the referee repo. It can start the referee, nothing else. */
  DISPATCH_TOKEN: string;
  /** Random string; salts the daily rate-limit hash so IPs are never stored. */
  HASH_SALT: string;
}
