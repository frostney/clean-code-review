/**
 * Hands an error to an app's reporter. A reporter that throws or rejects must
 * not decide what the client reads, nor, as an unhandled rejection, take the
 * process down.
 */
export function reportSafely<TArgs extends unknown[]>(
  report: (...args: TArgs) => void | Promise<void>,
  ...args: TArgs
): void {
  try {
    Promise.resolve(report(...args)).catch(() => undefined);
  } catch {
    // Swallowed on purpose: the reporter's own failure has nowhere safe to go.
  }
}
