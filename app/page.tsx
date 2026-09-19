import { SITE } from '@/src/site/site';
import { Shell } from '@/src/ui/Shell';

// The `FAQPage` JSON-LD lives on `/faq` only: the same answers claimed at two
// addresses would contradict where they are to be read.

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
