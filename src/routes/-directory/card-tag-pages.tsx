import { useEffect, useRef, useState } from 'react'

export function CardTagPages({
  siteName,
  tags,
  includedTags,
  excludedTags,
  onInclude,
  onExclude,
  labels,
}: {
  siteName: string
  tags: string[]
  includedTags: string[]
  excludedTags: string[]
  onInclude: (tag: string) => void
  onExclude: (tag: string) => void
  labels: Record<string, string>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tagsPerPage, setTagsPerPage] = useState(2)
  const [page, setPage] = useState(0)
  const includedTagSet = new Set(includedTags)
  const excludedTagSet = new Set(excludedTags)

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      const nextSize = width >= 520 ? 4 : width >= 340 ? 3 : 2
      setTagsPerPage((current) => (current === nextSize ? current : nextSize))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const pageCount = Math.max(1, Math.ceil(tags.length / tagsPerPage))
  const safePage = Math.min(page, pageCount - 1)
  const visibleTags = tags.slice(
    safePage * tagsPerPage,
    (safePage + 1) * tagsPerPage,
  )

  return (
    <div ref={containerRef} className="mt-1 min-w-0">
      <div className="flex min-w-0 flex-wrap gap-0.5">
        {visibleTags.map((siteTag) => (
          <span key={siteTag} className="inline-flex max-w-full">
            <span className="inline-flex min-h-8 min-w-0 max-w-36 items-center border border-line bg-canvas px-2 font-mono text-xs leading-tight whitespace-normal [overflow-wrap:anywhere]">
              {labels[siteTag] || siteTag.replace(/^~/, '')}
            </span>
            <button
              type="button"
              aria-label={`Include ${labels[siteTag] || siteTag.replace(/^~/, '')}`}
              aria-pressed={includedTagSet.has(siteTag)}
              title={`Include ${labels[siteTag] || siteTag.replace(/^~/, '')}`}
              onClick={() => onInclude(siteTag)}
              className={`min-h-8 shrink-0 border border-l-0 px-2 font-mono text-xs ${includedTagSet.has(siteTag) ? 'border-success bg-green-50 text-success' : 'border-brown bg-paper hover:bg-success hover:text-white'}`}
            >
              +
            </button>
            <button
              type="button"
              aria-label={`Exclude ${labels[siteTag] || siteTag.replace(/^~/, '')}`}
              aria-pressed={excludedTagSet.has(siteTag)}
              title={`Exclude ${labels[siteTag] || siteTag.replace(/^~/, '')}`}
              onClick={() => onExclude(siteTag)}
              className="min-h-8 shrink-0 border border-l-0 border-brown bg-paper px-2 font-mono text-xs text-danger hover:bg-danger hover:text-white"
            >
              -
            </button>
          </span>
        ))}
      </div>
      {pageCount > 1 ? (
        <nav
          className="mt-1 flex items-center gap-1 font-mono text-[11px] text-muted"
          aria-label={`${siteName} tag pages`}
        >
          <button
            type="button"
            className="grid min-h-8 min-w-8 place-items-center border border-brown bg-paper hover:bg-warm disabled:cursor-not-allowed disabled:bg-canvas disabled:text-brown"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
            aria-label="Previous tag page"
          >
            &larr;
          </button>
          <span aria-live="polite">
            {safePage + 1}/{pageCount}
          </span>
          <button
            type="button"
            className="grid min-h-8 min-w-8 place-items-center border border-brown bg-paper hover:bg-warm disabled:cursor-not-allowed disabled:bg-canvas disabled:text-brown"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
            aria-label="Next tag page"
          >
            &rarr;
          </button>
        </nav>
      ) : null}
    </div>
  )
}
