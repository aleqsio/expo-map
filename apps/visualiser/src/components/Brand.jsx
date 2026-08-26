import { cn } from '@/lib/utils'

// The mark: a tiny atlas — three stacked screens with a route between them.
export function Mark({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-5', className)} aria-hidden="true">
      <rect x="3" y="3" width="7" height="11" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="14" y="10" width="7" height="11" rx="2" fill="currentColor" opacity="0.55" />
      <path d="M10 8.5 C 13 8.5, 12 15.5, 14 15.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function Wordmark({ className }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-primary', className)}>
      <Mark />
      <span className="font-heading text-[15px] font-bold tracking-[-0.03em] text-foreground">screenmap</span>
    </span>
  )
}
