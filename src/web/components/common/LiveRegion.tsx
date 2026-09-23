/** Visually hidden polite live region; announces revealed results to screen readers. */
export interface LiveRegionProps {
  readonly message: string;
}

export function LiveRegion({ message }: Readonly<LiveRegionProps>) {
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="live-region">
      {message}
    </div>
  );
}

export default LiveRegion;
