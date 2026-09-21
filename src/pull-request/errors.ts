/**
 * Matches the wording of messages from `agent/lib/github/github.ts`,
 * `./pull-request.tsx` and `ReviewProvider` rather than importing them, so none
 * of those reaches the landing bundle.
 */
export interface PullRequestTrouble {
  /** ASCII only (the pixel face is Latin-only), under ~60 characters. */
  duckLine: string;
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
      duckLine: 'That is not a pull request address.',
      retry: false,
      sentence: message,
    };
  }
  if (message.startsWith('Pull request not found')) {
    return {
      duckLine: 'Pull request not found. Public repos only, please.',
      retry: false,
      sentence: message,
    };
  }
  if (message.startsWith('GitHub rate limit')) {
    return {
      duckLine: 'GitHub needs a breather. Try again in a few minutes.',
      retry: false,
      sentence: message,
    };
  }
  if (message.startsWith('Too many pull requests')) {
    return {
      duckLine: 'That was a lot of pull requests. Try again in a few minutes.',
      retry: false,
      sentence: message,
    };
  }
  if (message.includes('too large')) {
    return {
      duckLine: 'That diff is too big for me to judge.',
      retry: false,
      sentence: message,
    };
  }
  if (message.includes('no code files')) {
    return {
      duckLine: 'That pull request has no code for me to judge.',
      retry: false,
      sentence: message,
    };
  }
  const status = GITHUB_STATUS.exec(message);

  if (status) {
    const retry = Number(status[1]) >= FIRST_SERVER_ERROR;

    return retry
      ? {
          duckLine: 'GitHub did not answer. Try again?',
          retry,
          sentence: 'GitHub did not answer for that pull request. Try again.',
        }
      : {
          duckLine: 'GitHub would not hand that pull request over.',
          retry,
          sentence: message,
        };
  }
  if (NETWORK.test(message)) {
    return {
      duckLine: 'I could not reach the server. Try again?',
      retry: true,
      sentence:
        'Could not reach the server. Check your connection and try again.',
    };
  }

  return {
    duckLine: 'That pull request did not open. Try again?',
    retry: true,
    sentence: 'That pull request did not open. Try again.',
  };
}
