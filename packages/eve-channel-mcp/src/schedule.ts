/**
 * Bounds how many of one request's tool calls run at once. A queued call
 * whose client has gone is dropped from the queue and never starts, and
 * the signal is checked again the moment a slot is granted.
 */
export type Schedule = <T>(
  signal: AbortSignal,
  run: () => Promise<T>,
  cancelled: () => T,
) => Promise<T>;

export function createSchedule(limit: number): Schedule {
  let active = 0;
  const waiting: (() => void)[] = [];

  function release(): void {
    const next = waiting.shift();

    if (next) {
      // The slot passes straight to the next caller, so no newcomer can take it in between.
      next();
    } else {
      active--;
    }
  }

  function acquire(signal: AbortSignal): Promise<boolean> {
    if (active < limit) {
      active++;

      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener('abort', leave);
        resolve(true);
      };
      const leave = () => {
        const at = waiting.indexOf(grant);

        if (at !== -1) {
          waiting.splice(at, 1);
        }
        resolve(false);
      };

      waiting.push(grant);
      signal.addEventListener('abort', leave, { once: true });
    });
  }

  return async (signal, run, cancelled) => {
    if (signal.aborted || !(await acquire(signal))) {
      return cancelled();
    }
    try {
      return signal.aborted ? cancelled() : await run();
    } finally {
      release();
    }
  };
}
