import { SITE } from '@/lib/site';

import { FAQ } from './_components/Faq';
import { Shell } from './_components/Shell';

/**
 * The front door: the page with nothing open. What it looks like and what it
 * is made of are `Shell`'s, because the permalink route renders the very same
 * tree with a pull request in it; what is only ever true here is the
 * structured data below, which describes this URL and no other.
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
      <Shell />
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
