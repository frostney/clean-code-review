import { Client, ClientError } from 'eve/client';

import { parseReview } from '@/agent/lib/judging/schema';

/**
 * Only reached through `import()` in `useReview`: each of these carries its
 * own copy of zod, together most of a megabyte, and most pages never start a
 * review.
 */
export const turnRuntime = { Client, ClientError, parseReview };
