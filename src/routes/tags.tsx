import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { startTransition, useDeferredValue, useState } from 'react'

import { TagInput } from '../components/tag-input'
import {
  PageShell,
  SiteFooter,
  SiteHeader,
  buttonClass,
  fieldClass,
} from '../components/oddweb'
import { normalizeFilterTagList } from '../data/tags'
import { tagPageQueryOptions } from '../queries/oddweb'
import {
  absoluteUrl,
  filteredRobots,
  publicRobots,
  socialMeta,
} from '../lib/seo'

type TagsSearch = {
  include?: string[]
  exclude?: string[]
}

const tagsTitle = 'Browse Website Tags | Oddweb'
const tagsDescription =
  'Browse the tags Oddweb uses to organize unusual, playful, and interactive websites by mood, medium, and activity.'

export const Route = createFileRoute('/tags')({
  validateSearch: (search): TagsSearch => {
    const include = normalizeFilterTagList(search.include)
    const exclude = normalizeFilterTagList(search.exclude).filter(
      (tag) => !include.includes(tag),
    )
    return {
      include: include.length ? include : undefined,
      exclude: exclude.length ? exclude : undefined,
    }
  },
  head: ({ match }) => ({
    meta: [
      { title: tagsTitle },
      {
        name: 'description',
        content: tagsDescription,
      },
      {
        name: 'robots',
        content:
          match.search.include?.length || match.search.exclude?.length
            ? filteredRobots
            : publicRobots,
      },
      ...socialMeta({
        title: tagsTitle,
        description: tagsDescription,
        url: absoluteUrl('/tags'),
      }),
    ],
    links: [{ rel: 'canonical', href: absoluteUrl('/tags') }],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      tagPageQueryOptions({ query: '', include: [], exclude: [], page: 0 }),
    ),
  component: TagsPage,
})

function TagsPage() {
  const { include: rawInclude = [], exclude: rawExclude = [] } =
    Route.useSearch()
  const navigate = useNavigate({ from: '/tags' })
  const include = rawInclude
  const exclude = rawExclude.filter((tag) => !include.includes(tag))
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [page, setPage] = useState(0)
  const { data: tagPage } = useSuspenseQuery(
    tagPageQueryOptions({
      query: deferredQuery,
      include,
      exclude,
      page,
    }),
  )
  const visibleTags = tagPage.tags
  const pageCount = Math.max(1, Math.ceil(tagPage.total / tagPage.pageSize))
  const safePage = Math.min(page, pageCount - 1)

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

  function clearFilters() {
    startTransition(() => {
      setPage(0)
      navigate({ search: {} })
    })
  }

  function changePage(nextPage: number) {
    startTransition(() => setPage(nextPage))
  }

  return (
    <PageShell>
      <SiteHeader directoryLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-3 mb-4 border border-ink bg-paper p-2.5"
        data-od-id="tag-index"
      >
        <section className="border border-ink bg-rust px-5 py-4 text-white">
          <p className="mb-1 font-mono text-xs font-bold tracking-[0.08em] uppercase">
            Browse by tag
          </p>
          <h1 className="m-0 mb-1.5 font-mono text-[clamp(28px,5vw,44px)] leading-none font-bold tracking-[-0.03em]">
            Find your flavor of weird
          </h1>
        </section>

        <section
          className="my-2.5 border border-ink bg-paper"
          aria-labelledby="refine-tags-title"
        >
          <div className="flex min-h-10 items-center justify-between gap-2 bg-brown px-2.5 py-1.5 text-paper">
            <h2
              id="refine-tags-title"
              className="m-0 font-mono text-sm font-bold tracking-[0.08em] uppercase"
            >
              Refine by tags
            </h2>
            <span className="font-mono text-[11px] text-warm">
              {include.length} INCLUDED / {exclude.length} EXCLUDED
            </span>
          </div>
          <div className="grid gap-3 p-2.5 md:grid-cols-2">
            <TagInput
              label="Tags to include"
              value={include}
              onChange={(tags) => setFilterTags('include', tags)}
              tone="include"
              placeholder="Include a tag..."
            />
            <TagInput
              label="Tags to exclude"
              value={exclude}
              onChange={(tags) => setFilterTags('exclude', tags)}
              tone="exclude"
              placeholder="Exclude a tag..."
            />
          </div>
          <div className="flex flex-col justify-between gap-2 border-t border-dotted border-line bg-canvas px-2.5 py-2 sm:flex-row sm:items-center">
            <p className="m-0 font-mono text-xs text-brown">
              {tagPage.matchingSiteCount} matching{' '}
              {tagPage.matchingSiteCount === 1 ? 'site' : 'sites'}. Includes use
              AND; exclusions use OR.
            </p>
            <div className="flex gap-1.5">
              {include.length || exclude.length ? (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              ) : null}
              <Link
                to="/"
                search={{
                  include: include.length ? include : undefined,
                  exclude: exclude.length ? exclude : undefined,
                }}
                className={buttonClass}
              >
                View matching sites
              </Link>
            </div>
          </div>
        </section>

        <div className="mb-2.5">
          <label htmlFor="tag-search" className="sr-only">
            Search tags
          </label>
          <input
            id="tag-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
            autoComplete="off"
            className={`${fieldClass} bg-canvas`}
            placeholder="Search tags, e.g. sound, wander, useless..."
          />
        </div>

        <p
          className="mb-2 font-mono text-xs tracking-[0.06em] text-muted uppercase"
          aria-live="polite"
        >
          {tagPage.total} {tagPage.total === 1 ? 'tag' : 'tags'}
        </p>

        {visibleTags.length ? (
          <div
            className="grid grid-cols-1 gap-px border border-ink bg-line min-[581px]:grid-cols-2"
            data-od-id="tag-list"
          >
            {visibleTags.map((tag) => (
              <article key={tag.slug} className="min-w-0 bg-canvas p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="m-0 font-mono text-sm font-bold">
                    {tag.name}
                  </h2>
                  <span className="shrink-0 font-mono text-xs text-muted">
                    {tag.count} {tag.count === 1 ? 'site' : 'sites'}
                  </span>
                </div>
                <p className="my-1 min-h-5 text-xs text-muted">
                  {tag.aliases.length
                    ? `Synonyms: ${tag.aliases.join(', ')}`
                    : 'Canonical tag'}
                </p>
                {tag.parents.length ? (
                  <p className="my-1 font-mono text-[11px] text-brown">
                    Subtag of{' '}
                    {tag.parents
                      .map((parent) => tagPage.tagLabels[parent] || parent)
                      .join(', ')}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className={buttonClass}
                    aria-pressed={include.includes(tag.slug)}
                    onClick={() =>
                      setFilterTags(
                        'include',
                        include.includes(tag.slug)
                          ? include.filter((value) => value !== tag.slug)
                          : [...include, tag.slug],
                      )
                    }
                  >
                    {include.includes(tag.slug)
                      ? `Remove ${tag.name} filter`
                      : `Include ${tag.name}`}
                  </button>
                  <Link
                    to="/"
                    search={{ include: [tag.slug] }}
                    className={buttonClass}
                  >
                    Filter by {tag.name}
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="border border-dashed border-line bg-canvas p-6 text-center text-brown">
            No tags match that search.
          </div>
        )}
        {tagPage.total ? (
          <nav
            className="mt-3 flex items-center justify-between border-t border-dotted border-muted pt-2.5"
            aria-label="Tag list pages"
          >
            <button
              type="button"
              className={buttonClass}
              disabled={safePage === 0}
              onClick={() => changePage(safePage - 1)}
            >
              Previous
            </button>
            <span className="font-mono text-xs text-muted" aria-live="polite">
              Page {safePage + 1} of {pageCount}
            </span>
            <button
              type="button"
              className={buttonClass}
              disabled={safePage >= pageCount - 1}
              onClick={() => changePage(safePage + 1)}
            >
              Next
            </button>
          </nav>
        ) : null}
      </main>
      <SiteFooter />
    </PageShell>
  )
}
