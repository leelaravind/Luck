import type { ReactNode } from 'react';

/** White module container (DESIGN.md card tier): hairline border, ambient shadow, titled header. */
export interface CardProps {
  readonly title: ReactNode;
  /** Heading level inside the landmark it sits in. */
  readonly level?: 2 | 3;
  /** Right-aligned header content (badge, metric, action). */
  readonly meta?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly id?: string;
}

export function Card({ title, level = 2, meta, children, className = '', bodyClassName = '', id }: Readonly<CardProps>) {
  const Heading = level === 2 ? 'h2' : 'h3';
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`rounded-card border border-hairline bg-card shadow-card ${className}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <Heading id={headingId} className="text-sm font-semibold tracking-tight text-ink">
          {title}
        </Heading>
        {meta ? <div className="flex shrink-0 items-center gap-1.5">{meta}</div> : null}
      </div>
      <div className={`px-3 py-2.5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export default Card;
