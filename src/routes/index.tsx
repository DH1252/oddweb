import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react'

import { TagInput } from '../components/tag-input'
import { LocalTime } from '../components/local-time'
import { Turnstile } from '../components/turnstile'
import { VoteChallengeDialog } from '../components/vote-challenge-dialog'
import { turnstileActions } from '../lib/turnstile'
import {
  FieldLabel,
  ItemThumbnail,
  ModalDialog,
  PageShell,
  Panel,
  SiteFooter,
  SiteHeader,
  SiteThumbnail,
  buttonClass,
  fieldClass,
  primaryButtonClass,
} from '../components/oddweb'
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
import { signGuestbook, submitSite as submitSiteMutation } from '../server/data'
import { useSiteVote } from '../hooks/use-site-vote'
import { getPublicSurprise } from '../server/public-data'
import {
  SITE_ORIGIN,
  absoluteUrl,
  filteredRobots,
  publicRobots,
  siteDetailUrl,
  socialMeta,
} from '../lib/seo'

import type { FormEvent } from 'react'
import type { SiteEntry } from '../data/sites'

type SortMode =
  | 'popular'
  | 'views'
  | 'newest'
  | 'oldest'
  | 'tags'
  | 'az'
  | 'za'

const pageSize = 6
const sortStorageKey = 'oddweb-directory-sort'
const homeTitle = 'Oddweb: Unusual, Fun and Interactive Websites'
const homeDescription =
  'Explore unusual, fun, and interactive websites selected for curious detours beyond the usual web.'
