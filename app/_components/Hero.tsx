import Image from "next/image";
import { PRESETS } from "@/agent/lib/presets";
import { SITE } from "@/lib/site";
import { PasteButton } from "./PasteButton";
import { PresetChip } from "./PresetChip";
import { PullRequestField } from "./PullRequestField";
import { PullRequestSummary } from "./PullRequestSummary";
import { ReviewStats } from "./ReviewStats";
import { ThemeToggle } from "./ThemeToggle";

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
 * There is no title on screen. A product whose whole surface is one address
 * field does not need to be introduced above it, and the duck says which page
 * this is faster than four words do — so the duck stands at the left of the
 * field, on its line, and the name is carried by a heading only a crawler and
 * a screen reader ever meet.
 *
 * Everything here that is the same on every visit is rendered on the server:
 * the duck, the line the chips sit on, the labels in them, the hint under the
 * field. The browser gets the three small pieces that answer a click and the
 * two that change when an answer arrives.
 */
export function Hero() {
  return (
    <header className="mb-4">
      <h1 className="sr-only">{SITE.name}</h1>
      {/* The theme switch lives up here, in plain sight: beside the field where
          there is room, and at the end of the hint line on phones, where the
          field needs every pixel for the repository name. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <PullRequestField
            duck={
              <Image
                src="/ducky-64.png"
                width={32}
                height={32}
                alt=""
                priority
                className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
              />
            }
          />
        </div>
        <div className="hidden h-11 shrink-0 items-center sm:flex">
          <ThemeToggle />
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="text-tiny text-muted">public repositories only</p>
        <div className="flex sm:hidden">
          <ThemeToggle />
        </div>
      </div>

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
