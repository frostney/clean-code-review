/**
 * One retry for a model call, and how long to wait before it.
 *
 * Every attempt gets its own timeout. What went wrong decides the wait, and
 * the caller's signal decides whether there is a retry at all: our timeout and
 * the caller's cancel both surface as an `AbortError`, so the error's shape
 * cannot tell them apart, but the two signals can.
 */
/** The most a `retry-after` is honoured for: a longer one is a limit that one retry will not outlast. */
const MAX_RETRY_AFTER_MS = 3000;

/** With no `retry-after`, a pause somewhere in here, so parallel calls do not retry in step. */
const JITTER_MIN_MS = 300;
const JITTER_SPREAD_MS = 600;

const MS_PER_SECOND = 1000;

/**
 * The client errors worth trying again: a request timeout (the gateway reports
 * a connection that timed out below it as one) and too many requests.
 */
const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const RETRYABLE_CLIENT_ERRORS: readonly number[] = [
  REQUEST_TIMEOUT,
  TOO_MANY_REQUESTS,
];
/** From here up the fault is the server's, and a second try may land. */
const SERVER_ERROR = 500;
/** From here to `SERVER_ERROR`, the request itself is wrong and will be wrong again. */
const CLIENT_ERROR = 400;

/** The HTTP status an AI SDK or AI Gateway error carries, if any. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

type ResponseHeaders = Record<string, string>;

/** An error's own response headers, as the AI SDK's `APICallError` carries them. */
function ownHeaders(err: unknown): ResponseHeaders | undefined {
  const headers = (err as { responseHeaders?: unknown } | null)
    ?.responseHeaders;
  return headers && typeof headers === 'object'
    ? (headers as ResponseHeaders)
    : undefined;
}

/**
 * The response headers of a failed call. `APICallError` carries them; the
 * AI Gateway's own errors wrap one as their `cause`, which is where the SDK's
 * own backoff looks too.
 */
function headersOf(err: unknown): ResponseHeaders | undefined {
  return (
    ownHeaders(err) ?? ownHeaders((err as { cause?: unknown } | null)?.cause)
  );
}

/** The wait a `retry-after-ms` or `retry-after` header asks for, in milliseconds. */
function retryAfterMs(headers: ResponseHeaders | undefined) {
  const ms = Number.parseFloat(headers?.['retry-after-ms'] ?? '');
  if (Number.isFinite(ms)) {
    return ms;
  }
  const after = headers?.['retry-after'];
  if (!after) {
    return;
  }
  const seconds = Number.parseFloat(after);
  const wait = Number.isFinite(seconds)
    ? seconds * MS_PER_SECOND
    : Date.parse(after) - Date.now();
  return Number.isFinite(wait) ? wait : undefined;
}

/** What to do after a failed first attempt: give up, or wait this long and try once more. */
type RetryDecision = { retry: false } | { retry: true; waitMs: number };

/**
 * The decision, from the failure and from which of the two signals fired.
 * A cancel never retries. A timeout of ours was a stuck call, and goes again
 * at once. A rate limit, a timeout below us or a server error waits what the server asked, at most
 * three seconds, or a jittered moment when it asked nothing. Any other client
 * error would fail the same way twice. A failure with no status at all, a
 * dropped connection or a reply that did not parse, gets the jittered moment.
 */
function retryDecision(
  err: unknown,
  { cancelled, timedOut }: { cancelled: boolean; timedOut: boolean },
): RetryDecision {
  if (cancelled) {
    return { retry: false };
  }
  if (timedOut) {
    return { retry: true, waitMs: 0 };
  }
  const status = statusOf(err);
  if (
    status !== undefined &&
    status >= CLIENT_ERROR &&
    status < SERVER_ERROR &&
    !RETRYABLE_CLIENT_ERRORS.includes(status)
  ) {
    return { retry: false };
  }
  const asked = retryAfterMs(headersOf(err));
  if (asked !== undefined && asked >= 0) {
    return { retry: true, waitMs: Math.min(asked, MAX_RETRY_AFTER_MS) };
  }
  return {
    retry: true,
    waitMs: JITTER_MIN_MS + Math.floor(Math.random() * JITTER_SPREAD_MS),
  };
}

/** Sleep for `ms`, or reject as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Run `call` with a signal that aborts on the caller's cancel or after
 * `timeoutMs`, and run it once more when `retryDecision` says so. The SDK's
 * own retries must be off inside `call`: its backoff would sleep inside our
 * timeout, and a timeout firing mid-sleep is the stuck call this retry is for.
 */
export async function withOneRetry<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const attempt = () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return { run: call(combined), timeout };
  };
  const first = attempt();
  try {
    return await first.run;
  } catch (err) {
    const decision = retryDecision(err, {
      cancelled: signal?.aborted === true,
      timedOut: first.timeout.aborted,
    });
    if (!decision.retry) {
      throw err;
    }
    await pause(decision.waitMs, signal);
    return await attempt().run;
  }
}
