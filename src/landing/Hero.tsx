import Image from 'next/image';

import { PRESETS } from '@/examples/presets';
import { PullRequestField } from '@/src/pull-request/PullRequestField';
import { PullRequestSummary } from '@/src/pull-request/PullRequestSummary';
import { ReviewStats } from '@/src/review/ReviewStats';
import { SITE } from '@/src/site/site';
import { LANDING_HEADER } from '@/src/ui/view-transition-names';

import { HomeDuck, LandingDuck } from './Duck';
import { PasteButton } from './PasteButton';
import { PresetChip } from './PresetChip';
import { RecentPullRequests } from './RecentPullRequests';
import {
  TutorialBubble,
  TutorialDuck,
  TutorialDuckPicture,
  TutorialProvider,
  TutorialSpotlight,
} from './Tutorial';

/**
 * Keyed on the home duck's presence (it renders exactly when the page has taken
 * the review's shape) so this header stays a server component and a permalink's
 * first paint already has the code view's width.
 */
const COLUMN =
  'lg:mx-auto lg:w-1/2 lg:group-has-[[data-duck=home]]/hero:mx-0 lg:group-has-[[data-duck=home]]/hero:w-4/5';

/**
 * No visible title: the duck introduces the page; the name is an sr-only h1.
 * The tutorial provider wraps both the duck and the examples its last line
 * points at.
 */
export function Hero() {
  return (
    /* Named, so the box travels to its own narrower shape when a review opens
       (the two snapshots crossfade at the size each was taken, see
       `globals.css`) and fades rather than vanishing when a prose page
       replaces it. Not the name `PageHeader` uses: see
       `view-transition-names`. */
    <header className="group/hero mb-4" style={LANDING_HEADER}>
      <h1 className="sr-only">{SITE.name}</h1>
      <TutorialProvider>
        {/* Centred above the field: at 375px there is no room beside it. The
            box is 176/248px because this artwork has more padding in its
            canvas than the still. */}
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
        {/* Hidden by the same server-rendered switch as the width, so a
            permalink paints without them rather than losing them a frame
            later, and a press for a review loses them with the press. */}
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

          {/* The room, held before the list exists: the list is fetched by the
              browser and lands after first paint, so without this the arrival
              would move everything below it. A chip is 36px, 26.5px from `lg`,
              and its focus ring reaches 4px past that on each side; the extra
              few pixels are slack, because the chip's type is set in px and a
              reader's minimum font size can grow it while this box cannot.
              With no list, this is blank space above the footer. */}
          <div className="mt-1.5 h-12 lg:h-10">
            <RecentPullRequests>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted">
                Open right now:
              </span>
            </RecentPullRequests>
          </div>
        </div>
      </TutorialProvider>

      <div className="lg:w-4/5">
        <PullRequestSummary />
        <ReviewStats />
      </div>
    </header>
  );
}
