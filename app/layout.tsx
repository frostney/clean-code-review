import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { Measurement } from '@/src/site/Measurement';
import { SITE } from '@/src/site/site';
import { ThemeToggle } from '@/src/theme/ThemeToggle';
import { THEME_SCRIPT } from '@/src/theme/theme';
import { NavigationDirection } from '@/src/ui/NavigationDirection';
import './globals.css';

const sans = Geist({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-sans',
  weight: 'variable',
});

const mono = Geist_Mono({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-mono',
  weight: 'variable',
});

// `metadataBase` makes every relative URL absolute, the OG image's included.
// The browser chrome follows the page, which is the one visible difference a
// phone shows between the two themes.
export const viewport: Viewport = {
  themeColor: [
    { color: '#0d1117', media: '(prefers-color-scheme: dark)' },
    { color: '#ffffff', media: '(prefers-color-scheme: light)' },
  ],
};

export const metadata: Metadata = {
  alternates: { canonical: '/' },
  applicationName: SITE.name,
  authors: [{ name: 'frostney', url: 'https://github.com/frostney' }],
  category: 'developer tools',
  creator: 'frostney',
  description: SITE.description,
  keywords: [
    'clean code',
    'code review',
    'pull request review',
    'AI code review',
    'code smells',
    'Clean Code checklist',
    'GitHub pull request',
    'diff review',
    'Jev',
    'TypeSafe',
    'eve agent',
  ],
  metadataBase: new URL(SITE.url),
  openGraph: {
    description: SITE.description,
    locale: 'en_US',
    siteName: SITE.name,
    title: SITE.name,
    type: 'website',
    url: SITE.url,
  },
  robots: { follow: true, index: true },
  title: {
    default: SITE.name,
    template: `%s · ${SITE.name}`,
  },
  twitter: {
    card: 'summary_large_image',
    description: SITE.description,
    title: SITE.name,
  },
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html
      className={`${sans.variable} ${mono.variable}`}
      lang="en"
      suppressHydrationWarning={true}
    >
      <body className="font-sans antialiased">
        {/* First in the body so `data-theme` is set before the first paint. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: an inline script is the only thing that runs before paint, and every byte of it is written in src/theme/theme.ts
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
        {/* Draws nothing: it names which way a navigation is travelling, for
            the view transition in `globals.css`. */}
        <NavigationDirection />
        {/* Overlaid rather than given a row: the corner is empty on every page
            except the code view below `lg`, where `Shell` makes room. First in
            the DOM so it is the first Tab stop, matching its position. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
          <div className="mx-auto flex max-w-[1280px] justify-end px-4 lg:pt-5">
            <div className="-mr-3 pointer-events-auto flex h-10 items-center lg:-mr-2.5 lg:h-9">
              <ThemeToggle />
            </div>
          </div>
        </div>
        {children}
        {/* What these send is documented on /privacy. */}
        <Measurement />
      </body>
    </html>
  );
}
