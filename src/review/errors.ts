/**
 * `retry` is whether Retry can help: a failed turn forgot what it sent, so
 * asking again is what an edit would do, but a file Jev declined twice will
 * not be answered a third time.
 */
export interface TurnTrouble {
  sentence: string;
  tone: 'error' | 'warn';
  retry: boolean;
}

const NETWORK =
  /failed to fetch|networkerror|load failed|fetch failed|network/i;
const HTTP_STATUS = /^HTTP (\d{3})$/;
const UNJUDGED = /^(\d+) files? came back unjudged$/;
const TOO_MANY_REQUESTS = 429;

export function describeTurnError(message: string): TurnTrouble {
  const unjudged = UNJUDGED.exec(message);
  if (unjudged) {
    const one = unjudged[1] === '1';
    return {
      retry: false,
      sentence: `Jev sent no answer for ${one ? 'one file' : `${unjudged[1]} files`}.`,
      tone: 'warn',
    };
  }
  if (message === 'the reply was not a review') {
    return {
      retry: false,
      sentence: "Jev's reply could not be read as a review.",
      tone: 'warn',
    };
  }
  if (message === 'could not cancel the previous review') {
    return {
      retry: false,
      sentence: 'The previous review could not be stopped.',
      tone: 'warn',
    };
  }
  if (message === 'the agent could not answer') {
    return {
      retry: true,
      sentence: 'The reviewer could not answer this time.',
      tone: 'error',
    };
  }
  const status = HTTP_STATUS.exec(message);
  if (status) {
    return {
      retry: true,
      sentence:
        Number(status[1]) === TOO_MANY_REQUESTS
          ? 'The reviewer is busy. Try again in a moment.'
          : 'The reviewer answered with an error.',
      tone: 'error',
    };
  }
  if (NETWORK.test(message)) {
    return {
      retry: true,
      sentence:
        'Could not reach the reviewer. Check your connection and try again.',
      tone: 'error',
    };
  }
  return {
    retry: true,
    sentence: 'Judging stopped before it finished.',
    tone: 'error',
  };
}

/** For the quiet "No review:" line: lower case, no advice. */
export function plainReason(message: string): string {
  if (NETWORK.test(message)) {
    return 'the reviewer could not be reached';
  }
  if (HTTP_STATUS.test(message)) {
    return 'the reviewer answered with an error';
  }
  return message;
}
