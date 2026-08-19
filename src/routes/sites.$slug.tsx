import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { useEffect, useEffectEvent, useState } from 'react'

import { PageShell, Panel, SiteFooter, SiteHeader } from '../components/oddweb'
import { thumbnailSrcSet, thumbnailUrl } from '../lib/thumbnails'
import { myVotesQueryOptions, siteDetailQueryOptions } from '../queries/oddweb'
import { recordSiteVisit, toggleSiteVote } from '../server/data'
import {
  SITE_ORIGIN,
  notFoundHeaders,
  publicRobots,
  siteDetailUrl,
  siteSocialImage,
  socialMeta,
} from '../lib/seo'

export const Route = createFileRoute('/sites/$slug')({
  loader: async ({ context, params }) => {
    const data = await context.queryClient.fetchQuery(
      siteDetailQueryOptions(params.slug),
    )
    if (!data) throw notFound({ headers: notFoundHeaders })
    return data
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ name: 'robots', content: 'noindex' }] }

    const { site } = loaderData
    const title = `${site.name}: What It Is and Why Visit | Oddweb`
    const description = site.summary
    const url = siteDetailUrl(site.slug)
    const image = siteSocialImage(site)

    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { name: 'robots', content: publicRobots },
        ...socialMeta({
          title,
          description,
          url,
          image,
          imageAlt: site.thumbnailAlt || `Preview of ${site.name} on Oddweb`,
          type: 'article',
        }),
        { property: 'article:published_time', content: site.added },
        ...site.tags.map((tag) => ({
          property: 'article:tag',
          content: tag,
        })),
        {
          'script:ld+json': {
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'WebPage',
                '@id': `${url}#webpage`,
                url,
                name: title,
                description,
                datePublished: site.added,
                isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
                breadcrumb: { '@id': `${url}#breadcrumb` },
                about: {
                  '@type': 'WebSite',
                  name: site.name,
                  url: site.externalUrl,
                },
                primaryImageOfPage: {
                  '@type': 'ImageObject',
                  url: image,
                },
              },
              {
                '@type': 'BreadcrumbList',
                '@id': `${url}#breadcrumb`,
                itemListElement: [
                  {
                    '@type': 'ListItem',
                    position: 1,
                    name: 'Directory',
                    item: `${SITE_ORIGIN}/`,
                  },
                  {
                    '@type': 'ListItem',
                    position: 2,
                    name: site.name,
                    item: url,
                  },
                ],
              },
            ],
          },
        },
      ],
      links: [{ rel: 'canonical', href: url }],
    }
  },
  component: SiteDetailPage,
})

function SiteDetailPage() {
  const { slug } = Route.useParams()
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(siteDetailQueryOptions(slug))
  const [imageFailed, setImageFailed] = useState(false)
  const visitMutation = useMutation({
    mutationFn: (entrySlug: string) =>
      recordSiteVisit({ data: { slug: entrySlug } }),
  })
  const voteMutation = useMutation({
    mutationFn: (input: { slug: string; requestId: string }) =>
      toggleSiteVote({ data: input }),
  })
  const myVotes =
    useQuery({
      ...myVotesQueryOptions(),
      placeholderData: keepPreviousData,
    }).data?.slugs ?? []
  const recordEntry = useEffectEvent((entrySlug: string) => {
    visitMutation.mutate(entrySlug)
  })

  function toggleVote() {
    voteMutation.mutate(
      { slug, requestId: crypto.randomUUID() },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: ['oddweb', 'public', 'site', slug],
          })
          await queryClient.invalidateQueries({
            queryKey: ['oddweb', 'public', 'my-votes'],
          })
        },
      },
    )
  }

  useEffect(() => {
    setImageFailed(false)
    recordEntry(slug)
  }, [slug])

  if (!data) throw notFound({ headers: notFoundHeaders })

  const { site } = data
  const { previous, next } = data

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
              <picture className="contents">
                <source
                  type="image/avif"
                  srcSet={thumbnailSrcSet(site.thumbnailKey, 'avif')}
                  sizes="(max-width: 767px) 100vw, 50vw"
                />
                <source
                  type="image/webp"
                  srcSet={thumbnailSrcSet(site.thumbnailKey, 'webp')}
                  sizes="(max-width: 767px) 100vw, 50vw"
                />
                <img
                  src={thumbnailUrl(site.thumbnailKey)}
                  alt={site.thumbnailAlt || `Preview of ${site.name}`}
                  className="absolute inset-0 size-full object-cover"
                  sizes="(max-width: 767px) 100vw, 50vw"
                  fetchPriority="high"
                  decoding="async"
                  onError={() => setImageFailed(true)}
                />
              </picture>
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
            <button
              type="button"
              className={`mt-3 inline-flex min-h-11 items-center gap-1.5 border px-3 font-bold shadow-[2px_2px_0_#2a1810] ${
                myVotes.includes(site.slug)
                  ? 'border-white bg-green-50 text-success hover:bg-green-100'
                  : 'border-white bg-paper text-ink hover:bg-warm'
              }`}
              aria-pressed={myVotes.includes(site.slug)}
              onClick={toggleVote}
              disabled={voteMutation.isPending}
              data-od-id="vote-site"
            >
              {voteMutation.isPending
                ? 'Voting...'
                : myVotes.includes(site.slug)
                  ? 'Voted'
                  : 'Vote'}{' '}
              &uarr; {site.votes}
            </button>
          </div>
        </section>

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
            <div className="mt-3 border-t border-dotted border-muted pt-2">
              <h3 className="mt-0 mb-1 font-mono text-xs font-bold tracking-wide uppercase">
                Tags
              </h3>
              <div className="flex flex-wrap gap-1">
                {site.tags.map((siteTag) => {
                  return (
                    <Link
                      key={siteTag}
                      to="/"
                      search={{ include: [siteTag] }}
                      className="border border-line bg-canvas px-2 py-1 font-mono text-xs underline-offset-2 hover:bg-brown hover:text-paper"
                    >
                      Filter by{' '}
                      {site.tagLabels?.[siteTag] || siteTag.replace(/^~/, '')}
                    </Link>
                  )
                })}
              </div>
            </div>
          </Panel>
        </div>

        <nav
          className="mt-2.5 flex items-stretch justify-between gap-2 border border-line bg-canvas p-1.5 font-mono text-sm font-bold"
          aria-label="Browse sites"
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
