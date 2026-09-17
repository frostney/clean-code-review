import { fetchPullRequest } from "@/agent/lib/github";
import { callerIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

/**
 * GET /api/github-pr?url=https://github.com/owner/repo/pull/123
 * Returns { url, title, body, diff, changedFiles } for a public pull request.
 *
 * The page itself no longer calls this — it uses the `openPullRequest` server
 * action, which renders the description on the server — but scripts and other
 * callers still do, so it stays, sharing the action's rate limit.
 */
export async function GET(request: Request) {
  if (throttled(callerIp(request.headers))) return Response.json({ error: "Too many pull requests fetched from this address. Try again in a few minutes." }, { status: 429 });
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
