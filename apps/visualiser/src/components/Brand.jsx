import { cn } from '@/lib/utils'

// The mark: two screens with a route between them. Same geometry as the
// favicon in public/, drawn in currentColor and without the black tile, which
// the favicon only needs to hold its own against browser chrome. Keep the two
// in step: the coordinates below are the favicon's, cropped to the glyph.
export function Mark({ className }) {
  return (
    <svg viewBox="4 4 24 24" className={cn('size-5', className)} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <rect x="6" y="5" width="9" height="11" rx="1.5" />
        <rect x="18" y="16" width="9" height="11" rx="1.5" />
        <path d="M15 10.5h4a2 2 0 0 1 2 2V16" />
      </g>
    </svg>
  )
}

// `labelClassName` is for callers tight on width: hide the name and the mark
// still signs the page, the way the favicon does.
export function Wordmark({ className, labelClassName }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-2 text-primary', className)}>
      <Mark />
      <span className={cn('font-heading text-[15px] font-bold tracking-[-0.03em] text-foreground', labelClassName)}>screenmap</span>
    </span>
  )
}
