import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

/**
 * The link preview, drawn from the page's own palette: white paper, one ink,
 * one muted grey and the accent blue, the same four colours the review uses.
 * No screenshot — a card of meters at 1200×630 is unreadable, and the claim is
 * what the product is, not what it looks like.
 */
export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#1f2328";
const MUTED = "#656d76";
const ACCENT = "#0969da";
const LINE = "#d0d7de";

export default async function Image() {
  // The mascot, inlined: file-based metadata routes cannot reference /public by URL at build time.
  const duck = await readFile(join(process.cwd(), "public", "icons", "icon-512.png"));
  const duckSrc = `data:image/png;base64,${duck.toString("base64")}`;
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#ffffff",
        padding: "72px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <div style={{ width: "14px", height: "14px", borderRadius: "9999px", background: ACCENT }} />
        <div style={{ display: "flex", fontSize: "24px", color: MUTED, letterSpacing: "0.14em" }}>
          CODE REVIEW, BY THE BOOK
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "48px" }}>
        <div style={{ display: "flex", flexDirection: "column", maxWidth: "760px" }}>
          <div style={{ display: "flex", fontSize: "88px", fontWeight: 700, color: INK, letterSpacing: "-0.03em" }}>
            {SITE.name}
          </div>
          <div style={{ display: "flex", width: "120px", height: "6px", background: ACCENT, margin: "28px 0" }} />
          <div style={{ display: "flex", fontSize: "32px", color: MUTED, lineHeight: 1.35 }}>
            {SITE.tagline}
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain img */}
        <img src={duckSrc} width={300} height={300} alt="" style={{ width: "300px", height: "300px" }} />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${LINE}`,
          paddingTop: "22px",
        }}
      >
        <div style={{ display: "flex", fontSize: "24px", color: MUTED, letterSpacing: "0.06em" }}>Jev · Luna · eve</div>
        <div style={{ display: "flex", fontSize: "24px", color: MUTED }}>clean-code-review.vercel.app</div>
      </div>
    </div>,
    { ...size },
  );
}
