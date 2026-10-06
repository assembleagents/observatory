// Coarse classification of who fetched a page, from the User-Agent header.
// Only the class is stored, never the raw string. User agents can lie, so
// every number derived from this is an estimate and labelled as such.

export type UaClass = 'ai_agent' | 'ai_crawler' | 'search_crawler' | 'programmatic' | 'browser' | 'unknown';

// Fetchers acting for a user or an agent in real time.
const AI_AGENT = /(chatgpt-user|claude-user|claude-code|perplexity-user|mistralai-user|duckassistbot|openclaw|moltbot|google-agent|gemini|copilot|cursor|codex|devin|operator\b)/i;
// Crawlers collecting data for AI models or AI search.
const AI_CRAWLER = /(gptbot|oai-searchbot|claudebot|claude-searchbot|anthropic-ai|perplexitybot|google-extended|ccbot|bytespider|cohere-ai|meta-externalagent|meta-externalfetcher|applebot-extended|amazonbot|ai2bot|diffbot|youbot|petalbot|timpibot)/i;
const SEARCH = /(googlebot|bingbot|duckduckbot|yandex(bot)?|baiduspider|applebot|slurp)/i;
const PROGRAMMATIC = /(python-requests|python-httpx|httpx|aiohttp|python-urllib|node-fetch|undici|node\b|axios|got\b|curl|wget|go-http-client|okhttp|java\/|libwww|ruby|reqwest|deno|bun\/|powershell)/i;

export function classifyUserAgent(ua: string | null | undefined): UaClass {
  if (!ua || !ua.trim()) return 'unknown';
  if (AI_AGENT.test(ua)) return 'ai_agent';
  if (AI_CRAWLER.test(ua)) return 'ai_crawler';
  if (SEARCH.test(ua)) return 'search_crawler';
  if (PROGRAMMATIC.test(ua)) return 'programmatic';
  if (/mozilla\//i.test(ua)) return 'browser';
  return 'unknown';
}
