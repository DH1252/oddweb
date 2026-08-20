import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useState } from 'react'

import { PageShell, Panel, SiteFooter, SiteHeader } from '../components/oddweb'
import { thumbnailSrcSet, thumbnailUrl } from '../lib/thumbnails'
import { siteDetailQueryOptions } from '../queries/oddweb'
import { recordSiteVisit } from '../server/data'
import { useSiteVote } from '../hooks/use-site-vote'
import { VoteChallengeDialog } from '../components/vote-challenge-dialog'
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
    const primaryTag = site.tags[0] ? site.tags[0].replace(/^~/, '') : 'Web'
    const capitalizedTag =
      primaryTag.charAt(0).toUpperCase() + primaryTag.slice(1)
    const title = `${site.name} – Interactive ${capitalizedTag} Experience | Oddweb`
    const description = `${site.summary} Discovered on Oddweb, the public crowdsourced directory of weird and unusual websites.`
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
                interactionStatistic: [
                  {
                    '@type': 'InteractionCounter',
                    interactionType: {
                      '@type': 'https://schema.org/LikeAction',
                    },
                    userInteractionCount: site.votes,
                  },
                  {
                    '@type': 'InteractionCounter',
                    interactionType: {
                      '@type': 'https://schema.org/ViewAction',
                    },
                    userInteractionCount: site.visits,
                  },
                ],
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
  const { data } = useSuspenseQuery(siteDetailQueryOptions(slug))
  const [imageFailed, setImageFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const visitMutation = useMutation({
    mutationFn: (entrySlug: string) =>
      recordSiteVisit({ data: { slug: entrySlug } }),
  })
  const {
    toggleVote: triggerVote,
    getOptimisticVoteState,
    challenge,
  } = useSiteVote({
    setNotice,
    setNoticeError,
  })

  const recordEntry = useEffectEvent((entrySlug: string) => {
    visitMutation.mutate(entrySlug)
  })

  useEffect(() => {
    setImageFailed(false)
    recordEntry(slug)
  }, [slug])

  if (!data) throw notFound({ headers: notFoundHeaders })

  const { site } = data
  const { previous, next } = data
  const toggleVote = () => triggerVote(site.slug, site.votes)

  const {
    voted: isSiteVoted,
    votes: siteVotes,
    isPending: votePending,
  } = getOptimisticVoteState(site.slug, site.votes)

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
          <div className="flex min-w-0 flex-col items-start justify-center border-t border-ink bg-rust px-5 py-6 text-white md:border-t-0 md:border-l">
            <h1
              className="m-0 mb-2 font-mono text-[clamp(34px,6vw,62px)] leading-none font-bold tracking-[-0.05em] break-words [overflow-wrap:anywhere]"
              data-od-id="entry-title"
            >
              {site.name}
            </h1>
            <p className="mb-5 max-w-xl text-base leading-relaxed break-words [overflow-wrap:anywhere]">
              {site.summary}
            </p>
            <a
              className="inline-flex min-h-11 max-w-full items-center border border-white bg-paper px-3 font-bold text-ink no-underline shadow-[2px_2px_0_#2a1810] hover:bg-warm"
              href={site.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-od-id="visit-original"
            >
              <span className="truncate">Open {site.name} ↗</span>
            </a>
            <button
              type="button"
              className={`mt-3 inline-flex min-h-11 max-w-full items-center gap-1.5 border px-3 font-bold transition-all active:translate-x-px active:translate-y-px active:shadow-none disabled:cursor-wait ${
                isSiteVoted
                  ? 'border-white bg-success text-white shadow-[2px_2px_0_#1b4e30] hover:bg-[#225530] hover:brightness-110'
                  : 'border-white bg-paper text-ink hover:bg-warm shadow-[2px_2px_0_#2a1810]'
              }`}
              aria-pressed={isSiteVoted}
              aria-busy={votePending}
              title={
                isSiteVoted
                  ? 'Click to remove your vote'
                  : `Vote for ${site.name}`
              }
              onClick={toggleVote}
              disabled={votePending}
              data-od-id="vote-site"
            >
              <span className="truncate">
                {isSiteVoted ? 'Voted' : 'Vote'} &uarr; {siteVotes}
              </span>
            </button>
            {notice ? (
              <p
                role="status"
                className={`mt-3 p-2 font-mono text-xs font-bold border break-words ${
                  noticeError
                    ? 'border-white bg-sand text-ink'
                    : 'border-white bg-green-50 text-success'
                }`}
              >
                {notice}
              </p>
            ) : null}
          </div>
        </section>

        <div className="mt-2.5 grid items-start gap-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(240px,.6fr)]">
          <Panel title="What you will find" className="h-full">
            <div data-od-id="entry-notes">
              {site.notes.map((note) => (
                <p
                  key={note}
                  className="last:mb-0 break-words [overflow-wrap:anywhere]"
                >
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
                  className="grid grid-cols-[80px_minmax(0,1fr)] gap-2 border-t border-dotted border-muted py-2 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <dt className="font-mono text-xs font-bold tracking-wide uppercase">
                    {fact.label}
                  </dt>
                  <dd className="m-0 min-w-0 text-brown break-all [overflow-wrap:anywhere]">
                    {fact.value}
                  </dd>
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
                      className="max-w-full border border-line bg-canvas px-2 py-1 font-mono text-xs underline-offset-2 hover:bg-brown hover:text-paper"
                    >
                      <span className="truncate">
                        Filter by{' '}
                        {site.tagLabels?.[siteTag] || siteTag.replace(/^~/, '')}
                      </span>
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
            className="inline-flex min-h-11 min-w-0 max-w-[48%] items-center px-2 underline-offset-4 hover:bg-brown hover:text-paper"
          >
            <span className="truncate">&larr; {previous.name}</span>
          </Link>
          <Link
            to="/sites/$slug"
            params={{ slug: next.slug }}
            className="inline-flex min-h-11 min-w-0 max-w-[48%] items-center justify-end px-2 text-right underline-offset-4 hover:bg-brown hover:text-paper"
          >
            <span className="truncate">{next.name} &rarr;</span>
          </Link>
        </nav>
      </main>
      <SiteFooter />
      {challenge ? <VoteChallengeDialog challenge={challenge} /> : null}
    </PageShell>
  )
}
