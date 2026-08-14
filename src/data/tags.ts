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
  aliases: Object.entries(aliases)
    .filter(([, canonical]) => canonical === slug)
    .map(([alias]) => alias),
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

export function canonicalizeTagList(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : []

  return [
    ...new Set(
      values
        .map((tag) =>
          typeof tag === 'string' ? getCanonicalTag(tag)?.slug : undefined,
        )
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ]
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
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ]
}

export function siteFilterTags(site: SiteEntry) {
  return expandedFilterTags(site.tags)
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
  const pending = [...direct]

  while (pending.length) {
    const current = pending.pop()
    if (!current) continue
    const parents = catalog.find((tag) => tag.slug === current)?.parents || []
    for (const parent of parents) {
      if (!direct.has(parent)) {
        direct.add(parent)
        pending.push(parent)
      }
    }
  }

  return direct
}

export function siteMatchesTag(site: SiteEntry, tag: string) {
  return siteFilterTags(site).has(resolveTagSlug(tag))
}

export function siteMatchesFilterTag(
  site: SiteEntry,
  tag: string,
  catalog = canonicalTags,
) {
  return tagsMatchFilter(site.tags, tag, catalog)
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

export function tagLabel(value: string, catalog = canonicalTags) {
  return (
    getCanonicalTag(value.startsWith('~') ? value.slice(1) : value, catalog)
      ?.name || normalizeTag(value.startsWith('~') ? value.slice(1) : value)
  )
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
