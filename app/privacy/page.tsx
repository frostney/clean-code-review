import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { QUESTION_COUNT } from '@/agent/lib/judging/questions';
import { REVIEW_LIMITS } from '@/agent/lib/review/review';
import { REVIEWER_MODEL } from '@/agent/lib/review/summary';
import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
} from '@/agent/lib/spend/budgets';
import {
  MCP_CALLS_PER_WINDOW,
  MCP_PATH,
  MCP_WINDOW_MINUTES,
} from '@/src/mcp/mcp-limits';
import { REQUESTS_PER_WINDOW, WINDOW_MS } from '@/src/pull-request/throttle';
import { SITE } from '@/src/site/site';
import { Footer } from '@/src/ui/Footer';
import { PageHeader } from '@/src/ui/PageHeader';

/**
 * What happens to code somebody pastes here, written from the code that does
 * it rather than from a template.
 *
 * Every claim below is one a reader could check against this repository, and
 * every figure is imported from the module that enforces it. There is no
 * consent banner to describe, no cookie and no account, so the page is short:
 * a privacy policy that lists rights against data nobody collects is a worse
 * answer than the true one. Two things are measured, page views by Vercel Web
 * Analytics and page speed by Vercel Speed Insights (both in `Measurement`,
 * from the root layout), and what they send is written from Vercel's own
 * documentation, which is linked, and from the scripts themselves.
 *
 * The footer's link is the way here from every other page.
 */

/** Minutes are how a reader counts a rate-limit window; the brake counts milliseconds. */
const MS_PER_MINUTE = 60_000;
const WINDOW_MINUTES = Math.round(WINDOW_MS / MS_PER_MINUTE);

/** Where Vercel says what Web Analytics collects. */
const WEB_ANALYTICS_PRIVACY =
  'https://vercel.com/docs/analytics/privacy-policy';

/** Where Vercel says what Speed Insights collects. */
const SPEED_INSIGHTS_PRIVACY =
  'https://vercel.com/docs/speed-insights/privacy-policy';

