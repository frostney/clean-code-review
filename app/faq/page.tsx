import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

import { DuckTransition } from '@/src/landing/DuckTransition';
import { FAQ } from '@/src/site/faq';
import { SITE } from '@/src/site/site';
import { Faq } from '@/src/ui/Faq';
import { Footer } from '@/src/ui/Footer';

/**
 * The questions, at an address of their own.
 *
 * They used to sit under the address field on `/`, which made the front page
 * two documents at once: a tool nobody has used yet, and an explanation of it.
 * Here they are the whole page, so a link can point at one and a search result
 * can quote one.
 *
 * The frame is this route's rather than `Shell`'s. `Shell` is the review: the
 * address field, the examples, the provider that holds a review's state. None
 * of that belongs on a page of prose, and dragging the field onto it would
 * invite someone to paste a pull request into a page that cannot open one.
 * What is shared is what should be: the duck, the questions and the footer.
 */

/** The title and the description this route has instead of the site's. */
const TITLE = 'Questions about this page';
const DESCRIPTION = `What ${SITE.name} judges, which models do the work, what happens to your code and what it costs.`;

/**
 * The Open Graph block names this page rather than the site. A route that
 * writes one replaces the layout's whole block, so everything the card needs
 * is written again here, with one exception: `images` stays unset, which is
 * what keeps the picture `app/opengraph-image.tsx` draws. Without this, every
 * share of these answers announced itself as the front page.
 *
 * Unlike a permalinked review, these answers are this site's own to be found
 * by, so this page is indexed.
 */
export const metadata: Metadata = {
  alternates: { canonical: '/faq' },
  description: DESCRIPTION,
  openGraph: {
    description: DESCRIPTION,
    siteName: SITE.name,
    title: TITLE,
    type: 'article',
    url: `${SITE.url}/faq`,
  },
  robots: { follow: true, index: true },
  title: TITLE,
  twitter: {
    card: 'summary_large_image',
    description: DESCRIPTION,
    title: TITLE,
  },
};

/** The five answers, in the shape an answer engine reads. This URL and no other. */
const FAQ_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((item) => ({
    '@type': 'Question',
    acceptedAnswer: { '@type': 'Answer', text: item.a },
    name: item.q,
  })),
  url: `${SITE.url}/faq`,
};

/** The duck, small: the mark at the top of a page with no wordmark, and the way back. */
const DUCK_PX = 40;

export default function FaqPage() {
  return (
    <>
      <div className="mx-auto max-w-[1280px] px-4 py-5">
        <main>
          <header className="mb-4">
            {/* The landing page's duck, arriving: a link here from `/`, or this
                one back to it, morphs one bird into the other. */}
            <DuckTransition>
              <Link
                aria-label={`Back to ${SITE.name}`}
                className="inline-flex rounded-md"
                href="/"
              >
                <Image
                  alt=""
                  height={DUCK_PX}
                  priority={true}
                  src="/ducky-64.png"
                  width={DUCK_PX}
                />
              </Link>
            </DuckTransition>
            <h1 className="mt-3 text-[16px] font-semibold text-ink lg:text-[14px]">
              {TITLE}
            </h1>
            <p className="mt-1 max-w-[70ch] text-[13px] text-muted">
              {SITE.tagline}
            </p>
          </header>
          <Faq />
        </main>
        <Footer />
      </div>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a serialised object is the only way to emit structured data, and every byte of this one is written a few lines above in this same file.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
        type="application/ld+json"
      />
    </>
  );
}
