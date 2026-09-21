/**
 * The names a page's header and title travel under, in one place because the
 * browser drops the whole transition if two elements carry one name at the
 * same moment.
 *
 * The landing header has a name of its own rather than `PAGE_HEADER`: it is
 * the whole hero, several times the size of a prose page's header, and a
 * shared name would make the browser interpolate one box into the other and
 * scale the text inside with it. Unpaired, it fades out and the prose header
 * fades in, while each still morphs against itself when a review opens or
 * closes.
 *
 * `Hero` (the landing view and the code view) and `PageHeader` (`/faq`,
 * `/privacy`) each render one header, and no route renders both, so every
 * name is on one element at a time. The landing view has no visible title, so
 * `PAGE_TITLE` is only ever on a prose page.
 */
export const LANDING_HEADER = {
  viewTransitionName: 'landing-header',
} as const;

export const PAGE_HEADER = { viewTransitionName: 'page-header' } as const;

export const PAGE_TITLE = { viewTransitionName: 'page-title' } as const;
