/**
 * Our timeout and the caller's cancel both surface as `AbortError`, so the
 * signals, not the error, tell them apart.
 */
/** A longer `retry-after` is a limit one retry will not outlast, so it is not retried. */
const MAX_RETRY_AFTER_MS = 3000;

/** Without `retry-after`, jitter keeps parallel calls from retrying in step. */
const JITTER_MIN_MS = 300;
const JITTER_SPREAD_MS = 600;

const MS_PER_SECOND = 1000;

/** The gateway reports an upstream connection timeout as 408. */
const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const RETRYABLE_CLIENT_ERRORS: readonly number[] = [
  REQUEST_TIMEOUT,
  TOO_MANY_REQUESTS,
];
const FIRST_SERVER_ERROR = 500;
const FIRST_CLIENT_ERROR = 400;

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

type ResponseHeaders = Record<string, string>;

function ownHeaders(err: unknown): ResponseHeaders | undefined {
  const headers = (err as { responseHeaders?: unknown } | null)
    ?.responseHeaders;
  return headers && typeof headers === 'object'
    ? (headers as ResponseHeaders)
    : undefined;
}

/** AI Gateway errors wrap the `APICallError` as `cause`, where the SDK's own backoff looks too. */
function headersOf(err: unknown): ResponseHeaders | undefined {
  return (
    ownHeaders(err) ?? ownHeaders((err as { cause?: unknown } | null)?.cause)
  );
}

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

type RetryDecision = { retry: false } | { retry: true; waitMs: number };

/** Our own timeout means a stuck call, so it retries immediately. */
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
    status >= FIRST_CLIENT_ERROR &&
    status < FIRST_SERVER_ERROR &&
    !RETRYABLE_CLIENT_ERRORS.includes(status)
  ) {
    return { retry: false };
  }
  const asked = retryAfterMs(headersOf(err));
  if (asked !== undefined && asked >= 0) {
    // A wait cut short would only be retried into the same limit.
    return asked > MAX_RETRY_AFTER_MS
      ? { retry: false }
      : { retry: true, waitMs: asked };
  }
  return {
    retry: true,
    waitMs: JITTER_MIN_MS + Math.floor(Math.random() * JITTER_SPREAD_MS),
  };
}

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
 * Each attempt gets its own `timeoutMs`. Disable the SDK's retries inside
 * `call`: its backoff would sleep inside our timeout and be mistaken for a
 * stuck call.
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
