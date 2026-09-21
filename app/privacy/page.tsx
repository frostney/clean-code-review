import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import {
  SESSION_WINDOW_MS,
  SESSIONS_PER_WINDOW,
} from '@/agent/lib/infra/session-facts';
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
} from '@/src/mcp/mcp-facts';
import {
  GITHUB_FETCH_WINDOW_MS,
  GITHUB_FETCHES_PER_WINDOW,
} from '@/src/pull-request/throttle';
import { SITE } from '@/src/site/site';
import { Footer } from '@/src/ui/Footer';
import { PageHeader } from '@/src/ui/PageHeader';

// Every claim must be checkable against this repository and every figure
// imported from the module that enforces it; the Vercel sections follow
// Vercel's linked documentation.

const MS_PER_MINUTE = 60_000;
const WINDOW_MINUTES = Math.round(GITHUB_FETCH_WINDOW_MS / MS_PER_MINUTE);
const SESSION_WINDOW_MINUTES = Math.round(SESSION_WINDOW_MS / MS_PER_MINUTE);

const WEB_ANALYTICS_PRIVACY =
  'https://vercel.com/docs/analytics/privacy-policy';

const SPEED_INSIGHTS_PRIVACY =
  'https://vercel.com/docs/speed-insights/privacy-policy';

