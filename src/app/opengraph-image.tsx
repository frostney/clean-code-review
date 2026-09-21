import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';

import { OG_CARD } from '@/src/site/og';
import { SITE } from '@/src/site/site';

// Light-theme token values as literals: Satori cannot read CSS variables. No
// screenshot: a card of meters at 1200x630 is unreadable.
export const alt = OG_CARD.alt;
export const size = OG_CARD.size;
export const contentType = OG_CARD.contentType;

const INK = '#1f2328';
const MUTED = '#656d76';
const ACCENT = '#0969da';
const LINE = '#d0d7de';

export default async function Image() {
  // Inlined: metadata routes cannot reference /public by URL at build time.
  const duck = await readFile(
    join(process.cwd(), 'public', 'icons', 'icon-512.png'),
  );
  const duckSrc = `data:image/png;base64,${duck.toString('base64')}`;

  return new ImageResponse(
    <div
      style={{
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        justifyContent: 'space-between',
        padding: '72px',
        width: '100%',
      }}
    >
      <div style={{ alignItems: 'center', display: 'flex', gap: '14px' }}>
        <div
          style={{
            background: ACCENT,
            borderRadius: '9999px',
            height: '14px',
            width: '14px',
          }}
        />
        <div
          style={{
            color: MUTED,
            display: 'flex',
            fontSize: '24px',
            letterSpacing: '0.14em',
          }}
        >
          CODE REVIEW, BY THE BOOK
        </div>
      </div>

      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          gap: '48px',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxWidth: '760px',
          }}
        >
          <div
            style={{
              color: INK,
              display: 'flex',
              fontSize: '88px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
            }}
          >
            {SITE.name}
          </div>
          <div
            style={{
              background: ACCENT,
              display: 'flex',
              height: '6px',
              margin: '28px 0',
              width: '120px',
            }}
          />
          <div
            style={{
              color: MUTED,
              display: 'flex',
              fontSize: '32px',
              lineHeight: 1.35,
            }}
          >
            {SITE.tagline}
          </div>
        </div>
        {/* biome-ignore lint/performance/noImgElement: Satori renders plain <img> only */}
        <img
          alt=""
          height={300}
          src={duckSrc}
          style={{ height: '300px', width: '300px' }}
          width={300}
        />
      </div>

      <div
        style={{
          alignItems: 'center',
          borderTop: `1px solid ${LINE}`,
          display: 'flex',
          justifyContent: 'space-between',
          paddingTop: '22px',
        }}
      >
        <div
          style={{
            color: MUTED,
            display: 'flex',
            fontSize: '24px',
            letterSpacing: '0.06em',
          }}
        >
          Jev · Luna · eve
        </div>
        <div style={{ color: MUTED, display: 'flex', fontSize: '24px' }}>
          clean-code-review.vercel.app
        </div>
      </div>
    </div>,
    { ...size },
  );
}