const sortModes: SortMode[] = [
  'popular',
  'views',
  'newest',
  'oldest',
  'tags',
  'az',
  'za',
]

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
  const queryClient = useQueryClient()
  const { data: supportData } = useSuspenseQuery(publicSupportQueryOptions())
  const { guestbook, recentFilings: communityFilings } = supportData
  const include = rawInclude
  const exclude = rawExclude.filter((tag) => !include.includes(tag))
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [sort, setSort] = useState<SortMode>('popular')
  const [sortLoaded, setSortLoaded] = useState(false)
  const [page, setPage] = useState(0)
  const [popularPage, setPopularPage] = useState(0)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [guestbookToken, setGuestbookToken] = useState<string | null>(null)
  const [guestbookResetKey, setGuestbookResetKey] = useState(0)
  const [submissionToken, setSubmissionToken] = useState<string | null>(null)
  const [submissionResetKey, setSubmissionResetKey] = useState(0)
  const turnstileConfig = useQuery(turnstileConfigQueryOptions()).data
  const directoryInput = {
    query: deferredQuery,
    include,
    exclude,
    sort,
    page,
  }
  const initialDirectory = Route.useLoaderData()
  const directoryData =
    useQuery({
      ...directoryQueryOptions(directoryInput),
      placeholderData: keepPreviousData,
    }).data ?? initialDirectory
  const popularData = useQuery({
    ...popularQueryOptions(popularPage),
    placeholderData: keepPreviousData,
  }).data!
  const guestbookMutation = useMutation({
    mutationFn: (input: {
      name: string
      message: string
      hp?: string
      turnstileToken: string
    }) => signGuestbook({ data: input }),
  })
  const submissionMutation = useMutation({
    mutationFn: (form: FormData) => submitSiteMutation({ data: form }),
  })
  const surpriseMutation = useMutation({
    mutationFn: () =>
      getPublicSurprise({
        data: { query: deferredQuery, include, exclude },
      }),
  })
  const { toggleVote, isVoted, isPendingFor, challenge } = useSiteVote({
    setNotice,
    setNoticeError,
  })
  const submitPending = submissionMutation.isPending

  useEffect(() => {
    const storedSort = window.localStorage.getItem(sortStorageKey)
    if (storedSort && sortModes.includes(storedSort as SortMode)) {
      setSort(storedSort as SortMode)
    }
    setSortLoaded(true)
  }, [])

  useEffect(() => {
    if (sortLoaded) window.localStorage.setItem(sortStorageKey, sort)
  }, [sort, sortLoaded])

  const matchingSiteCount = directoryData.total
  const pageCount = Math.max(1, Math.ceil(matchingSiteCount / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleSites = directoryData.sites
  const popularPageCount = Math.max(1, Math.ceil(popularData.total / 4))
  const safePopularPage = Math.min(popularPage, popularPageCount - 1)
  const visiblePopular = popularData.sites

  function setFilterTags(type: 'include' | 'exclude', nextTags: string[]) {
    const nextInclude =
      type === 'include'
        ? nextTags
        : include.filter((tag) => !nextTags.includes(tag))
    const nextExclude =
      type === 'exclude'
        ? nextTags
        : exclude.filter((tag) => !nextTags.includes(tag))
    startTransition(() => {
      setPage(0)
      navigate({
        search: {
          include: nextInclude.length ? nextInclude : undefined,
          exclude: nextExclude.length ? nextExclude : undefined,
        },
      })
    })
  }

  function toggleIncludedTag(tag: string) {
    setFilterTags(
      'include',
      include.includes(tag)
        ? include.filter((item) => item !== tag)
        : [...include, tag],
    )
  }

  function addExcludedTag(tag: string) {
    setFilterTags(
      'exclude',
      exclude.includes(tag) ? exclude : [...exclude, tag],
    )
  }

  function clearTagFilters() {
    startTransition(() => {
      setPage(0)
      navigate({ search: {} })
    })
  }

  function changeDirectoryPage(nextPage: number) {
    startTransition(() => setPage(nextPage))
  }

  function changePopularPage(nextPage: number) {
    startTransition(() => setPopularPage(nextPage))
  }

  async function surprise() {
    setNotice('')
    setNoticeError(false)
    try {
      const site = await surpriseMutation.mutateAsync()
      if (!site) {
        setNotice('No matching sites are available to surprise you.')
        setNoticeError(true)
        return
      }
      navigate({ to: '/sites/$slug', params: { slug: site.slug } })
    } catch {
      setNotice('Could not find a surprise site. Please try again.')
      setNoticeError(true)
    }
  }

  async function addGuestbookEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNotice('')
    setNoticeError(false)
    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('name') || '').trim()
    const message = String(formData.get('message') || '').trim()
    const hp = String(formData.get('message_hp') || '')
    if (!name || !message) return
    if (!guestbookToken) {
      setNotice('Complete the verification check before signing.')
      setNoticeError(true)
      return
    }
    setNotice('')
    setNoticeError(false)
    try {
      await guestbookMutation.mutateAsync({
        name,
        message,
        hp,
        turnstileToken: guestbookToken,
      })
      await queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] })
      form.reset()
      setGuestbookToken(null)
      setGuestbookResetKey((key) => key + 1)
      setNotice('Your guestbook note was added.')
    } catch (error) {
      setGuestbookToken(null)
      setGuestbookResetKey((key) => key + 1)
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not sign the guestbook.',
      )
      setNoticeError(true)
    }
  }

  async function submitSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    removeEmptyFile(formData, 'image')
    if (!submissionToken) {
      setNotice('Complete the verification check before submitting.')
      setNoticeError(true)
      return
    }
    formData.set('turnstileToken', submissionToken)
    const name = String(formData.get('name') || 'Your site')

    setNotice('')
    setNoticeError(false)

    try {
      const result: unknown = await submissionMutation.mutateAsync(formData)
      if (!isSubmittedSite(result)) {
        throw new Error('The submission was not accepted.')
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
      ])
      setNotice(`${name} was submitted for review.`)
      setSubmitOpen(false)
      form.reset()
      setSubmissionToken(null)
      setSubmissionResetKey((key) => key + 1)
    } catch (error) {
      setSubmissionToken(null)
      setSubmissionResetKey((key) => key + 1)
      setNotice(
        error instanceof Error
          ? error.message
          : 'The submission could not be saved.',
      )
      setNoticeError(true)
    }
  }

  return (
    <PageShell>
      <SiteHeader />
      <section
        className="odd-shell mt-3 border border-ink bg-paper p-3"
        data-od-id="hero-section"
      >
        <div className="grid items-stretch gap-3 md:grid-cols-[1.35fr_.65fr]">
          <div className="border border-ink bg-rust px-4 py-3 text-white">
            <p className="mb-1 font-mono text-xs font-bold tracking-[0.08em] uppercase">
              No Algorithms, No Feeds
            </p>
            <h1 className="mb-1 font-mono text-[clamp(29px,5vw,44px)] leading-none font-bold tracking-[-0.04em]">
              Oddweb Directory
            </h1>
            <p className="m-0 max-w-2xl leading-relaxed">
              A directory of one-of-a-kind websites made to surprise, delight,
              teach, distract, or simply do something different.
            </p>
          </div>
          <div
            className="border border-dotted border-brown bg-canvas p-2.5"
            data-od-id="search-control"
          >
            <FieldLabel htmlFor="search">Find a site</FieldLabel>
            <input
              id="search"
              type="search"
              value={query}
              maxLength={publicDirectorySearchMaxLength}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
              }}
              className={fieldClass}
              autoComplete="off"
              placeholder="What do you feel like finding?"
              data-od-id="search-input"
            />
          </div>
        </div>
      </section>

      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-2 mb-4 border border-ink bg-paper p-2.5"
        data-od-id="directory-section"
      >
        <div className="mb-2.5 flex min-h-12 flex-wrap items-center justify-end gap-1.5 border border-dotted border-brown bg-canvas p-1.5">
          <div className="flex flex-wrap gap-1.5">
            <Link
              to="/tags"
              search={{
                include: include.length ? include : undefined,
                exclude: exclude.length ? exclude : undefined,
              }}
              className={buttonClass}
              data-od-id="browse-tags"
            >
              Tag List
            </Link>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setNotice('')
                setNoticeError(false)
                setSubmitOpen(true)
              }}
              data-od-id="submit-button"
            >
              Submit a Site
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={surprise}
              disabled={surpriseMutation.isPending}
              aria-busy={surpriseMutation.isPending}
              data-od-id="shuffle-button"
            >
              {surpriseMutation.isPending ? 'Finding a site...' : 'Surprise Me'}
            </button>
          </div>
        </div>

        {include.length || exclude.length ? (
          <div className="mb-2.5 flex flex-col justify-between gap-2 border border-ink bg-canvas p-2 sm:flex-row sm:items-center">
            <p className="m-0 font-mono text-xs text-brown">
              Filtering by {include.length} included and {exclude.length}{' '}
              excluded tags.
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
              <button
                type="button"
                className={buttonClass}
                onClick={clearTagFilters}
              >
                Clear
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p
            className={`mb-2 border bg-canvas px-2 py-1.5 font-mono text-xs ${noticeError ? 'border-danger text-danger' : 'border-success'}`}
            role={noticeError ? 'alert' : 'status'}
          >
            {notice}
          </p>
        ) : null}

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
              <p
                className="m-0 font-mono text-xs text-muted"
                aria-live="polite"
              >
                {matchingSiteCount} {matchingSiteCount === 1 ? 'site' : 'sites'}
              </p>
              <label className="inline-flex items-center gap-2 font-mono text-xs font-bold">
                Order
                <select
                  value={sort}
                  onChange={(event) => {
                    startTransition(() => {
                      setSort(event.target.value as SortMode)
                      setPage(0)
                    })
                  }}
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

          {visibleSites.length ? (
            <div>
              {visibleSites.map((site) => (
                <SiteRow
                  key={site.slug}
                  site={site}
                  includedTags={include}
                  excludedTags={exclude}
                  onInclude={toggleIncludedTag}
                  onExclude={addExcludedTag}
                  voted={isVoted(site.slug)}
                  votePending={isPendingFor(site.slug)}
                  onVote={toggleVote}
                />
              ))}
            </div>
          ) : (
            <div
              className="my-3 border border-dashed border-line bg-paper p-8 text-center"
              data-od-id="empty-state"
            >
              <h3 className="mb-1 font-mono font-bold">No sites found.</h3>
              <p className="mb-3 text-brown">
                Remove a tag or try fewer words.
              </p>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  setQuery('')
                  clearTagFilters()
                }}
              >
                Show everything
              </button>
            </div>
          )}

          <Pagination
            page={safePage}
            pageCount={pageCount}
            onPageChange={changeDirectoryPage}
            label="Directory pages"
            focusTargetId="catalog-title"
          />
        </section>

        <div className="mt-2.5 grid gap-2.5">
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
              {visiblePopular.map((site, index) => (
                <li
                  key={site.slug}
                  className="min-h-24 border-t border-dotted border-muted px-0 py-3 sm:border-r sm:px-4 sm:first:border-t-0 sm:nth-[2]:border-t-0 sm:nth-[even]:border-r-0"
                >
                  <span className="block font-mono text-xs text-muted">
                    {String(popularPage * 4 + index + 1).padStart(2, '0')}
                  </span>
                  <Link
                    to="/sites/$slug"
                    params={{ slug: site.slug }}
                    className="font-mono font-bold underline-offset-4 hover:text-rust"
                  >
                    {site.name}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-muted">
                    {site.visits} {site.visits === 1 ? 'view' : 'views'}
                  </span>
                  <p className="mt-1 mb-0 text-sm text-brown">
                    {site.description}
                  </p>
                </li>
              ))}
            </ol>
            <Pagination
              page={safePopularPage}
              pageCount={popularPageCount}
              onPageChange={changePopularPage}
              label="Most viewed pages"
              focusTargetId="most-opened-results"
            />
          </Panel>

          <Panel title="Recently added" label="NEWEST SUBMISSIONS">
            <ol className="m-0 grid list-none gap-1 p-0 sm:grid-cols-3">
              {communityFilings.slice(0, 6).map((filing) => (
                <li
                  key={filing.url}
                  className="border-t border-dotted border-muted py-2 first:border-t-0 sm:border-t-0 sm:border-l sm:px-3 sm:nth-[3n+1]:border-l-0"
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
                    className="font-mono font-bold underline-offset-4 hover:text-rust"
                  >
                    {filing.name}
                  </a>
                  <span className="ml-2 font-mono text-xs text-muted">
                    <LocalTime
                      seconds={filing.submittedAt}
                      fallback={filing.date}
                    />
                  </span>
                  <p className="mt-1 mb-0 text-sm text-brown">
                    {filing.description}
                  </p>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Guestbook" label="NEWEST VISITORS">
            <div className="grid gap-4 md:grid-cols-[.8fr_1.2fr]">
              <div>
                <form
                  className="grid gap-1.5"
                  onSubmit={addGuestbookEntry}
                  data-od-id="guestbook-form"
                >
                  <fieldset
                    disabled={guestbookMutation.isPending}
                    className="m-0 grid min-w-0 gap-1.5 border-0 p-0"
                  >
                    <label className="font-mono text-xs font-bold">
                      Name / alias
                      <input
                        name="name"
                        required
                        maxLength={24}
                        className={`${fieldClass} mt-1`}
                        placeholder="Your screen name"
                      />
                    </label>
                    <label className="font-mono text-xs font-bold">
                      Short note
                      <input
                        name="message"
                        required
                        maxLength={120}
                        className={`${fieldClass} mt-1`}
                        placeholder="What did you discover?"
                      />
                    </label>
                    <input
                      type="text"
                      name="message_hp"
                      tabIndex={-1}
                      autoComplete="off"
                      className="hidden sr-only"
                      aria-hidden="true"
                    />
                    <Turnstile
                      sitekey={turnstileConfig?.sitekey ?? ''}
                      action={turnstileActions.guestbook}
                      disabled={guestbookMutation.isPending}
                      resetKey={guestbookResetKey}
                      onToken={setGuestbookToken}
                    />
                    <button className={buttonClass} type="submit">
                      {guestbookMutation.isPending
                        ? 'Signing...'
                        : 'Sign the wall'}
                    </button>
                  </fieldset>
                </form>
                <p className="mt-2 mb-0 text-sm text-brown">
                  Name what you clicked, then leave a sentence for the next
                  person.
                </p>
              </div>
              <ul className="m-0 list-none p-0 font-mono text-xs">
                {guestbook.map((entry) => (
                  <li
                    key={`${entry.name}-${entry.message}`}
                    className="grid grid-cols-[1fr_auto] gap-x-2 border-t border-dotted border-muted py-1.5 first:border-t-0"
                  >
                    <strong>{entry.name}</strong>
                    <span className="text-muted">
                      <LocalTime
                        seconds={entry.createdAt}
                        fallback={entry.date}
                      />
                    </span>
                    <span className="col-span-2 text-brown">
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        </div>
      </main>
      <SiteFooter />

      {submitOpen ? (
        <ModalDialog
          labelledBy="submit-title"
          onClose={() => setSubmitOpen(false)}
          closeDisabled={submitPending}
        >
          <form
            className="my-auto w-full max-w-xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
            onSubmit={submitSite}
            data-od-id="submit-dialog"
          >
            <input
              type="text"
              name="homepage_hp"
              tabIndex={-1}
              autoComplete="off"
              className="hidden sr-only"
              aria-hidden="true"
            />
            <div className="mb-2.5 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
              <h2
                id="submit-title"
                className="m-0 font-mono text-sm font-bold tracking-wide uppercase"
              >
                Submit a site
              </h2>
              <button
                type="button"
                className={`${buttonClass} min-w-11 px-0`}
                onClick={() => setSubmitOpen(false)}
                disabled={submitPending}
                aria-label="Close"
              >
                X
              </button>
            </div>
            <fieldset
              disabled={submitPending}
              className="m-0 min-w-0 border-0 p-0"
            >
              <SubmitField
                label="Site name"
                name="name"
                placeholder="Enter the site's name"
                maxLength={40}
                autoFocus
              />
              <SubmitField
                label="Website address"
                name="url"
                type="url"
                placeholder="https://"
              />
              <div className="mb-2">
                <FieldLabel htmlFor="submit-image">
                  Site preview image
                </FieldLabel>
                <div className="border border-dotted border-brown bg-canvas p-2">
                  <input
                    id="submit-image"
                    name="image"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="w-full"
                  />
                  <small className="mt-1 block text-muted">
                    Optional. PNG, JPEG, or WebP, up to 8 MB.
                  </small>
                </div>
              </div>
              <div className="mb-2">
                <TagInput
                  label="Tags"
                  name="tags"
                  required
                  placeholder="Try sound, wander, useless..."
                />
              </div>
              <div className="mb-2">
                <FieldLabel htmlFor="submit-description">
                  Short description
                </FieldLabel>
                <textarea
                  id="submit-description"
                  name="description"
                  required
                  maxLength={200}
                  rows={3}
                  className={`${fieldClass} resize-y`}
                  placeholder="What happens when you click?"
                />
              </div>
              <div className="mb-2">
                <Turnstile
                  sitekey={turnstileConfig?.sitekey ?? ''}
                  action={turnstileActions.submission}
                  disabled={submitPending}
                  resetKey={submissionResetKey}
                  onToken={setSubmissionToken}
                />
              </div>
              {noticeError ? (
                <p
                  className="mb-2 border border-danger bg-canvas px-2 py-1.5 font-mono text-xs text-danger"
                  role="alert"
                >
                  {notice}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setSubmitOpen(false)}
                  disabled={submitPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={primaryButtonClass}
                  disabled={submitPending}
                >
                  {submitPending ? 'Submitting...' : 'Submit site'}
                </button>
              </div>
            </fieldset>
          </form>
        </ModalDialog>
      ) : null}

      {challenge ? <VoteChallengeDialog challenge={challenge} /> : null}
    </PageShell>
  )
}

function SiteRow({
  site,
  includedTags,
  excludedTags,
  onInclude,
  onExclude,
  voted,
  votePending,
  onVote,
}: {
  site: SiteEntry
  includedTags: string[]
  excludedTags: string[]
  onInclude: (tag: string) => void
  onExclude: (tag: string) => void
  voted: boolean
  votePending: boolean
  onVote: (slug: string) => void
}) {
  const allTags = site.tags

  return (
    <article
      className="grid min-h-28 grid-cols-[82px_minmax(0,1fr)] border-b border-dotted border-muted hover:bg-canvas sm:grid-cols-[104px_minmax(0,1fr)]"
      data-od-id={`site-card-${site.slug}`}
    >
      <div className="my-3 mr-2 sm:mr-2.5">
        <SiteThumbnail site={site} />
      </div>
      <div className="py-2.5">
        <h3 className="m-0 font-mono text-base leading-snug font-bold">
          <Link
            id={`site-${site.slug}`}
            to="/sites/$slug"
            params={{ slug: site.slug }}
            className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-rust"
          >
            {site.name}
          </Link>
        </h3>
        <p className="m-0 text-brown">{site.description}</p>
        <CardTagPages
          siteName={site.name}
          tags={allTags}
          includedTags={includedTags}
          excludedTags={excludedTags}
          onInclude={onInclude}
          onExclude={onExclude}
          labels={site.tagLabels || {}}
        />
        <div className="mt-1.5 flex gap-2 font-mono text-xs text-muted">
          <span>
            {site.visits} {site.visits === 1 ? 'view' : 'views'}
          </span>
          <span aria-hidden="true">/</span>
          <span>
            Added{' '}
            <LocalTime seconds={site.addedAt} fallback={site.addedLabel} />
          </span>
          <button
            type="button"
            className={`ml-auto inline-flex min-h-8 shrink-0 items-center gap-1 border px-2 font-mono text-xs transition-transform duration-100 active:scale-95 cursor-pointer disabled:cursor-not-allowed ${
              voted
                ? 'border-success bg-green-50 text-success shadow-[1px_1px_0_#2b7a4b]'
                : 'border-brown bg-paper text-brown hover:bg-warm shadow-[1px_1px_0_#d9aa7a]'
            }`}
            aria-pressed={voted}
            aria-label={`Vote for ${site.name}`}
            title={voted ? 'Remove your vote' : `Vote for ${site.name}`}
            onClick={() => onVote(site.slug)}
            disabled={votePending}
            data-od-id={`vote-button-${site.slug}`}
          >
            {voted ? 'Voted' : 'Vote'} &uarr; {site.votes}
          </button>
        </div>
      </div>
    </article>
  )
}

function CardTagPages({
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
              aria-pressed={includedTags.includes(siteTag)}
              title={`Include ${labels[siteTag] || siteTag.replace(/^~/, '')}`}
              onClick={() => onInclude(siteTag)}
              className={`min-h-8 shrink-0 border border-l-0 px-2 font-mono text-xs ${includedTags.includes(siteTag) ? 'border-success bg-green-50 text-success' : 'border-brown bg-paper hover:bg-success hover:text-white'}`}
            >
              +
            </button>
            <button
              type="button"
              aria-label={`Exclude ${labels[siteTag] || siteTag.replace(/^~/, '')}`}
              aria-pressed={excludedTags.includes(siteTag)}
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

function Pagination({
  page,
  pageCount,
  onPageChange,
  label,
  focusTargetId,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  label: string
  focusTargetId?: string
}) {
  function changePage(nextPage: number) {
    onPageChange(nextPage)
    if (focusTargetId) {
      window.requestAnimationFrame(() =>
        document.getElementById(focusTargetId)?.focus(),
      )
    }
  }

  return (
    <nav
      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-dotted border-muted pt-2.5"
      aria-label={label}
    >
      <button
        type="button"
        className={buttonClass}
        disabled={page === 0}
        onClick={() => changePage(page - 1)}
      >
        Previous
      </button>
      <span
        className="order-first w-full text-center font-mono text-xs text-muted sm:order-none sm:w-auto"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Page {page + 1} of {pageCount}
      </span>
      <button
        type="button"
        className={buttonClass}
        disabled={page >= pageCount - 1}
        onClick={() => changePage(page + 1)}
      >
        Next
      </button>
    </nav>
  )
}

function SubmitField({
  label,
  name,
  type = 'text',
  placeholder,
  maxLength,
  autoFocus = false,
}: {
  label: string
  name: string
  type?: string
  placeholder: string
  maxLength?: number
  autoFocus?: boolean
}) {
  return (
    <div className="mb-2">
      <FieldLabel htmlFor={`submit-${name}`}>{label}</FieldLabel>
      <input
        id={`submit-${name}`}
        name={name}
        type={type}
        required
        maxLength={maxLength}
        className={fieldClass}
        placeholder={placeholder}
        data-dialog-initial-focus={autoFocus || undefined}
      />
    </div>
  )
}

function isSubmittedSite(value: unknown): value is { submitted: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'submitted' in value &&
    value.submitted === true
  )
}

function removeEmptyFile(data: FormData, name: string) {
  const value = data.get(name)
  if (value === '' || (value instanceof File && value.size === 0)) {
    data.delete(name)
  }
}
