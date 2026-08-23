import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  keepPreviousData,
  useQuery,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { startTransition, useDeferredValue, useState } from 'react'

import { VoteChallengeDialog } from '../components/vote-challenge-dialog'
import { PageShell, SiteFooter, SiteHeader } from '../components/oddweb'
import {
  normalizePublicFilterSearch,
  publicDirectorySearchMaxLength,
  publicFilterLoaderDeps,
} from '../data/tags'
import {
  directoryQueryOptions,
  popularQueryOptions,
  publicSupportQueryOptions,
  turnstileConfigQueryOptions,
} from '../queries/oddweb'
import { useSiteVote } from '../hooks/use-site-vote'
import {
  resolveDirectoryPage,
  setDirectorySort,
  useDirectorySortSnapshot,
} from '../hooks/use-directory-sort'
import {
  SITE_ORIGIN,
  absoluteUrl,
  filteredRobots,
  publicRobots,
  siteDetailUrl,
  socialMeta,
} from '../lib/seo'
import { DirectoryCatalog } from './-directory/directory-catalog'
import { DirectoryHero } from './-directory/directory-hero'
import { DirectoryToolbar } from './-directory/directory-toolbar'
import { FilterSummary } from './-directory/filter-summary'
import { GuestbookPanel } from './-directory/guestbook-panel'
import { PopularSitesPanel } from './-directory/popular-sites-panel'
import { RecentFilingsPanel } from './-directory/recent-filings-panel'
import { SubmissionDialog } from './-directory/submission-dialog'

import type {
  DirectoryPageState,
  DirectorySortMode,
} from '../hooks/use-directory-sort'

const pageSize = 6
const homeTitle = 'Oddweb – Public Directory of Weird & Interactive Websites'
const homeDescription =
  'Explore a public, crowdsourced directory of weird, unusual, and interactive websites curated by the community beyond the usual web.'

export const Route = createFileRoute('/')({
  shouldReload: false,
  validateSearch: normalizePublicFilterSearch,
  loaderDeps: ({ search }) => publicFilterLoaderDeps(search),
  loader: async ({ context, deps }) => {
    const [directory] = await Promise.all([
      context.queryClient.fetchQuery(
        directoryQueryOptions({
          query: '',
          include: deps.include,
          exclude: deps.exclude,
          sort: 'popular',
          page: 0,
        }),
      ),
      context.queryClient.fetchQuery(publicSupportQueryOptions()),
      context.queryClient.fetchQuery(popularQueryOptions(0)),
    ])
    return directory
  },
  head: ({ loaderData, match }) => ({
    meta: [
      { title: homeTitle },
      {
        name: 'description',
        content: homeDescription,
      },
      {
        name: 'robots',
        content:
          match.search.include?.length || match.search.exclude?.length
            ? filteredRobots
            : publicRobots,
      },
      ...socialMeta({
        title: homeTitle,
        description: homeDescription,
        url: `${SITE_ORIGIN}/`,
      }),
      {
        'script:ld+json': {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'CollectionPage',
              '@id': `${SITE_ORIGIN}/#directory`,
              url: `${SITE_ORIGIN}/`,
              name: homeTitle,
              description: homeDescription,
              isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
              mainEntity: { '@id': `${SITE_ORIGIN}/#directory-list` },
            },
            {
              '@type': 'ItemList',
              '@id': `${SITE_ORIGIN}/#directory-list`,
              name: 'Websites on Oddweb',
              numberOfItems: loaderData?.sites.length ?? 0,
              itemListElement: (loaderData?.sites ?? []).map((site, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: site.name,
                item: siteDetailUrl(site.slug),
              })),
            },
          ],
        },
      },
    ],
    links: [{ rel: 'canonical', href: absoluteUrl('/') }],
  }),
  component: DirectoryPage,
})

