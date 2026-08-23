import { ItemThumbnail, Panel } from '../../components/oddweb'
import { LocalTime } from '../../components/local-time'

import type { RecentFiling } from '../../data/sites'

export function RecentFilingsPanel({ filings }: { filings: RecentFiling[] }) {
  return (
    <Panel title="Recently added" label="NEWEST SUBMISSIONS">
      <ol className="m-0 grid list-none gap-1 p-0 sm:grid-cols-3">
        {filings.slice(0, 6).map((filing) => (
          <li
            key={filing.url}
            className="min-w-0 border-t border-dotted border-muted py-2 first:border-t-0 sm:border-t-0 sm:border-l sm:px-3 sm:nth-[3n+1]:border-l-0"
          >
            {filing.thumbnailKey ? (
              <ItemThumbnail
                thumbnailKey={filing.thumbnailKey}
                alt={filing.thumbnailAlt || `Preview of ${filing.name}`}
                label={filing.name}
                className="mb-2 h-24 w-full"
              />
            ) : null}
            <a
              href={filing.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono font-bold underline-offset-4 hover:text-rust break-words [overflow-wrap:anywhere]"
            >
              {filing.name}
            </a>
            <span className="ml-2 font-mono text-xs text-muted">
              <LocalTime seconds={filing.submittedAt} fallback={filing.date} />
            </span>
            <p className="mt-1 mb-0 text-sm text-brown break-words [overflow-wrap:anywhere]">
              {filing.description}
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  )
}
