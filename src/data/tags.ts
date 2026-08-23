import { recentFilings, sites } from './sites'

import type { SiteEntry } from './sites'

export type CanonicalTag = {
  id?: number
  slug: string
  name: string
  aliases: string[]
  parents: string[]
  count: number
  canonical?: boolean
  directCount?: number
}

export const publicFilterTagLimit = 20
export const tagInputMaxLength = 80
export const publicDirectorySearchMaxLength = 120
export const publicTagSearchMaxLength = 80

export type PublicFilterSearch = {
  include?: string[]
  exclude?: string[]
}

const aliases: Partial<Record<string, string>> = {
  audio: 'listen',
  experiment: 'experiments',
  game: 'games',
  map: 'maps',
  picture: 'photo',
  relaxing: 'calm',
  sounds: 'sound',
  view: 'views',
}

const parentTags: Partial<Record<string, string[]>> = {
  ambient: ['listen'],
  games: ['play'],
  keyboard: ['play'],
  maps: ['wander'],
  music: ['listen'],
  noise: ['listen'],
  radio: ['listen'],
  rain: ['listen'],
  sound: ['listen'],
  street: ['wander'],
  surreal: ['odd'],
  surprise: ['odd'],
  travel: ['wander'],
  useless: ['odd'],
  video: ['wander'],
  views: ['wander'],
  weird: ['odd'],
  windows: ['wander'],
  world: ['wander'],
}

const rawTags = [
  ...sites.flatMap((site) => site.tags),
  ...recentFilings.flatMap((filing) => filing.tags),
]

const canonicalSlugs = [...new Set(rawTags.map(seedResolveTagSlug))].sort(
  (a, b) => a.localeCompare(b),
)

const tagsWithoutCounts = canonicalSlugs.map((slug) => ({
  slug,
  name: displayTagName(slug),
  aliases: Object.entries(aliases).flatMap(([alias, canonical]) =>
    canonical === slug ? [alias] : [],
  ),
  parents: parentTags[slug] || [],
}))

const seedCatalog: CanonicalTag[] = tagsWithoutCounts.map((tag) => ({
  ...tag,
  count: 0,
}))
export const canonicalTags: CanonicalTag[] = buildCanonicalTags(
  sites,
  seedCatalog,
)

export function normalizeTag(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function tagSlug(value: string) {
  return normalizeTag(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function resolveTagSlug(value: string, catalog = canonicalTags) {
  const normalized = normalizeTag(value)
  const match = catalog.find(
    (tag) =>
      tag.slug === tagSlug(normalized) ||
      normalizeTag(tag.name) === normalized ||
      tag.aliases.includes(normalized),
  )
  return match?.slug || tagSlug(normalized)
}

export function getCanonicalTag(value: string, catalog = canonicalTags) {
  return catalog.find((tag) => tag.slug === resolveTagSlug(value, catalog))
}

export function normalizeFilterTagList(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : []

  return [
    ...new Set(
      values
        .map((item) => {
          if (typeof item !== 'string') return undefined
          const raw = normalizeTag(item.startsWith('~') ? item.slice(1) : item)
          if (!raw) return undefined
          return item.startsWith('~') ? `~${raw}` : raw
        })
        .filter((tag): tag is string => {
          if (!tag) return false
          return (
            (tag.startsWith('~') ? tag.slice(1) : tag).length <=
            tagInputMaxLength
          )
        }),
    ),
  ].slice(0, publicFilterTagLimit)
}

export function normalizePublicFilterSearch(
  search: Record<string, unknown>,
): PublicFilterSearch {
  const include = normalizeFilterTagList(search.include)
  const exclude = normalizeFilterTagList(search.exclude).filter(
    (tag) => !include.includes(tag),
  )
  return {
    include: include.length ? include : undefined,
    exclude: exclude.length ? exclude : undefined,
  }
}

export function publicFilterLoaderDeps(search: PublicFilterSearch) {
  return {
    include: search.include ?? [],
    exclude: search.exclude ?? [],
  }
}

export function resolveFilterTagList(
  values: string[],
  catalog: CanonicalTag[],
) {
  return [
    ...new Set(
      values.map((value) => {
        const raw = value.startsWith('~') ? value.slice(1) : value
        return getCanonicalTag(raw, catalog)?.slug || `~${normalizeTag(raw)}`
      }),
    ),
  ]
}

export function tagsMatchFilter(
  tags: string[],
  tag: string,
  catalog = canonicalTags,
) {
  if (tag.startsWith('~')) {
    const raw = normalizeTag(tag.slice(1))
    return tags.some(
      (siteTag) =>
        normalizeTag(siteTag.startsWith('~') ? siteTag.slice(1) : siteTag) ===
        raw,
    )
  }

  return expandedFilterTags(tags, catalog).has(resolveTagSlug(tag, catalog))
}

export function tagTokensFromNames(tags: string[], catalog = canonicalTags) {
  return tags.map(
    (tag) =>
      getCanonicalTag(tag, catalog)?.slug ||
      `~${normalizeTag(tag.startsWith('~') ? tag.slice(1) : tag)}`,
  )
}

function expandedFilterTags(tags: string[], catalog = canonicalTags) {
  const direct = new Set(
    tags.map((tag) =>
      tag.startsWith('~') ? tag : resolveTagSlug(tag, catalog),
    ),
  )
  const parentsBySlug = new Map(
    catalog.map((tag) => [tag.slug, tag.parents] as const),
  )
  const pending = [...direct]

  while (pending.length) {
    const current = pending.pop()
    if (!current) continue
    const parents = parentsBySlug.get(current) || []
    for (const parent of parents) {
      if (!direct.has(parent)) {
        direct.add(parent)
        pending.push(parent)
      }
    }
  }

  return direct
}

export function buildCanonicalTags(
  siteEntries: SiteEntry[],
  catalog = canonicalTags,
) {
  return catalog.map((tag) => ({
    ...tag,
    count: siteEntries.filter((site) =>
      tagsMatchFilter(site.tags, tag.slug, catalog),
    ).length,
  }))
}

export function tagsForForm(values: string[]) {
  return values.join(', ')
}

function displayTagName(slug: string) {
  if (slug === 'odd') return 'Pure Oddity'
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function seedResolveTagSlug(value: string) {
  const normalized = normalizeTag(value)
  return aliases[normalized] || tagSlug(normalized)
}
