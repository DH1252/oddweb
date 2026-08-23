import { Link } from '@tanstack/react-router'

import { buttonClass } from '../../components/oddweb'

export function FilterSummary({
  include,
  exclude,
  onClear,
}: {
  include: string[]
  exclude: string[]
  onClear: () => void
}) {
  if (!include.length && !exclude.length) return null

  return (
    <div className="mb-2.5 flex flex-col justify-between gap-2 border border-ink bg-canvas p-2 sm:flex-row sm:items-center">
      <p className="m-0 font-mono text-xs text-brown">
        Filtering by {include.length} included and {exclude.length} excluded
        tags.
      </p>
      <div className="flex gap-1.5">
        <Link
          to="/tags"
          search={{
            include: include.length ? include : undefined,
            exclude: exclude.length ? exclude : undefined,
          }}
          className={buttonClass}
        >
          Edit tag filters
        </Link>
        <button type="button" className={buttonClass} onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  )
}
