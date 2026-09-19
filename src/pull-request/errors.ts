/**
 * Matches the wording of messages from `agent/lib/github/github.ts`,
 * `./pull-request.tsx` and `ReviewProvider` rather than importing them, so none
 * of those reaches the landing bundle.
 */
export interface PullRequestTrouble {
  /** ASCII only (the pixel face is Latin-only), under ~60 characters. */
  duck: string;
  sentence: string;
  /** Whether asking again could change the answer. */
  retry: boolean;
}

/** Browsers word a failed fetch differently. */
const NETWORK =
  /failed to fetch|networkerror|load failed|fetch failed|network|unexpected response/i;

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
