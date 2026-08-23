import { buttonClass } from '../../components/oddweb'

export function Pagination({
  page,
  pageCount,
  onPageChange,
  label,
  focusTargetId,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  label: string
  focusTargetId?: string
}) {
  function changePage(nextPage: number) {
    onPageChange(nextPage)
    if (focusTargetId) {
      window.requestAnimationFrame(() =>
        document.getElementById(focusTargetId)?.focus(),
      )
    }
  }

  return (
    <nav
      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-dotted border-muted pt-2.5"
      aria-label={label}
    >
      <button
        type="button"
        className={buttonClass}
        disabled={page === 0}
        onClick={() => changePage(page - 1)}
      >
        Previous
      </button>
      <span
        className="order-first w-full text-center font-mono text-xs text-muted sm:order-none sm:w-auto"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Page {page + 1} of {pageCount}
      </span>
      <button
        type="button"
        className={buttonClass}
        disabled={page >= pageCount - 1}
        onClick={() => changePage(page + 1)}
      >
        Next
      </button>
    </nav>
  )
}
