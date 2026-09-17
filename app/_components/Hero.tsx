import Image from "next/image";
import { PRESETS } from "@/agent/lib/presets";
import { SITE } from "@/lib/site";
import { PasteButton } from "./PasteButton";
import { PresetChip } from "./PresetChip";
import { PullRequestField } from "./PullRequestField";
import { PullRequestSummary } from "./PullRequestSummary";
import { ReviewStats } from "./ReviewStats";

/**
 * The top of a review: what is being reviewed, and how it got here.
 *
 * A pull request is the way in, so it is the first thing on the page: one
 * field with `github.com/` already typed into it. The examples and the paste
 * box sit below as the secondary way in, because choosing what to review is
 * part of the same header, not a sidebar. The conclusion is not here — the
 * verdict, the smell count and the status ride on the overall review card,
 * beside the decision they belong with.
 *
 * Everything here that is the same on every visit is rendered on the server:
 * the line the chips sit on, the labels in them, the hint under the field. The
 * browser gets the three small pieces that answer a click and the two that
 * change when an answer arrives.
 */
export function Hero() {
  return (
    <header className="mb-4">
      {/* The mascot and the name: small, because the page is the field below, not a title. */}
      <h1 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-ink">
        <Image src="/ducky-64.png" width={32} height={32} alt="" priority className="h-8 w-8" />
        {SITE.name}
      </h1>
      <PullRequestField />
      <p className="mt-1.5 text-tiny text-muted">public repositories only</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">Or choose one of the examples:</span>
        {PRESETS.map((preset) => (
          <PresetChip key={preset.label} label={preset.label} blurb={preset.blurb} />
        ))}
        <PasteButton />
      </div>

      <PullRequestSummary />
      <ReviewStats />
    </header>
  );
}
