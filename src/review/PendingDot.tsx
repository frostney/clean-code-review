// The dot pulses rather than the words, so text never fades below legibility.
export function PendingDot({ tone = 'bg-muted' }: { tone?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${tone}`}
    />
  );
}
