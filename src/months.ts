/** Every month from the launch month to `now`, as YYYY-MM (at most 120). */
export function monthsSince(launchAt: string, now: Date): string[] {
  const out: string[] = [];
  const start = new Date(launchAt);
  if (Number.isNaN(start.getTime())) return out;
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d.getTime() <= now.getTime() && out.length < 120) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
