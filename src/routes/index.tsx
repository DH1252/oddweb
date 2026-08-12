import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  useMutation,
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
  normalizeFilterTagList,
  resolveFilterTagList,
  siteMatchesFilterTag,
  tagLabel,
} from '../data/tags'
import { directoryQueryOptions } from '../queries/oddweb'
import { signGuestbook, submitSite as submitSiteMutation } from '../server/data'

import type { FormEvent } from 'react'
import type { SiteEntry } from '../data/sites'
import type { CanonicalTag } from '../data/tags'

type DirectorySearch = {
  include?: string[]
  exclude?: string[]
}

type SortMode = 'popular' | 'newest' | 'oldest' | 'tags' | 'az' | 'za'

const pageSize = 6
const sortStorageKey = 'oddweb-directory-sort'
const sortModes: SortMode[] = [
  'popular',
  'newest',
  'oldest',
  'tags',
  'az',
  'za',
]

export const Route = createFileRoute('/')({
  validateSearch: (search): DirectorySearch => {
    const include = normalizeFilterTagList(search.include)
    const exclude = normalizeFilterTagList(search.exclude).filter(
      (tag) => !include.includes(tag),
    )
    return {
      include: include.length ? include : undefined,
      exclude: exclude.length ? exclude : undefined,
    }
  },
  head: () => ({
    meta: [
      { title: 'Oddweb - Unique websites worth exploring' },
      {
        name: 'description',
        content:
          'A searchable directory of unique, playful, and unexpected websites worth exploring.',
      },
    ],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(directoryQueryOptions()),
  component: DirectoryPage,
})

function DirectoryPage() {
  const { include: rawInclude = [], exclude: rawExclude = [] } =
    Route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(directoryQueryOptions())
  const { sites, guestbook, recentFilings: communityFilings } = data
  const include = resolveFilterTagList(rawInclude, data.tagCatalog)
  const exclude = resolveFilterTagList(rawExclude, data.tagCatalog).filter(
    (tag) => !include.includes(tag),
  )
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [sort, setSort] = useState<SortMode>('popular')
  const [sortLoaded, setSortLoaded] = useState(false)
  const [page, setPage] = useState(0)
  const [popularPage, setPopularPage] = useState(0)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const guestbookMutation = useMutation({
    mutationFn: (input: { name: string; message: string }) =>
      signGuestbook({ data: input }),
  })
  const submissionMutation = useMutation({
    mutationFn: (form: FormData) => submitSiteMutation({ data: form }),
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

  const matchingSites = sites
    .filter((site) => {
      const matchesIncluded = include.every((tag) =>
        siteMatchesFilterTag(site, tag, data.tagCatalog),
      )
      const matchesExcluded = exclude.some((tag) =>
        siteMatchesFilterTag(site, tag, data.tagCatalog),
      )
      const haystack =
        `${site.name} ${site.description} ${site.tags.join(' ')}`.toLowerCase()
      return (
        matchesIncluded &&
        !matchesExcluded &&
        (!deferredQuery || haystack.includes(deferredQuery))
      )
    })
    .sort((a, b) => {
      if (sort === 'newest') return b.added.localeCompare(a.added)
      if (sort === 'oldest') return a.added.localeCompare(b.added)
      if (sort === 'tags') return b.tags.length - a.tags.length
      if (sort === 'az') return a.name.localeCompare(b.name)
      if (sort === 'za') return b.name.localeCompare(a.name)
      return b.visits - a.visits
    })

  const pageCount = Math.max(1, Math.ceil(matchingSites.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleSites = matchingSites.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  )
  const popularSites = [...sites].sort((a, b) => b.visits - a.visits)
  const popularPageCount = Math.ceil(popularSites.length / 4)
  const visiblePopular = popularSites.slice(
    popularPage * 4,
    (popularPage + 1) * 4,
  )

  function setFilterTags(type: 'include' | 'exclude', nextTags: string[]) {
    setPage(0)
    const nextInclude =
      type === 'include'
        ? nextTags
        : include.filter((tag) => !nextTags.includes(tag))
    const nextExclude =
      type === 'exclude'
        ? nextTags
        : exclude.filter((tag) => !nextTags.includes(tag))
    startTransition(() => {
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
    setPage(0)
    startTransition(() => navigate({ search: {} }))
  }

  function surprise() {
    if (!matchingSites.length) {
      setNotice('No matching sites are available to surprise you.')
      setNoticeError(true)
      return
    }
    const picked =
      matchingSites[Math.floor(Math.random() * matchingSites.length)]
    navigate({ to: '/sites/$slug', params: { slug: picked.slug } })
  }

  async function addGuestbookEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNotice('')
    setNoticeError(false)
    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('name') || '').trim()
    const message = String(formData.get('message') || '').trim()
    if (!name || !message) return
    setNotice('')
    setNoticeError(false)
    try {
      await guestbookMutation.mutateAsync({ name, message })
      await queryClient.invalidateQueries({ queryKey: ['oddweb', 'directory'] })
      form.reset()
      setNotice('Your guestbook note was added.')
    } catch (error) {
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
    const name = String(formData.get('name') || 'Your site')

    setNotice('')
    setNoticeError(false)

    try {
      await submissionMutation.mutateAsync(formData)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'directory'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
      ])
      setNotice(`${name} was added to the review pile with its R2 thumbnail.`)
      setSubmitOpen(false)
      form.reset()
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The thumbnail upload failed.',
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
              data-od-id="shuffle-button"
            >
              Surprise Me
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
              The filing cabinet
            </h2>
            <div className="flex items-center justify-between gap-3">
              <p
                className="m-0 font-mono text-xs text-muted"
                aria-live="polite"
              >
                {matchingSites.length}{' '}
                {matchingSites.length === 1 ? 'site' : 'sites'} on file
              </p>
              <label className="inline-flex items-center gap-2 font-mono text-xs font-bold">
                Order
                <select
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as SortMode)
                    setPage(0)
                  }}
                  className="min-h-11 border border-brown bg-paper px-2 text-sm shadow-[1px_1px_0_#d9aa7a]"
                  data-od-id="catalog-sort"
                >
                  <option value="popular">Most opened</option>
                  <option value="newest">Newest filed</option>
                  <option value="oldest">Oldest filed</option>
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
                  tagCatalog={data.tagCatalog}
                />
              ))}
            </div>
          ) : (
            <div
              className="my-3 border border-dashed border-line bg-paper p-8 text-center"
              data-od-id="empty-state"
            >
              <h3 className="mb-1 font-mono font-bold">
                No match in this drawer.
              </h3>
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
            onPageChange={setPage}
            label="Directory pages"
            focusTargetId="catalog-title"
          />
        </section>

        <div className="mt-2.5 grid gap-2.5">
          <Panel
            title="Most opened"
            label="DETAIL ENTRIES"
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
                    {site.visits} detail opens
                  </span>
                  <p className="mt-1 mb-0 text-sm text-brown">
                    {site.description}
                  </p>
                </li>
              ))}
            </ol>
            <Pagination
              page={popularPage}
              pageCount={popularPageCount}
              onPageChange={setPopularPage}
              label="Most opened pages"
              focusTargetId="most-opened-results"
            />
          </Panel>

          <Panel title="Recently approved" label="COMMUNITY FILINGS">
            <ol className="m-0 grid list-none gap-1 p-0 sm:grid-cols-3">
              {communityFilings.slice(0, 6).map((filing) => (
                <li
                  key={filing.url}
                  className="border-t border-dotted border-muted py-2 first:border-t-0 sm:border-t-0 sm:border-l sm:px-3 sm:first:border-l-0"
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
                    {filing.date}
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
                  <button
                    className={buttonClass}
                    type="submit"
                    disabled={guestbookMutation.isPending}
                  >
                    {guestbookMutation.isPending
                      ? 'Signing...'
                      : 'Sign the wall'}
                  </button>
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
                    <span className="text-muted">{entry.date}</span>
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
            <div className="mb-2.5 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
              <h2
                id="submit-title"
                className="m-0 font-mono text-sm font-bold tracking-wide uppercase"
              >
                File a site
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
              <FieldLabel htmlFor="submit-image">Site preview image</FieldLabel>
              <div className="border border-dotted border-brown bg-canvas p-2">
                <input
                  id="submit-image"
                  name="image"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  required
                  className="w-full"
                />
                <small className="mt-1 block text-muted">
                  PNG, JPEG, or WebP, up to 8 MB. Stored in Cloudflare R2.
                </small>
              </div>
            </div>
            <div className="mb-2">
              <TagInput
                catalog={data.tagCatalog}
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
            {noticeError ? (
              <p
                className="mb-2 border border-danger bg-canvas px-2 py-1.5 font-mono text-xs text-danger"
                role="alert"
              >
                {notice}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
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
                {submitPending ? 'Uploading to R2...' : 'Add to the pile'}
              </button>
            </div>
          </form>
        </ModalDialog>
      ) : null}
    </PageShell>
  )
}

function SiteRow({
  site,
  includedTags,
  excludedTags,
  onInclude,
  onExclude,
  tagCatalog,
}: {
  site: SiteEntry
  includedTags: string[]
  excludedTags: string[]
  onInclude: (tag: string) => void
  onExclude: (tag: string) => void
  tagCatalog: CanonicalTag[]
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
          catalog={tagCatalog}
        />
        <div className="mt-1.5 flex gap-2 font-mono text-xs text-muted">
          <span>{site.visits} detail opens</span>
          <span aria-hidden="true">/</span>
          <time dateTime={site.added}>Added {site.addedLabel}</time>
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
  catalog,
}: {
  siteName: string
  tags: string[]
  includedTags: string[]
  excludedTags: string[]
  onInclude: (tag: string) => void
  onExclude: (tag: string) => void
  catalog: CanonicalTag[]
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
            <button
              type="button"
              aria-pressed={includedTags.includes(siteTag)}
              onClick={() => onInclude(siteTag)}
              className={`min-h-8 min-w-0 max-w-36 border px-2 font-mono text-xs leading-tight whitespace-normal [overflow-wrap:anywhere] ${includedTags.includes(siteTag) ? 'border-success bg-green-50 text-success' : excludedTags.includes(siteTag) ? 'border-danger bg-red-50 text-danger' : 'border-line bg-canvas hover:bg-brown hover:text-paper'}`}
            >
              {tagLabel(siteTag, catalog)}
            </button>
            <button
              type="button"
              aria-label={`Exclude ${tagLabel(siteTag, catalog)}`}
              aria-pressed={excludedTags.includes(siteTag)}
              title={`Exclude ${tagLabel(siteTag, catalog)}`}
              onClick={() => onExclude(siteTag)}
              className="min-h-8 shrink-0 border border-l-0 border-line bg-paper px-2 font-mono text-xs text-danger hover:bg-danger hover:text-white"
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
            className="grid min-h-8 min-w-8 place-items-center border border-line bg-paper disabled:opacity-40"
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
            className="grid min-h-8 min-w-8 place-items-center border border-line bg-paper disabled:opacity-40"
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
