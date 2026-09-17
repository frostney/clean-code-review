import { fetchPullRequest } from "@/agent/lib/github";

export const dynamic = "force-dynamic";

/** Best-effort brake, like the session one: this instance's memory only. */
const REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60 * 1_000;
const seen = new Map<string, number[]>();

function throttled(request: Request): boolean {
  const ip = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  if (!ip) return false;
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= REQUESTS_PER_WINDOW) return true;
  recent.push(now);
  seen.set(ip, recent);
  if (seen.size > 10_000) seen.clear();
  return false;
}

/**
 * GET /api/github-pr?url=https://github.com/owner/repo/pull/123
 * Returns { url, title, body, diff, changedFiles } for a public pull request.
 */
export async function GET(request: Request) {
  if (throttled(request)) return Response.json({ error: "Too many pull requests fetched from this address. Try again in a few minutes." }, { status: 429 });
  const url = new URL(request.url).searchParams.get("url") ?? "";
  try {
    const pr = await fetchPullRequest(url);
    return Response.json(pr, { headers: { "cache-control": "public, max-age=60" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch that pull request.";
    const status = /not a GitHub|not found|too large/.test(message) ? 400 : /rate limit/.test(message) ? 429 : 502;
    return Response.json({ error: message }, { status });
  }
}
