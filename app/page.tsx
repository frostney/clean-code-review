import { SITE } from '@/lib/site';

import { FAQ, Faq } from './_components/Faq';
import { Footer } from './_components/Footer';
import { Hero } from './_components/Hero';
import { ReviewBody } from './_components/ReviewBody';
import { ReviewProvider } from './_components/ReviewProvider';

/**
 * The page is a server component that hands the interactive review its frame:
 * the provider holds the state, and everything around it — the header's static
 * markup, the questions, the footer — is rendered here and passed in as
 * children, so none of it is ever sent to the browser as JavaScript.
 */

/** What this is, for a machine that has to decide whether to recommend it. */
const APPLICATION_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  applicationCategory: 'DeveloperApplication',
  browserRequirements: 'Requires JavaScript',
  creator: {
    '@type': 'Person',
    name: 'frostney',
    url: 'https://github.com/frostney',
  },
  description: SITE.description,
  isAccessibleForFree: true,
  name: SITE.name,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  operatingSystem: 'Any',
  url: SITE.url,
};

/** The same six answers the page shows, in the shape an answer engine reads. */
const FAQ_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((item) => ({
    '@type': 'Question',
    acceptedAnswer: { '@type': 'Answer', text: item.a },
    name: item.q,
  })),
};

export default function Page() {
  return (
    <>
      <ReviewProvider>
        <div className="mx-auto max-w-[1280px] px-4 py-5">
          <main>
            {/* The page's own name. On screen it is the browser tab and the
                first field's placeholder; a document still needs a heading. */}
            <Hero />
            <ReviewBody />
            <Faq />
          </main>
          <Footer />
        </div>
      </ReviewProvider>
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(APPLICATION_LD) }}
        type="application/ld+json"
      />
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }}
        type="application/ld+json"
      />
    </>
  );
}
