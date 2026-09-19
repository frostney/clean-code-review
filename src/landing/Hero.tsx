import Image from 'next/image';

import { PRESETS } from '@/examples/presets';
import { PullRequestField } from '@/src/pull-request/PullRequestField';
import { PullRequestSummary } from '@/src/pull-request/PullRequestSummary';
import { ReviewStats } from '@/src/review/ReviewStats';
import { SITE } from '@/src/site/site';

import { HomeDuck, LandingDuck } from './Duck';
import { PasteButton } from './PasteButton';
import { PresetChip } from './PresetChip';
import {
  TutorialBubble,
  TutorialDuck,
  TutorialDuckPicture,
  TutorialProvider,
  TutorialSpotlight,
} from './Tutorial';

/**
 * The width of the field, the hint and the examples from `lg` up.
 *
 * Below `lg` the address takes the whole line and nothing here applies. Above
 * it, a field as wide as the page is mostly empty box: on the landing view it
 * is half the content width and centred, so the duck, the field and the
 * examples read as one column; once a review is open it is four fifths and
 * left-aligned, under the small duck and over the review it names.
 *
 * Which view is on screen is `useReviewView().open`, and the one place that is
 * already written into the markup is the home duck, which renders exactly when
 * a review is open. Keying the width on its presence keeps this whole header
 * on the server — no client wrapper, no effect — and a permalink's
 * server-rendered HTML already carries the home duck, so its first paint is
 * the code view's width rather than a jump from the landing one.
 */
const COLUMN =
  'lg:mx-auto lg:w-1/2 lg:group-has-[[data-duck=home]]/hero:mx-0 lg:group-has-[[data-duck=home]]/hero:w-4/5';

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
 * this is faster than four words do — large above the field while nothing is
 * open, and shrunk to a mark at the left of it once something is. The name is
 * carried by a heading only a crawler and a screen reader ever meet.
 *
 * What the duck says is the other half of that introduction, and it spans the
 * duck and the examples it ends by pointing at, which is why the greeting's
 * state is provided around both of them here rather than inside either.
 *
 * Everything here that is the same on every visit is rendered on the server:
 * the duck, the line the chips sit on, the labels in them, the hint under the
 * field. The browser gets the three small pieces that answer a click and the
 * two that change when an answer arrives.
 */
export function Hero() {
  return (
    <header className="group/hero mb-4">
      <h1 className="sr-only">{SITE.name}</h1>
      <TutorialProvider>
        {/* The landing view's duck: above the field and centred rather than
            beside it, because at 375px there is no "beside" — the address needs
            the whole line — and a mascot on the centre line is what a door looks
            like at any width. It is gone the moment a review opens, and the one
            in the field is the same bird arriving.
            It winks while it talks and taps its feet once it is waiting for a
            pick, which is the greeting's business, so the artwork lives with
            the greeting. The box is larger than the still duck's was because
            this artwork carries more padding inside its canvas: at 176 and 248
            the bird itself measures what it measured at 160 and 224. */}
        <LandingDuck aside={<TutorialBubble />}>
          <TutorialDuck>
            <TutorialDuckPicture />
          </TutorialDuck>
        </LandingDuck>
        <div className={`min-w-0 ${COLUMN}`}>
          <PullRequestField
            duck={
              <HomeDuck>
                <Image
                  alt=""
                  className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
                  height={32}
                  priority={true}
                  src="/ducky-64.png"
                  width={32}
                />
              </HomeDuck>
            }
          />
        </div>
        {/* The ways in besides the field have no job once a review is open,
            and on a phone they are most of the first screen above it. Hidden
            by the same server-rendered switch as the width, so a permalink
            paints without them rather than losing them a frame later. */}
        <div className={`${COLUMN} group-has-[[data-duck=home]]/hero:hidden`}>
          <p className="mt-1.5 text-xs text-muted">
            Public repositories only. The code is judged file by file against
            Clean Code, then reviewed.
          </p>

          <TutorialSpotlight>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">
                Or choose one of the examples:
              </span>
              {PRESETS.map((preset) => (
                <PresetChip
                  blurb={preset.blurb}
                  key={preset.label}
                  label={preset.label}
                />
              ))}
              <PasteButton />
            </div>
          </TutorialSpotlight>
        </div>
      </TutorialProvider>

      <div className="lg:w-4/5">
        <PullRequestSummary />
        <ReviewStats />
      </div>
    </header>
  );
}