function DirectoryPage() {
  const { include: rawInclude = [], exclude: rawExclude = [] } =
    Route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const { data: supportData } = useSuspenseQuery(publicSupportQueryOptions())
  const { guestbook, recentFilings: communityFilings } = supportData
  const include = rawInclude
  const includeSet = new Set(include)
  const exclude = rawExclude.filter((tag) => !includeSet.has(tag))
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const sortSnapshot = useDirectorySortSnapshot()
  const { sort } = sortSnapshot
  const [directoryPageState, setDirectoryPageState] =
    useState<DirectoryPageState>({
      sortRevision: sortSnapshot.revision,
      page: 0,
    })
  const page = resolveDirectoryPage(directoryPageState, sortSnapshot)
  const [popularPage, setPopularPage] = useState(0)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const turnstileConfig = useQuery(turnstileConfigQueryOptions()).data
  const initialDirectory = Route.useLoaderData()
  const directoryData =
    useQuery({
      ...directoryQueryOptions({
        query: deferredQuery,
        include,
        exclude,
        sort,
        page,
      }),
      placeholderData: keepPreviousData,
    }).data ?? initialDirectory
  const popularData = useQuery({
    ...popularQueryOptions(popularPage),
    placeholderData: keepPreviousData,
  }).data!
  const { toggleVote, getOptimisticVoteState, challenge } = useSiteVote({
    setNotice,
    setNoticeError,
  })

  const matchingSiteCount = directoryData.total
  const pageCount = Math.max(1, Math.ceil(matchingSiteCount / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleSites = directoryData.sites
  const popularPageCount = Math.max(1, Math.ceil(popularData.total / 4))
  const safePopularPage = Math.min(popularPage, popularPageCount - 1)
  const visiblePopular = popularData.sites

  function handleFilterTagsChange(
    type: 'include' | 'exclude',
    nextTags: string[],
  ) {
    const nextTagSet = new Set(nextTags)
    const nextInclude =
      type === 'include'
        ? nextTags
        : include.filter((tag) => !nextTagSet.has(tag))
    const nextExclude =
      type === 'exclude'
        ? nextTags
        : exclude.filter((tag) => !nextTagSet.has(tag))
    startTransition(() => {
      setDirectoryPageState({ sortRevision: sortSnapshot.revision, page: 0 })
      navigate({
        search: {
          include: nextInclude.length ? nextInclude : undefined,
          exclude: nextExclude.length ? nextExclude : undefined,
        },
      })
    })
  }

  function toggleIncludedTag(tag: string) {
    handleFilterTagsChange(
      'include',
      include.includes(tag)
        ? include.filter((item) => item !== tag)
        : [...include, tag],
    )
  }

  function addExcludedTag(tag: string) {
    handleFilterTagsChange(
      'exclude',
      exclude.includes(tag) ? exclude : [...exclude, tag],
    )
  }

  function handleClearTagFilters() {
    startTransition(() => {
      setDirectoryPageState({ sortRevision: sortSnapshot.revision, page: 0 })
      navigate({ search: {} })
    })
  }

  function changeDirectoryPage(nextPage: number) {
    startTransition(() =>
      setDirectoryPageState({
        sortRevision: sortSnapshot.revision,
        page: nextPage,
      }),
    )
  }

  function changePopularPage(nextPage: number) {
    startTransition(() => setPopularPage(nextPage))
  }

  function changeSort(nextSort: DirectorySortMode) {
    startTransition(() => {
      const nextSortSnapshot = setDirectorySort(nextSort)
      setDirectoryPageState({
        sortRevision: nextSortSnapshot.revision,
        page: 0,
      })
    })
  }

  function openSubmission() {
    setNotice('')
    setNoticeError(false)
    setSubmitOpen(true)
  }

  function clearDirectory() {
    setQuery('')
    handleClearTagFilters()
  }

  return (
    <PageShell>
      <SiteHeader />
      <DirectoryHero
        query={query}
        maxLength={publicDirectorySearchMaxLength}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery)
          setDirectoryPageState({
            sortRevision: sortSnapshot.revision,
            page: 0,
          })
        }}
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-2 mb-4 border border-ink bg-paper p-2.5"
        data-od-id="directory-section"
      >
        <DirectoryToolbar
          query={deferredQuery}
          include={include}
          exclude={exclude}
          onOpenSubmission={openSubmission}
          setNotice={setNotice}
          setNoticeError={setNoticeError}
        />
        <FilterSummary
          include={include}
          exclude={exclude}
          onClear={handleClearTagFilters}
        />

        {notice ? (
          <p
            className={`mb-2 border bg-canvas px-2 py-1.5 font-mono text-xs ${noticeError ? 'border-danger text-danger' : 'border-success'}`}
            role={noticeError ? 'alert' : 'status'}
          >
            {notice}
          </p>
        ) : null}

        <DirectoryCatalog
          matchingSiteCount={matchingSiteCount}
          sites={visibleSites}
          include={include}
          exclude={exclude}
          sort={sort}
          page={safePage}
          pageCount={pageCount}
          onSortChange={changeSort}
          onPageChange={changeDirectoryPage}
          onInclude={toggleIncludedTag}
          onExclude={addExcludedTag}
          onClear={clearDirectory}
          onVote={toggleVote}
          getVoteState={getOptimisticVoteState}
        />

        <div className="mt-2.5 grid gap-2.5">
          <PopularSitesPanel
            sites={visiblePopular}
            page={safePopularPage}
            pageCount={popularPageCount}
            onPageChange={changePopularPage}
          />
          <RecentFilingsPanel filings={communityFilings} />
          <GuestbookPanel
            entries={guestbook}
            sitekey={turnstileConfig?.sitekey ?? ''}
            setNotice={setNotice}
            setNoticeError={setNoticeError}
          />
        </div>
      </main>
      <SiteFooter />

      {submitOpen ? (
        <SubmissionDialog
          sitekey={turnstileConfig?.sitekey ?? ''}
          notice={notice}
          noticeError={noticeError}
          onClose={() => setSubmitOpen(false)}
          setNotice={setNotice}
          setNoticeError={setNoticeError}
        />
      ) : null}

      {challenge ? <VoteChallengeDialog challenge={challenge} /> : null}
    </PageShell>
  )
}
