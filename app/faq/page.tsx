import type { Metadata } from 'next';

import { Faq } from '@/src/site/Faq';
import { FAQ } from '@/src/site/faq-content';
import { OG_IMAGE, TWITTER_IMAGE } from '@/src/site/og';
import { SITE } from '@/src/site/site';
import { Footer } from '@/src/ui/Footer';
import { PageHeader } from '@/src/ui/PageHeader';

// Not wrapped in `Shell`: an address field on a page of prose would invite a
// paste into a page that cannot open a review.

const TITLE = 'Questions about this page';
const DESCRIPTION = `What ${SITE.name} judges, which models do the work, what happens to your code and what it costs.`;

/**
 * A page's own `openGraph` replaces the layout's block, the file-convention
 * card included, so the card is named again here. Indexed, unlike permalinks.
 */
export const metadata: Metadata = {
  alternates: { canonical: '/faq' },
  description: DESCRIPTION,
  openGraph: {
    description: DESCRIPTION,
    images: [OG_IMAGE],
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
    images: [TWITTER_IMAGE],
    title: TITLE,
  },
};

/** Emitted on this URL only. */
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

export default function FaqPage() {
  return (
    <>
      <div className="mx-auto max-w-[1280px] px-4 py-5">
        {/* Centred as one column, header and questions together, so the page
            sits where the landing column does. The text inside stays ranged
            left. */}
        <main className="mx-auto max-w-[70ch]">
          <PageHeader title={TITLE}>
            <p>{SITE.tagline}</p>
          </PageHeader>
          <Faq />
        </main>
        <Footer current="faq" />
      </div>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a serialised object is the only way to emit structured data, and every byte of this one is written a few lines above in this same file.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
        type="application/ld+json"
      />
    </>
  );
}
