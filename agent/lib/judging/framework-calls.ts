import type {
  LanguageModelV4Message,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';

/**
 * eve sends model calls of its own through `jev()`. The `kind` eve tags its
 * messages with is dropped before the prompt reaches a provider, so these are
 * recognised by eve's wording; `framework-calls.test.ts` reads that wording
 * from the installed eve, so an upgrade that changes it fails the tests.
 */
const COMPACTION_OPENER = 'You are performing a CONTEXT CHECKPOINT COMPACTION.';
const EMPTY_REPLY_NUDGE_OPENER =
  'Your previous reply was empty and was not delivered.';

/**
 * eve keeps the turn's user message beside the checkpoint when it was sent as
 * a string, as the page sends it, and `jev()` reads only that message. One
 * sent as parts is folded into the checkpoint; eve then sends its resumption
 * message instead, which `jev()` acks without spending.
 */
export const COMPACTION_CHECKPOINT =
  'Nothing to carry over: every turn of this agent is self-contained. Its user message holds all the files and judgments the turn needs, and no turn reads an earlier one.';

/** Only a summarize turn can come back empty; retrying would pay Luna again. */
export const EMPTY_REVIEW_REPLY =
  'The reviewer returned no text for this review.';

function textOf(message: LanguageModelV4Message | undefined): string {
  if (message === undefined) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
}

/**
 * The reply to one of eve's own calls, or null for a real turn. A caller
 * cannot write a system message, so the compaction test cannot be forged.
 */
export function frameworkReply(prompt: LanguageModelV4Prompt): string | null {
  const compacting = prompt.some(
    (m) =>
      m.role === 'system' &&
      textOf(m).trimStart().startsWith(COMPACTION_OPENER),
  );

  if (compacting) {
    return COMPACTION_CHECKPOINT;
  }
  const last = prompt.at(-1);

  if (
    last?.role === 'user' &&
    textOf(last).trimStart().startsWith(EMPTY_REPLY_NUDGE_OPENER)
  ) {
    return EMPTY_REVIEW_REPLY;
  }

  return null;
}
