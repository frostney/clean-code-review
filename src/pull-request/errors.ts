/**
 * Why a pull request did not open, said twice: once in the duck's voice for
 * the landing view, and once as a plain sentence for the code view's toast.
 *
 * The duck's line is set in a pixel face that carries Latin and nothing more,
 * so it is plain ASCII, and it stays under about sixty characters, the most a
 * pixel line reads well at. `retry` is whether asking again could change the
 * answer: a network hiccup or GitHub having a bad minute can, a private
 * repository or a docs-only change cannot.
 *
 * The messages matched here are the ones `agent/lib/github/github.ts`,
 * `src/pull-request/pull-request.tsx` and `ReviewProvider` write, matched on
 * their wording rather than imported, so none of those modules reaches the
 * landing bundle for a sentence.
 */
export interface PullRequestTrouble {
  /** The duck's line: ASCII, short. */
  duck: string;
  /** The code view's sentence. */
  sentence: string;
  retry: boolean;
}

/** The browser's own ways of saying a request never reached the server. */
const NETWORK =
  /failed to fetch|networkerror|load failed|fetch failed|network|unexpected response/i;

/** `GitHub returned 502 for the diff.` */
const GITHUB_STATUS = /^GitHub returned (\d{3})/;

const FIRST_SERVER_ERROR = 500;

export function describePullRequestError(message: string): PullRequestTrouble {
  if (message.startsWith('That is not a GitHub pull request URL')) {
    return {
      duck: 'That is not a pull request address.',
      retry: false,
      sentence: message,
    };
  }
  if (message.startsWith('Pull request not found')) {
    return {
      duck: 'Pull request not found. Public repos only, please.',
      retry: false,
      sentence: message,
    };
  }
  if (message.startsWith('GitHub rate limit')) {
    return {
      duck: 'GitHub needs a breather. Try again in a few minutes.',
      retry: false,
      sentence: message,
    };
  }
  if (message.startsWith('Too many pull requests')) {
    return {
      duck: 'That was a lot of pull requests. Try again in a few minutes.',
      retry: false,
      sentence: message,
    };
  }
  if (message.includes('too large')) {
    return {
      duck: 'That diff is too big for me to judge.',
      retry: false,
      sentence: message,
    };
  }
  if (message.includes('no code files')) {
    return {
      duck: 'That pull request has no code for me to judge.',
      retry: false,
      sentence: message,
    };
  }
  const status = GITHUB_STATUS.exec(message);
  if (status) {
    const retry = Number(status[1]) >= FIRST_SERVER_ERROR;
    return retry
      ? {
          duck: 'GitHub did not answer. Try again?',
          retry,
          sentence: 'GitHub did not answer for that pull request. Try again.',
        }
      : {
          duck: 'GitHub would not hand that pull request over.',
          retry,
          sentence: message,
        };
  }
  if (NETWORK.test(message)) {
    return {
      duck: 'I could not reach the server. Try again?',
      retry: true,
      sentence:
        'Could not reach the server. Check your connection and try again.',
    };
  }
  return {
    duck: 'That pull request did not open. Try again?',
    retry: true,
    sentence: 'That pull request did not open. Try again.',
  };
}
