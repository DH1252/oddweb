import { Link } from '@tanstack/react-router'

import { LocalTime } from '../../components/local-time'
import { SiteThumbnail } from '../../components/oddweb'
import { CardTagPages } from './card-tag-pages'

import type { SiteEntry } from '../../data/sites'

export function SiteRow({
  site,
  includedTags,
  excludedTags,
  onInclude,
  onExclude,
  voted,
  votes,
  votePending,
  onVote,
}: {
  site: SiteEntry
  includedTags: string[]
  excludedTags: string[]
  onInclude: (tag: string) => void
  onExclude: (tag: string) => void
  voted: boolean
  votes: number
  votePending: boolean
  onVote: (slug: string, currentVotes?: number) => void
}) {
  return (
    <article
      className="grid min-h-28 grid-cols-[82px_minmax(0,1fr)] border-b border-dotted border-muted hover:bg-canvas sm:grid-cols-[104px_minmax(0,1fr)]"
      data-od-id={`site-card-${site.slug}`}
    >
      <div className="my-3 mr-2 sm:mr-2.5">
        <SiteThumbnail site={site} />
      </div>
      <div className="min-w-0 py-2.5">
        <h3 className="m-0 font-mono text-base leading-snug font-bold">
          <Link
            id={`site-${site.slug}`}
            to="/sites/$slug"
            params={{ slug: site.slug }}
            className="inline-flex min-h-11 max-w-full items-center underline underline-offset-2 hover:text-rust break-words [overflow-wrap:anywhere]"
          >
            {site.name}
          </Link>
        </h3>
        <p className="m-0 text-brown break-words [overflow-wrap:anywhere]">
          {site.description}
        </p>
        <CardTagPages
          siteName={site.name}
          tags={site.tags}
          includedTags={includedTags}
          excludedTags={excludedTags}
          onInclude={onInclude}
          onExclude={onExclude}
          labels={site.tagLabels || {}}
        />
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-muted">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {site.visits} {site.visits === 1 ? 'view' : 'views'}
            </span>
            <span aria-hidden="true">/</span>
            <span>
              Added{' '}
              <LocalTime seconds={site.addedAt} fallback={site.addedLabel} />
            </span>
          </div>
          <button
            type="button"
            className={`inline-flex min-h-8 shrink-0 items-center gap-1 border px-2 font-mono text-xs font-bold transition-all active:translate-x-px active:translate-y-px active:shadow-none disabled:cursor-wait ${
              voted
                ? 'border-success bg-success text-white shadow-[1px_1px_0_#1b4e30] hover:bg-[#225530] hover:brightness-110'
                : 'border-brown bg-paper text-brown hover:bg-warm shadow-[1px_1px_0_#d9aa7a]'
            }`}
            aria-pressed={voted}
            aria-busy={votePending}
            aria-label={`Vote for ${site.name}`}
            title={
              voted ? 'Click to remove your vote' : `Vote for ${site.name}`
            }
            onClick={() => onVote(site.slug, site.votes)}
            disabled={votePending}
            data-od-id={`vote-button-${site.slug}`}
          >
            {voted ? 'Voted' : 'Vote'} ↑ {votes}
          </button>
        </div>
      </div>
    </article>
  )
}