export const metadata: Metadata = {
  alternates: { canonical: '/privacy' },
  description:
    'Nothing here identifies you. What leaves the browser when you paste code, who processes it, how long anything is kept, and what Vercel measures.',
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

const CELL = 'border-b border-line py-2 pr-3 align-top';

function Row({
  children,
  header,
}: {
  readonly children: ReactNode;
  readonly header: string;
}) {
  return (
    <tr>
      <th className={`${CELL} font-semibold text-muted`} scope="row">
        {header}
      </th>
      {children}
    </tr>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5">
      <main className="mx-auto max-w-[72ch]">
        <PageHeader title="Privacy">
          <p>
            Nothing here identifies you. There is no account, no database and no
            cookie: there is a browser tab and the session it holds open.
            Nothing you paste is written down anywhere this site keeps.
          </p>
        </PageHeader>

        <Section id="your-code" title="Your code">
          <p>
            The code you paste reaches this site's server as one agent turn. So
            does the diff fetched for a pull request you name. The server sends
            each file through the Vercel AI Gateway to Jev, TypeSafe's
            evaluation model, to be answered against up to {QUESTION_COUNT}{' '}
            questions. Jev's findings and that file's text then go to Luna (
            {REVIEWER_MODEL}) through the same gateway, to be written up as the
            review you read.
          </p>
          <p>
            That is the whole path: the gateway and the two model providers
            behind it, and nothing else. One turn sends at most{' '}
            {REVIEW_LIMITS.maxFiles} code files, each cut to{' '}
            {REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters.
            Up to {REVIEW_LIMITS.maxProseFiles} prose files are shown beside
            them and never sent.
          </p>
        </Section>

        <Section id="pull-requests" title="Pull requests">
          <p>
            Public repositories only. The server fetches the pull request from
            GitHub with none of your credentials, and none are ever asked for.
            This deployment sets no GitHub token either, so the fetch is
            anonymous at both ends. A deployment can set one to raise its own
            rate limit with GitHub; it would grant no access a signed-out
            visitor lacks.
          </p>
          <p>
            Fetching is rate limited by network address:{' '}
            {GITHUB_FETCHES_PER_WINDOW} pull requests per {WINDOW_MINUTES}{' '}
            minutes. Opening a session is limited separately,{' '}
            {SESSIONS_PER_WINDOW} per {SESSION_WINDOW_MINUTES} minutes. That
            address is the one thing about a visitor this site's own server
            holds. Each counter keeps it in one server instance's memory for the
            length of its window and writes it nowhere else.
          </p>
        </Section>

        <Section id="addresses" title="How an address is counted">
          <p>
            The pull request and MCP limits share one counter, so both count an
            IPv6 address by its /64: one host is handed a whole /64 and can move
            within it. Both put a request that arrives with no address into one
            shared bucket rather than letting it pass unseen.
          </p>
          <p>
            The session limit is separate. It counts the address as given, so a
            host moving within its own /64 gets {SESSIONS_PER_WINDOW} sessions
            per address it uses, and a request with no address is not counted at
            all.
          </p>
        </Section>

        <Section id="agents" title="Agents">
          <p>
            Code can also arrive from an agent rather than a browser tab,
            through the MCP server at <code>{`${SITE.url}${MCP_PATH}`}</code>.
            It takes the same route to the same two models in one request, with
            no session and no tab, and it keeps what the page keeps and nothing
            more. Each address gets {MCP_CALLS_PER_WINDOW} calls per{' '}
            {MCP_WINDOW_MINUTES} minutes.
          </p>
        </Section>

        <Section id="cost" title="What a review costs">
          <p>
            Every visitor shares one model budget:{' '}
            {dollars(PAGE_HOURLY_BUDGET_USD)} per hour and{' '}
            {dollars(PAGE_DAILY_BUDGET_USD)} per UTC day. Reviews pause once it
            is spent and resume when it resets. The MCP server has its own,{' '}
            {dollars(MCP_HOURLY_BUDGET_USD)} per hour and{' '}
            {dollars(MCP_DAILY_BUDGET_USD)} per UTC day, and refuses new reviews
            once that is spent. Each budget counts what the models cost, never
            who asked.
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
            Judgments and written reviews are cached for an hour, keyed by a
            hash of exactly what was judged, so the same file is evaluated once
            rather than twice. Those two caches hold the answers and the review,
            not the code: the code goes into the key and no further. A fetched
            pull request is cached separately for a minute, keyed by its GitHub
            address. That one does hold the whole thing it fetched — the diff,
            the title, the description, the author's avatar address and the
            number of files changed — all of it public, from a public
            repository. Every cache is per deployment region, or in one server
            instance's memory where there is no regional cache. Each expires on
            its own and is keyed by nothing about you. A review that comes back
            from one is marked &quot;from cache&quot;.
          </p>
        </Section>

        <Section id="measurement" title="What Vercel measures">
          <p>
            This site's own domain serves two scripts from Vercel. Web Analytics
            counts page views. Speed Insights reads the loading and
            responsiveness timings the browser already keeps, the Web Vitals,
            and reports how fast a page was. Neither stores anything in your
            browser. Vercel describes both as anonymous: neither is tied to a
            person or to a network address.
          </p>
          <p>
            This site's own addresses are cleaned before either script sends
            them. The home page, <code>/faq</code> and <code>/privacy</code> go
            as they are. Anything under a repository's <code>/pull</code> goes
            as <code>/[owner]/[repo]/pull/[number]</code>, so the record says a
            review was read and not which one. Anything else is a page that does
            not exist, and goes as <code>/[not-found]</code>. No query and no
            fragment is ever sent.
          </p>
          {/* The wrapper scrolls; the min-width is what gives it something to
              scroll, since prose cells otherwise wrap to any width at all. */}
          <div className="overflow-x-auto">
            <table className="mt-1 w-full min-w-[36rem] border-collapse text-left text-sm leading-relaxed text-ink">
              <caption className="sr-only">
                What each Vercel script sends
              </caption>
              <thead>
                <tr>
                  <th
                    className={`${CELL} font-semibold text-muted`}
                    scope="col"
                  >
                    <span className="sr-only">Detail</span>
                  </th>
                  <th className={`${CELL} font-semibold`} scope="col">
                    Page views
                  </th>
                  <th className={`${CELL} font-semibold`} scope="col">
                    Page speed
                  </th>
                </tr>
              </thead>
              <tbody>
                <Row header="Sent">
                  <td className={CELL}>
                    Each time a page is opened, including a review opened
                    without reloading the page
                  </td>
                  <td className={CELL}>
                    As the page is used and when it is left
                  </td>
                </Row>
                <Row header="Always carries">
                  <td className={CELL}>
                    The cleaned address and route, the browser and its version,
                    the operating system and its version, the device type, the
                    version of the script, the time
                  </td>
                  <td className={CELL}>
                    The cleaned address and route, the timing and its value, the
                    browser and its version, the device type and operating
                    system, the version of the script, the time Vercel received
                    it
                  </td>
                </Row>
                <Row header="Also carries">
                  <td className={CELL}>
                    The address of the page that linked here if it is on another
                    site, as your browser gives it; a location worked out from
                    the request, such as the country, region and city
                  </td>
                  <td className={CELL}>
                    The country; the network speed the browser reports; the page
                    element the timing concerns, and for responsiveness the kind
                    of input, such as a tap or a key press
                  </td>
                </Row>
                <Row header="Never carries">
                  <td className={CELL}>
                    A click, the code you paste, a review
                  </td>
                  <td className={CELL}>
                    The code you paste, the names of the files, a review
                  </td>
                </Row>
                <Row header="Tells visitors apart by">
                  <td className={CELL}>
                    A hash Vercel makes from the incoming request and resets
                    after a day, so a visitor cannot be followed from one day to
                    the next or from this site to another
                  </td>
                  <td className={CELL}>
                    Nothing: no identifier follows one visitor from page to page
                  </td>
                </Row>
                <Row header="Kept by Vercel for">
                  <td className={CELL}>
                    At least the reporting window of this site's plan, one month
                    on the free plan and one or two years on paid ones. Vercel
                    says it may keep them longer
                  </td>
                  <td className={CELL}>
                    Not published. The dashboard this site's owner reads shows
                    the last seven days, or longer on Vercel's paid tier
                  </td>
                </Row>
                <Row header="Vercel's own account">
                  <td className={CELL}>
                    <a
                      className="underline hover:text-ink"
                      href={WEB_ANALYTICS_PRIVACY}
                      rel="noreferrer"
                      target="_blank"
                    >
                      What Web Analytics collects
                    </a>
                  </td>
                  <td className={CELL}>
                    <a
                      className="underline hover:text-ink"
                      href={SPEED_INSIGHTS_PRIVACY}
                      rel="noreferrer"
                      target="_blank"
                    >
                      What Speed Insights collects
                    </a>
                  </td>
                </Row>
              </tbody>
            </table>
          </div>
          <p>
            The element is a short selector of tag names, style class names and
            at most one id, such as <code>main&gt;img</code> or{' '}
            <code>#file-3&gt;div.flex</code>. No id or class here carries a file
            name, a repository or words from a pull request: the file cards are
            numbered, and a pull request description's ids and code-language
            classes are renumbered or dropped.
          </p>
        </Section>

        <Section id="not-here" title="What is not here">
          <p>
            No sign-in and no profile. No database. Nothing in local storage but
            the light or dark setting this page remembers for you. No
            advertising and no tracking pixels. Nothing is sold, because nothing
            is collected to sell.
          </p>
          <p>
            The whole application is open source, so none of this has to be
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
