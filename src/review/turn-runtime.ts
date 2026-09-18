import { Client, ClientError } from 'eve/client';

import { parseReview } from '@/agent/lib/judging/schema';

/**
 * Everything a review needs on the wire and nothing a page needs to paint:
 * eve's client, and the parser that reads what Jev sent back.
 *
 * Both carry a full copy of zod, locales and all — eve's precompiled one and
 * the app's own — which is most of a megabyte of JavaScript. The landing page,
 * the questions and the privacy notice never start a review, so this module
 * is only ever reached through `import()` in `useReview`, when one does.
 */
export const turnRuntime = { Client, ClientError, parseReview };
