import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
} from '@/agent/lib/budgets';
import { QUESTION_COUNT } from '@/agent/lib/questions';
import { REVIEW_LIMITS } from '@/agent/lib/review';
import { REVIEWER_MODEL } from '@/agent/lib/summary';
import {
  MCP_CALLS_PER_WINDOW,
  MCP_PATH,
  MCP_WINDOW_MINUTES,
} from '@/lib/mcp-limits';
import { SITE } from '@/lib/site';
import { REQUESTS_PER_WINDOW, WINDOW_MS } from '@/lib/throttle';

/**
 * What happens to code somebody pastes here, written from the code that does
 * it rather than from a template.
 *
 * Every claim below is one a reader could check against this repository, and
 * every figure is imported from the module that enforces it. There is no
 * consent banner to describe, no cookie, no analytics and no account, so the
 * page is short: a privacy policy that lists rights against data nobody
 * collects is a worse answer than the true one.
 *
 * Nothing links here from this file's side. The footer's link is the footer's.
 */

/** Minutes are how a reader counts a rate-limit window; the brake counts milliseconds. */
const MS_PER_MINUTE = 60_000;
const WINDOW_MINUTES = Math.round(WINDOW_MS / MS_PER_MINUTE);

export const metadata: Metadata = {
  alternates: { canonical: '/privacy' },
  description:
    'No account, no database, no cookies and no analytics. What leaves the browser when you paste code here, who processes it, and how long anything is kept.',
  openGraph: {
    description:
      'What leaves the browser when you paste code into Clean Code Review, who processes it, and how long anything is kept.',
    title: `Privacy · ${SITE.name}`,
    type: 'article',
    url: `${SITE.url}/privacy`,
  },
  robots: { follow: true, index: true },
  title: 'Privacy',
};

/** One section: a heading a reader can link to, and its paragraphs. */
function Section({
  children,
  id,
  title,
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={id} className="mt-6">
      <h2
        className="mb-1.5 text-tiny font-semibold tracking-wider text-muted uppercase"
        id={id}
      >
        {title}
      </h2>
      <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-6">
      <main className="max-w-[72ch]">
        <p className="text-tiny text-muted">
          <Link className="underline hover:text-ink" href="/">
            {SITE.name}
          </Link>
        </p>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">
          Privacy
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          There is no account, no database, no cookie and no analytics on this
          site. Nothing you paste is written down anywhere this site keeps, and
          nothing is tied to you, because there is no you here: there is a
          browser tab and the session it holds open.
        </p>

        <Section id="what-leaves" title="What leaves the browser">
          <p>
            The code you paste, or the diff fetched for the pull request you
            named, is sent to this site&rsquo;s server as the message of one
            agent turn. The server sends each file to Jev, TypeSafe&rsquo;s
            evaluation model, through the Vercel AI Gateway, to be answered
            against {QUESTION_COUNT} questions. It then sends Jev&rsquo;s
            findings and that file&rsquo;s text to Luna ({REVIEWER_MODEL}),
            through the same gateway, to be written up as the review you read.
          </p>
          <p>
            That is the whole path. Your code reaches the Vercel AI Gateway and
            the two model providers behind it, and nothing else. At most{' '}
            {REVIEW_LIMITS.maxFiles} code files go out in a turn, each cut to{' '}
            {REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters,
            with up to {REVIEW_LIMITS.maxProseFiles} prose files shown beside
            them and never sent to be judged.
          </p>
          <p>
            Code can also arrive from an agent rather than from a browser tab,
            through the MCP server at <code>{`${SITE.url}${MCP_PATH}`}</code>.
            That path sends the code on the same route to the same two models,
            in one request, with no session and no tab. It keeps what the page
            keeps and nothing more: the same one-hour cache of answers and
            reviews, and a count of calls per network address,{' '}
            {MCP_CALLS_PER_WINDOW} per {MCP_WINDOW_MINUTES} minutes, held in one
            server instance&rsquo;s memory for that window.
          </p>
          <p>
            The site has a model budget that every visitor shares:{' '}
            {dollars(PAGE_HOURLY_BUDGET_USD)} per hour and{' '}
            {dollars(PAGE_DAILY_BUDGET_USD)} per UTC day, and it pauses reviews
            once that is spent, until it resets. The MCP server has its own,{' '}
            {dollars(MCP_HOURLY_BUDGET_USD)} per hour and{' '}
            {dollars(MCP_DAILY_BUDGET_USD)} per UTC day, and refuses new reviews
            once it is spent. Each budget is a running total of what the models
            cost, and holds nothing about who asked.
          </p>
        </Section>

        <Section id="how-long" title="How long anything is kept">
          <p>
            Each browser tab holds one agent session. The page clears that
            session&rsquo;s history before every turn, so the only code it holds
            is the code being judged right now. Closing the tab retires the
            session, and a session left alone expires after an hour.
          </p>
          <p>
            Answers are cached for one hour, keyed by a hash of exactly what was
            judged, so that judging the same file twice costs one evaluation
            rather than two. That cache holds the code that was judged and the
            answers that came back, it is per deployment region, and it expires
            on its own. It is keyed by the content and by nothing about you. A
            review that arrives from it is the one marked &quot;from
            cache&quot;.
          </p>
        </Section>

        <Section id="pull-requests" title="Pull requests">
          <p>
            Public repositories only. The server fetches the pull request from
            GitHub with no credentials of yours and none are ever asked for. The
            deployment may hold a GitHub token of its own, which raises this
            site&rsquo;s rate limit with GitHub and grants no access a
            signed-out visitor would not have.
          </p>
          <p>
            Fetching is rate limited per network address: {REQUESTS_PER_WINDOW}{' '}
            pull requests per {WINDOW_MINUTES} minutes. That address is the one
            thing about a visitor this site holds at all. It is held in one
            server instance&rsquo;s memory, for that window, to decide whether
            to fetch again, and it is never written anywhere else.
          </p>
        </Section>

        <Section id="not-here" title="What is not here">
          <p>
            No sign-in and no profile. No database. No cookies and no local
            storage beyond the light or dark setting this page remembers for
            you. No advertising, no third-party analytics and no tracking
            pixels. Nothing is sold, because there is nothing collected to sell.
          </p>
          <p>
            The whole application is open source, so none of the above has to be
            taken on trust.{' '}
            <a
              className="underline hover:text-ink"
              href={SITE.source}
              rel="noreferrer"
              target="_blank"
            >
              Read the code
            </a>
            .
          </p>
        </Section>
      </main>
    </div>
  );
}
