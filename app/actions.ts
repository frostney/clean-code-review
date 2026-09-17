"use server";

import { headers } from "next/headers";
import { createElement, type ReactNode } from "react";
import { fetchPullRequest } from "@/agent/lib/github";
import { PullRequestBody } from "@/app/_components/PullRequestBody";
import { callerIp, throttled } from "@/lib/throttle";

/**
 * A pull request, fetched for the page.
 *
 * The description arrives as a React node rather than as markdown: it is
 * rendered here, on the server, so `react-markdown` and its whole markdown
 * pipeline stay out of the browser's bundle. The same text comes along as
 * `bodyText`, because the review prompt carries the author's own words to Luna
 * and a rendered node is no use to a model.
 */
export interface PullRequestPayload {
  url: string;
  title: string;
  /** The description, already rendered. Null when there is none. */
  body: ReactNode;
  /** The description as the author wrote it, for the summarize turn. */
  bodyText: string;
  diff: string;
  /** Files GitHub reports on the PR, for the skip count. */
  changedFiles: number;
}

export type PullRequestAnswer = { ok: true; pr: PullRequestPayload } | { ok: false; error: string };

/**
 * Fetch a public pull request and hand back everything the page opens a review
 * with. Failure is a value, not a throw: every way this can fail is something
 * to put on screen — a private repository, a rate limit, a URL that is not a
 * pull request — and a rejected action would only reach the browser as a
 * digest with the reason stripped out.
 */
export async function openPullRequest(url: string): Promise<PullRequestAnswer> {
  if (throttled(callerIp(await headers()))) {
    return { ok: false, error: "Too many pull requests fetched from this address. Try again in a few minutes." };
  }
  try {
    const pr = await fetchPullRequest(url);
    return {
      ok: true,
      pr: {
        url: pr.url,
        title: pr.title,
        body: pr.body.trim() ? createElement(PullRequestBody, { body: pr.body }) : null,
        bodyText: pr.body,
        diff: pr.diff,
        changedFiles: pr.changedFiles,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not fetch that pull request." };
  }
}
