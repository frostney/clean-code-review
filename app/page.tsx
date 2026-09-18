import { SITE } from '@/src/site/site';
import { Shell } from '@/src/ui/Shell';

/**
 * The front door: the page with nothing open. What it looks like and what it
 * is made of are `Shell`'s, because the permalink route renders the very same
 * tree with a pull request in it; what is only ever true here is the
 * structured data below, which describes this URL and no other.
 *
 * The questions used to be here too, with a `FAQPage` block beside them. They
 * live at `/faq` now, and so does that block: the same answers claimed at two
 * addresses is one of them lying about where to be read.
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

export default function Page() {
  return (
    <>
      <Shell />
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(APPLICATION_LD) }}
        type="application/ld+json"
      />
    </>
  );
}
