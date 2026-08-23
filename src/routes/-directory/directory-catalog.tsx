import { buttonClass } from '../../components/oddweb'
import { Pagination } from './pagination'
import { SiteRow } from './site-row'

import type { SiteEntry } from '../../data/sites'
import type { DirectorySortMode } from '../../hooks/use-directory-sort'

export function DirectoryCatalog({
  matchingSiteCount,
  sites,
  include,
  exclude,
  sort,
  page,
  pageCount,
  onSortChange,
  onPageChange,
  onInclude,
  onExclude,
  onClear,
  onVote,
  getVoteState,
}: {
  matchingSiteCount: number
  sites: SiteEntry[]
  include: string[]
  exclude: string[]
  sort: DirectorySortMode
  page: number
  pageCount: number
  onSortChange: (sort: DirectorySortMode) => void
  onPageChange: (page: number) => void
  onInclude: (tag: string) => void
  onExclude: (tag: string) => void
  onClear: () => void
  onVote: (slug: string, currentVotes?: number) => void
  getVoteState: (
    slug: string,
    serverVotes: number,
  ) => { voted: boolean; votes: number; isPending: boolean }
}) {
  return (
    <section
      className="border border-line p-2.5"
      aria-labelledby="catalog-title"
    >
      <div className="mb-1 flex flex-col gap-2 border-b border-dotted border-brown pb-1.5 sm:flex-row sm:items-center sm:justify-between">
        <h2
          id="catalog-title"
          tabIndex={-1}
          className="m-0 font-mono text-base font-bold tracking-[0.08em] uppercase"
        >
          Sites
        </h2>
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 font-mono text-xs text-muted" aria-live="polite">
            {matchingSiteCount} {matchingSiteCount === 1 ? 'site' : 'sites'}
          </p>
          <label className="inline-flex items-center gap-2 font-mono text-xs font-bold">
            Order
            <select
              value={sort}
              onChange={(event) =>
                onSortChange(event.target.value as DirectorySortMode)
              }
              className="min-h-11 border border-brown bg-paper px-2 text-sm shadow-[1px_1px_0_#d9aa7a]"
              data-od-id="catalog-sort"
            >
              <option value="popular">Most voted</option>
              <option value="views">Most viewed</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="tags">Most tags</option>
              <option value="az">Title A-Z</option>
              <option value="za">Title Z-A</option>
            </select>
          </label>
        </div>
      </div>

      {sites.length ? (
        <div>
          {sites.map((site) => {
            const { voted, votes, isPending } = getVoteState(
              site.slug,
              site.votes,
            )
            return (
              <SiteRow
                key={site.slug}
                site={site}
                includedTags={include}
                excludedTags={exclude}
                onInclude={onInclude}
                onExclude={onExclude}
                voted={voted}
                votes={votes}
                votePending={isPending}
                onVote={onVote}
              />
            )
          })}
        </div>
      ) : (
        <div
          className="my-3 border border-dashed border-line bg-paper p-8 text-center"
          data-od-id="empty-state"
        >
          <h3 className="mb-1 font-mono font-bold">No sites found.</h3>
          <p className="mb-3 text-brown">Remove a tag or try fewer words.</p>
          <button type="button" className={buttonClass} onClick={onClear}>
            Show everything
          </button>
        </div>
      )}

      <Pagination
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        label="Directory pages"
        focusTargetId="catalog-title"
      />
    </section>
  )
}
