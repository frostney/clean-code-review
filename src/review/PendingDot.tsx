/**
 * The one moving part of "still working": a dot that pulses beside words that
 * hold still, so the words never fade below what can be read.
 */
export function PendingDot({ tone = 'bg-muted' }: { tone?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${tone}`}
    />
  );
}
