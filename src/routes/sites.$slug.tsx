import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useState } from 'react'

import { PageShell, Panel, SiteFooter, SiteHeader } from '../components/oddweb'
import { getAdjacentSites, getSite } from '../data/sites'
import { thumbnailUrl } from '../lib/thumbnails'
import { directoryQueryOptions } from '../queries/oddweb'
import { recordSiteVisit } from '../server/data'

export const Route = createFileRoute('/sites/$slug')({
  loader: async ({ context, params }) => {
    const data = await context.queryClient.ensureQueryData(
      directoryQueryOptions(),
    )
    if (!getSite(params.slug, data.sites)) throw notFound()
    return data
  },
  component: SiteDetailPage,
})

function SiteDetailPage() {
  const { slug } = Route.useParams()
  const data = Route.useLoaderData()
  const queryClient = useQueryClient()
  const [visitError, setVisitError] = useState('')
  const [imageFailed, setImageFailed] = useState(false)
  const site = getSite(slug, data.sites)
  const visitMutation = useMutation({
    mutationFn: (entrySlug: string) =>
      recordSiteVisit({ data: { slug: entrySlug } }),
    onSuccess: (result) => {
      if (result.recorded) {
        void queryClient.invalidateQueries({
          queryKey: ['oddweb', 'directory'],
        })
      }
    },
    onError: (error) =>
      setVisitError(
        error instanceof Error
          ? error.message
          : 'This detail entry could not be recorded.',
      ),
  })
  const recordEntry = useEffectEvent((entrySlug: string) => {
    setVisitError('')
    visitMutation.mutate(entrySlug)
  })

  useEffect(() => {
    setImageFailed(false)
    recordEntry(slug)
  }, [slug])

  if (!site) throw notFound()

  const { previous, next } = getAdjacentSites(site.slug, data.sites)

  return (
    <PageShell>
      <SiteHeader directoryLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-3 mb-4 border border-ink bg-paper p-2.5"
        data-od-id={`entry-${site.slug}`}
      >
        <section className="grid border border-ink md:grid-cols-[minmax(220px,.7fr)_minmax(0,1.3fr)]">
          <div
            className={`relative grid min-h-52 place-items-center overflow-hidden bg-linear-to-br ${site.accent} p-6 text-white md:min-h-72`}
            aria-hidden={site.thumbnailKey && !imageFailed ? undefined : true}
          >
            {site.thumbnailKey && !imageFailed ? (
              <img
                src={thumbnailUrl(site.thumbnailKey)}
                alt={site.thumbnailAlt || `Preview of ${site.name}`}
                className="absolute inset-0 size-full object-cover"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <>
                <div className="absolute inset-0 opacity-30 odd-crosshatch" />
                <span className="relative max-w-full -rotate-3 border-2 border-white bg-ink/70 px-4 py-3 text-center font-mono text-[clamp(18px,4vw,42px)] leading-[0.95] font-bold tracking-[-0.04em] whitespace-normal text-balance shadow-[5px_5px_0_rgb(255_255_255/0.4)] [overflow-wrap:anywhere]">
                  {site.name}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-col items-start justify-center border-t border-ink bg-rust px-5 py-6 text-white md:border-t-0 md:border-l">
            <h1
              className="m-0 mb-2 font-mono text-[clamp(34px,6vw,62px)] leading-none font-bold tracking-[-0.05em]"
              data-od-id="entry-title"
            >
              {site.name}
            </h1>
            <p className="mb-5 max-w-xl text-base leading-relaxed">
              {site.summary}
            </p>
            <a
              className="inline-flex min-h-11 items-center border border-white bg-paper px-3 font-bold text-ink no-underline shadow-[2px_2px_0_#2a1810] hover:bg-warm"
              href={site.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-od-id="visit-original"
            >
              Open {site.name} ↗
            </a>
          </div>
        </section>

        {visitMutation.isPending ? (
          <p
            className="mt-2 mb-0 font-mono text-[11px] text-muted"
            role="status"
          >
            Recording this detail entry...
          </p>
        ) : visitError ? (
          <p
            className="mt-2 mb-0 border border-danger bg-red-50 px-2 py-1 font-mono text-xs text-danger"
            role="alert"
          >
            The page opened, but its detail count was not updated: {visitError}
          </p>
        ) : null}

        <div className="mt-2.5 grid items-start gap-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(240px,.6fr)]">
          <Panel title="What you will find" className="h-full">
            <div data-od-id="entry-notes">
              {site.notes.map((note) => (
                <p key={note} className="last:mb-0">
                  {note}
                </p>
              ))}
            </div>
          </Panel>
          <Panel title="Site details" className="h-full">
            <dl className="m-0" data-od-id="entry-facts">
              {site.facts.map((fact) => (
                <div
                  key={fact.label}
                  className="grid grid-cols-[80px_1fr] gap-2 border-t border-dotted border-muted py-2 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <dt className="font-mono text-xs font-bold tracking-wide uppercase">
                    {fact.label}
                  </dt>
                  <dd className="m-0 text-brown">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        <nav
          className="mt-2.5 flex items-stretch justify-between gap-2 border border-line bg-canvas p-1.5 font-mono text-sm font-bold"
          aria-label="Browse directory entries"
        >
          <Link
            to="/sites/$slug"
            params={{ slug: previous.slug }}
            className="inline-flex min-h-11 items-center px-2 underline-offset-4 hover:bg-brown hover:text-paper"
          >
            &larr; {previous.name}
          </Link>
          <Link
            to="/sites/$slug"
            params={{ slug: next.slug }}
            className="inline-flex min-h-11 items-center px-2 text-right underline-offset-4 hover:bg-brown hover:text-paper"
          >
            {next.name} &rarr;
          </Link>
        </nav>
      </main>
      <SiteFooter />
    </PageShell>
  )
}
