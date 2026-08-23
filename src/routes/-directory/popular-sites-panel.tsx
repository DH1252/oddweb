import { Link } from '@tanstack/react-router'

import { Panel } from '../../components/oddweb'
import { Pagination } from './pagination'

import type { SiteEntry } from '../../data/sites'

export function PopularSitesPanel({
  sites,
  page,
  pageCount,
  onPageChange,
}: {
  sites: SiteEntry[]
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  return (
    <Panel
      title="Most viewed"
      label="POPULAR SITES"
      className="[&>div:last-child]:p-3.5"
    >
      <ol
        id="most-opened-results"
        tabIndex={-1}
        className="m-0 grid list-none grid-cols-1 p-0 outline-none sm:grid-cols-2"
      >
        {sites.map((site, index) => (
          <li
            key={site.slug}
            className="min-h-24 min-w-0 border-t border-dotted border-muted px-0 py-3 sm:border-r sm:px-4 sm:first:border-t-0 sm:nth-[2]:border-t-0 sm:nth-[even]:border-r-0"
          >
            <span className="block font-mono text-xs text-muted">
              {String(page * 4 + index + 1).padStart(2, '0')}
            </span>
            <Link
              to="/sites/$slug"
              params={{ slug: site.slug }}
              className="font-mono font-bold underline-offset-4 hover:text-rust break-words [overflow-wrap:anywhere]"
            >
              {site.name}
            </Link>
            <span className="ml-2 font-mono text-xs text-muted">
              {site.visits} {site.visits === 1 ? 'view' : 'views'}
            </span>
            <p className="mt-1 mb-0 text-sm text-brown break-words [overflow-wrap:anywhere]">
              {site.description}
            </p>
          </li>
        ))}
      </ol>
      <Pagination
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        label="Most viewed pages"
        focusTargetId="most-opened-results"
      />
    </Panel>
  )
}