export const metadata: Metadata = {
  alternates: { canonical: '/privacy' },
  description:
    'No account, no database and no cookies. What leaves the browser when you paste code here, who processes it, how long anything is kept, and what the page-view and page-speed measurements send.',
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
        className="mb-1.5 text-xs font-semibold tracking-wider text-muted uppercase"
        id={id}
      >
        {title}
      </h2>
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5">
      <main className="max-w-[72ch]">
        <PageHeader title="Privacy">
          <p>
            There is no account, no database and no cookie on this site. Nothing
            you paste is written down anywhere this site keeps, and nothing is
            tied to you, because there is no you here: there is a browser tab
            and the session it holds open. Two things are measured: how many
            pages are viewed, with Vercel Web Analytics, and how fast they load,
            with Vercel Speed Insights. What each one sends is described below.
          </p>
        </PageHeader>

        <Section id="what-leaves" title="What leaves the browser">
          <p>
            The code you paste, or the diff fetched for the pull request you
            named, is sent to this site's server as the message of one agent
            turn. The server sends each file to Jev, TypeSafe's evaluation
            model, through the Vercel AI Gateway, to be answered against{' '}
            {QUESTION_COUNT} questions. It then sends Jev's findings and that
            file's text to Luna ({REVIEWER_MODEL}), through the same gateway, to
            be written up as the review you read.
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
            server instance's memory for that window.
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
            session's history before every turn, so the only code it holds is
            the code being judged right now. Closing the tab retires the
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
            site's rate limit with GitHub and grants no access a signed-out
            visitor would not have.
          </p>
          <p>
            Fetching is rate limited per network address: {REQUESTS_PER_WINDOW}{' '}
            pull requests per {WINDOW_MINUTES} minutes. That address is the one
            thing about a visitor this site's own server holds at all. It is
            held in one server instance's memory, for that window, to decide
            whether to fetch again, and it is never written anywhere else.
          </p>
        </Section>

        <Section id="page-views" title="Page views">
          <p>
            This site counts page views with Vercel Web Analytics. A small
            script from Vercel, served from this site's own domain, sends a
            record to Vercel each time a page is opened, including a review
            opened without reloading the page. Nothing else is sent: not a
            click, not the code you paste and not a review.
          </p>
          <p>
            Each record carries the address and the route of the page, the
            address of the page that linked here if it is on another site, a
            location worked out from the request (such as the country, region
            and city), the browser and its version, the operating system and its
            version, the device type, the version of the script, and the time.
            The linking page's address is sent as your browser gives it, which
            this site does not change.
          </p>
          <p>
            This site's own addresses are cleaned before they are sent. The home
            page, <code>/faq</code> and <code>/privacy</code> go as they are. A
            review opened from a pull request, and any other address under a
            repository's <code>/pull</code>, goes as{' '}
            <code>/[owner]/[repo]/pull/[number]</code>, so the record says that
            a review was read and not which one. Any other address can only be a
            page that does not exist, and goes as <code>/[not-found]</code>.
            None of them carries its query or fragment.
          </p>
          <p>
            The script sets no cookie and stores nothing in your browser. To
            tell visitors apart, Vercel makes a hash from the incoming request
            instead, and resets it after a day, so a visitor cannot be followed
            from one day to the next or from this site to another. Vercel
            describes the records as anonymous: they are not tied to a person or
            to a network address. Vercel keeps them for at least the reporting
            window of this site's plan, one month on the free plan and one or
            two years on paid ones, and says it may keep them longer.
          </p>
          <p>
            <a
              className="underline hover:text-ink"
              href={WEB_ANALYTICS_PRIVACY}
              rel="noreferrer"
              target="_blank"
            >
              Vercel's own account of what Web Analytics collects
            </a>
            .
          </p>
        </Section>

        <Section id="page-speed" title="How fast the page loads">
          <p>
            This site measures how fast its pages load for the people using
            them, with Vercel Speed Insights. A small script from Vercel, served
            from this site's own domain, reads the loading and responsiveness
            timings the browser already keeps (the Web Vitals) and sends them to
            Vercel as the page is used and when it is left.
          </p>
          <p>
            Each measurement carries the timing and its value, the address and
            the route of the page it was taken on, the page element it concerns,
            the browser and its version, the device type and operating system,
            the network speed the browser reports, the country, the version of
            the Speed Insights script, and the time Vercel received it. The
            address and the route are cleaned the same way as for page views, so
            each is one of the three pages,{' '}
            <code>/[owner]/[repo]/pull/[number]</code> or{' '}
            <code>/[not-found]</code>, with no query or fragment. The
            responsiveness timing also names the kind of input it measured, such
            as a tap or a key press, along with the element.
          </p>
          <p>
            The element is named by a short selector the script builds from tag
            names, style class names and at most one id, such as{' '}
            <code>main&gt;img</code> or <code>#file-3&gt;div.flex</code>. No id
            or class on this site carries a file name, a repository or words
            from a pull request: the file cards are numbered, and the ids and
            code-language classes a pull request's description would bring are
            renumbered or dropped. Code you paste, the names of the files and
            the reviews are never part of a measurement.
          </p>
          <p>
            The script sets no cookie and stores nothing in your browser. Vercel
            describes the measurements as anonymous: they are not tied to a
            visitor or to a network address, and nothing in them would let
            anyone follow one visitor from page to page or say who they are.
            Vercel does not publish how long it keeps them. The dashboard this
            site's owner reads them in shows the last seven days, or longer on
            Vercel's paid tier.
          </p>
          <p>
            <a
              className="underline hover:text-ink"
              href={SPEED_INSIGHTS_PRIVACY}
              rel="noreferrer"
              target="_blank"
            >
              Vercel's own account of what Speed Insights collects
            </a>
            .
          </p>
        </Section>

        <Section id="not-here" title="What is not here">
          <p>
            No sign-in and no profile. No database. No cookies and no local
            storage beyond the light or dark setting this page remembers for
            you. No advertising and no tracking pixels, and nothing that records
            who visits: the page views and page speed above are counted without
            saying who you are. Nothing is sold, because there is nothing
            collected to sell.
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
      <Footer current="privacy" />
    </div>
  );
}
