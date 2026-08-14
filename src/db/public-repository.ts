import { env } from 'cloudflare:workers'

import { normalizeTag } from '../data/tags'
import { ensureSeedData } from './repository'

import type { RecentFiling, SiteEntry } from '../data/sites'
import type { CanonicalTag } from '../data/tags'

export const publicDirectoryPageSize = 6
export const publicPopularPageSize = 4
export const publicTagPageSize = 16

export type PublicSortMode =
  'popular' | 'newest' | 'oldest' | 'tags' | 'az' | 'za'

export type PublicDirectoryInput = {
  query: string
  include: string[]
  exclude: string[]
  sort: PublicSortMode
  page: number
}

export type PublicDirectoryPage = {
  sites: SiteEntry[]
  total: number
  page: number
  pageSize: number
  surpriseSlug?: string
}

export type PublicPopularPage = {
  sites: SiteEntry[]
  total: number
  page: number
  pageSize: number
}

export type PublicSupportData = {
  guestbook: Array<{ id: number; name: string; message: string; date: string }>
  recentFilings: RecentFiling[]
}

export type PublicTagPage = {
  tags: CanonicalTag[]
  total: number
  page: number
  pageSize: number
  matchingSiteCount: number
  tagLabels: Record<string, string>
}

export type PublicSiteDetail = {
  site: SiteEntry
  previous: Pick<SiteEntry, 'slug' | 'name'>
  next: Pick<SiteEntry, 'slug' | 'name'>
}

export type TagSuggestionResult = {
  suggestions: CanonicalTag[]
  selected: CanonicalTag[]
}

type SiteSqlRow = {
  id: number
  slug: string
  name: string
  url: string
  description: string
  summary: string
  categories: string
  poster: string
  notes: string
  facts: string
  accent: string
  thumbnailKey: string | null
  thumbnailAlt: string | null
  visits: number
  addedAt: number
}

type TagSqlRow = {
  id: number
  slug: string
  name: string
  directCount: number
  count: number
  aliases: string
  parents: string
  parentLabels: string
}

const visibleSiteSql = `s.status = 'active'
  AND (s.source <> 'Submission' OR EXISTS (
    SELECT 1 FROM submissions submission
    WHERE submission.id = s.submission_id AND submission.status = 'approved'
  ))`

const tagClosureCte = `WITH RECURSIVE tag_descendants(root_id, tag_id) AS (
  SELECT id, id FROM tags
  UNION
  SELECT closure.root_id, relation.child_tag_id
  FROM tag_descendants closure
  JOIN tag_parents relation ON relation.parent_tag_id = closure.tag_id
)`

const siteColumns = `s.id, s.slug, s.name, s.url, s.description, s.summary,
  s.categories, s.poster, s.notes, s.facts, s.accent,
  s.thumbnail_key AS thumbnailKey, s.thumbnail_alt AS thumbnailAlt,
  s.visits, s.added_at AS addedAt`

export async function readPublicDirectoryPage(
  input: PublicDirectoryInput,
): Promise<PublicDirectoryPage> {
  await ensureSeedData()
  const filter = buildSiteFilter(input)
  const order = directoryOrder[input.sort]
  const offset = input.page * publicDirectoryPageSize
  const [countResult, siteResult, surpriseResult] = await Promise.all([
    env.DB.prepare(
      `${tagClosureCte} SELECT count(*) AS total FROM sites s WHERE ${filter.sql}`,
    )
      .bind(...filter.bindings)
      .first<{ total: number }>(),
    env.DB.prepare(
      `${tagClosureCte} SELECT ${siteColumns} FROM sites s
       WHERE ${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
      .bind(...filter.bindings, publicDirectoryPageSize, offset)
      .all<SiteSqlRow>(),
    env.DB.prepare(
      `${tagClosureCte} SELECT s.slug FROM sites s WHERE ${filter.sql}
       ORDER BY random() LIMIT 1`,
    )
      .bind(...filter.bindings)
      .first<{ slug: string }>(),
  ])
  return {
    sites: await hydrateSiteRows(siteResult.results),
    total: countResult?.total || 0,
    page: input.page,
    pageSize: publicDirectoryPageSize,
    surpriseSlug: surpriseResult?.slug,
  }
}

export async function readPublicPopularPage(
  page: number,
): Promise<PublicPopularPage> {
  await ensureSeedData()
  const [count, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT count(*) AS total FROM sites s WHERE ${visibleSiteSql}`,
    ).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT ${siteColumns} FROM sites s WHERE ${visibleSiteSql}
       ORDER BY s.visits DESC, s.name ASC, s.id ASC LIMIT ? OFFSET ?`,
    )
      .bind(publicPopularPageSize, page * publicPopularPageSize)
      .all<SiteSqlRow>(),
  ])
  return {
    sites: await hydrateSiteRows(rows.results),
    total: count?.total || 0,
    page,
    pageSize: publicPopularPageSize,
  }
}

export async function readPublicSupportData(): Promise<PublicSupportData> {
  await ensureSeedData()
  const [guestbook, filings] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, message, created_at AS createdAt FROM guestbook
       WHERE hidden_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 5`,
    ).all<{ id: number; name: string; message: string; createdAt: number }>(),
    env.DB.prepare(
      `SELECT submission.name, submission.url, submission.description,
              submission.tags, submission.thumbnail_key AS thumbnailKey,
              submission.thumbnail_alt AS thumbnailAlt,
              submission.submitted_at AS submittedAt
       FROM submissions submission
       JOIN sites s ON s.submission_id = submission.id AND s.status = 'active'
       WHERE submission.status = 'approved'
       ORDER BY submission.submitted_at DESC, submission.id DESC LIMIT 6`,
    ).all<{
      name: string
      url: string
      description: string
      tags: string
      thumbnailKey: string | null
      thumbnailAlt: string | null
      submittedAt: number
    }>(),
  ])
  return {
    guestbook: guestbook.results.map((entry) => ({
      id: entry.id,
      name: entry.name,
      message: entry.message,
      date: formatShortDate(entry.createdAt),
    })),
    recentFilings: filings.results.map((filing) => ({
      name: filing.name,
      url: filing.url,
      description: filing.description,
      tags: parseJson<string[]>(filing.tags, []),
      date: formatShortDate(filing.submittedAt),
      thumbnailKey: filing.thumbnailKey || undefined,
      thumbnailAlt: filing.thumbnailAlt || undefined,
    })),
  }
}

export async function readPublicTagPage(input: {
  query: string
  include: string[]
  exclude: string[]
  page: number
}): Promise<PublicTagPage> {
  await ensureSeedData()
  const query = normalizeTag(input.query)
  const search = query ? `%${escapeLike(query)}%` : ''
  const tagWhere = query
    ? `AND (lower(tag.name) LIKE ? ESCAPE '\\' OR lower(tag.slug) LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM tag_aliases searched_alias
         WHERE searched_alias.tag_id = tag.id AND lower(searched_alias.alias) LIKE ? ESCAPE '\\'
       ))`
    : ''
  const tagBindings = query ? [search, search, search] : []
  const filter = buildSiteFilter({
    query: '',
    include: input.include,
    exclude: input.exclude,
    sort: 'popular',
    page: 0,
  })
  const [count, tagCount, tags] = await Promise.all([
    env.DB.prepare(
      `${tagClosureCte} SELECT count(*) AS total FROM sites s WHERE ${filter.sql}`,
    )
      .bind(...filter.bindings)
      .first<{ total: number }>(),
    env.DB.prepare(
      `SELECT count(*) AS total FROM tags tag WHERE tag.canonical = 1 ${tagWhere}`,
    )
      .bind(...tagBindings)
      .first<{ total: number }>(),
    env.DB.prepare(
      `WITH RECURSIVE inherited(tag_id, site_id) AS (
         SELECT assignment.tag_id, assignment.site_id
         FROM site_tags assignment JOIN sites s ON s.id = assignment.site_id
         WHERE ${visibleSiteSql}
         UNION
         SELECT relation.parent_tag_id, inherited.site_id
         FROM inherited JOIN tag_parents relation ON relation.child_tag_id = inherited.tag_id
       )
       SELECT tag.id, tag.slug, tag.name,
         coalesce((SELECT count(DISTINCT assignment.site_id) FROM site_tags assignment JOIN sites s ON s.id = assignment.site_id WHERE assignment.tag_id = tag.id AND ${visibleSiteSql}), 0) AS directCount,
         coalesce((SELECT count(DISTINCT inherited.site_id) FROM inherited WHERE inherited.tag_id = tag.id), 0) AS count,
         coalesce((SELECT json_group_array(alias.alias) FROM tag_aliases alias WHERE alias.tag_id = tag.id), '[]') AS aliases,
         coalesce((SELECT json_group_array(parent.slug) FROM tag_parents relation JOIN tags parent ON parent.id = relation.parent_tag_id WHERE relation.child_tag_id = tag.id), '[]') AS parents,
         coalesce((SELECT json_group_object(parent.slug, parent.name) FROM tag_parents relation JOIN tags parent ON parent.id = relation.parent_tag_id WHERE relation.child_tag_id = tag.id), '{}') AS parentLabels
       FROM tags tag WHERE tag.canonical = 1 ${tagWhere}
       ORDER BY lower(tag.name), tag.id LIMIT ? OFFSET ?`,
    )
      .bind(...tagBindings, publicTagPageSize, input.page * publicTagPageSize)
      .all<TagSqlRow>(),
  ])
  const tagLabels: Record<string, string> = {}
  const pageTags = tags.results.map((tag) => {
    tagLabels[tag.slug] = tag.name
    Object.assign(
      tagLabels,
      parseJson<Record<string, string>>(tag.parentLabels, {}),
    )
    return {
      id: tag.id,
      slug: tag.slug,
      name: tag.name,
      aliases: parseJson<string[]>(tag.aliases, []),
      parents: parseJson<string[]>(tag.parents, []),
      directCount: tag.directCount,
      count: tag.count,
    }
  })
  return {
    tags: pageTags,
    total: tagCount?.total || 0,
    page: input.page,
    pageSize: publicTagPageSize,
    matchingSiteCount: count?.total || 0,
    tagLabels,
  }
}

export async function readPublicSiteDetail(
  slug: string,
): Promise<PublicSiteDetail | undefined> {
  await ensureSeedData()
  const current = await env.DB.prepare(
    `SELECT ${siteColumns} FROM sites s
     WHERE ${visibleSiteSql} AND s.slug = ? LIMIT 1`,
  )
    .bind(slug)
    .first<SiteSqlRow>()
  if (!current) return undefined

  const adjacentColumns = 's.slug, s.name'
  const [previous, next, first, last, sites] = await Promise.all([
    env.DB.prepare(
      `SELECT ${adjacentColumns} FROM sites s WHERE ${visibleSiteSql}
       AND (s.added_at > ? OR (s.added_at = ? AND s.id > ?))
       ORDER BY s.added_at ASC, s.id ASC LIMIT 1`,
    )
      .bind(current.addedAt, current.addedAt, current.id)
      .first<Pick<SiteEntry, 'slug' | 'name'>>(),
    env.DB.prepare(
      `SELECT ${adjacentColumns} FROM sites s WHERE ${visibleSiteSql}
       AND (s.added_at < ? OR (s.added_at = ? AND s.id < ?))
       ORDER BY s.added_at DESC, s.id DESC LIMIT 1`,
    )
      .bind(current.addedAt, current.addedAt, current.id)
      .first<Pick<SiteEntry, 'slug' | 'name'>>(),
    env.DB.prepare(
      `SELECT ${adjacentColumns} FROM sites s WHERE ${visibleSiteSql}
       ORDER BY s.added_at DESC, s.id DESC LIMIT 1`,
    ).first<Pick<SiteEntry, 'slug' | 'name'>>(),
    env.DB.prepare(
      `SELECT ${adjacentColumns} FROM sites s WHERE ${visibleSiteSql}
       ORDER BY s.added_at ASC, s.id ASC LIMIT 1`,
    ).first<Pick<SiteEntry, 'slug' | 'name'>>(),
    hydrateSiteRows([current]),
  ])
  const site = sites[0]
  if (!first || !last) return undefined
  return {
    site,
    previous: previous || last,
    next: next || first,
  }
}

export async function readTagSuggestions(input: {
  query: string
  selected: string[]
  limit: number
}): Promise<TagSuggestionResult> {
  await ensureSeedData()
  const query = normalizeTag(input.query)
  const selected = input.selected
    .filter((token) => !token.startsWith('~'))
    .map((token) => normalizeTag(token))
    .slice(0, 20)
  const selectedJson = JSON.stringify(selected)
  const search = `%${escapeLike(query)}%`
  const rows = await env.DB.prepare(
    `SELECT tag.id, tag.slug, tag.name, 0 AS count,
       coalesce((SELECT json_group_array(alias.alias) FROM tag_aliases alias WHERE alias.tag_id = tag.id), '[]') AS aliases,
       '[]' AS parents, '{}' AS parentLabels, 0 AS directCount,
       CASE WHEN EXISTS (
         SELECT 1 FROM json_each(?1) selected_token
         WHERE lower(selected_token.value) = lower(tag.slug)
            OR lower(selected_token.value) = lower(tag.name)
            OR EXISTS (SELECT 1 FROM tag_aliases selected_alias WHERE selected_alias.tag_id = tag.id AND lower(selected_alias.alias) = lower(selected_token.value))
       ) THEN 1 ELSE 0 END AS isSelected
     FROM tags tag
     WHERE tag.canonical = 1 AND (
       EXISTS (
         SELECT 1 FROM json_each(?1) selected_token
         WHERE lower(selected_token.value) = lower(tag.slug)
            OR lower(selected_token.value) = lower(tag.name)
            OR EXISTS (SELECT 1 FROM tag_aliases selected_alias WHERE selected_alias.tag_id = tag.id AND lower(selected_alias.alias) = lower(selected_token.value))
       )
       OR (?2 <> '' AND (lower(tag.name) LIKE ?3 ESCAPE '\\' OR lower(tag.slug) LIKE ?3 ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM tag_aliases searched_alias WHERE searched_alias.tag_id = tag.id AND lower(searched_alias.alias) LIKE ?3 ESCAPE '\\'
       )))
     )
     ORDER BY isSelected DESC, CASE WHEN lower(tag.slug) = ?2 OR lower(tag.name) = ?2 THEN 0 ELSE 1 END, lower(tag.name)
     LIMIT ?4`,
  )
    .bind(selectedJson, query, search, 20)
    .all<TagSqlRow & { isSelected: number }>()
  const mapped = rows.results.map((tag) => ({
    id: tag.id,
    slug: tag.slug,
    name: tag.name,
    aliases: parseJson<string[]>(tag.aliases, []),
    parents: [],
    count: 0,
  }))
  const selectedSlugs = new Set(
    rows.results.filter((tag) => tag.isSelected).map((tag) => tag.slug),
  )
  return {
    selected: mapped.filter((tag) => selectedSlugs.has(tag.slug)),
    suggestions: mapped
      .filter((tag) => !selectedSlugs.has(tag.slug))
      .slice(0, Math.min(input.limit, 20 - selectedSlugs.size)),
  }
}

export async function readPublicSitemapBatch(input: {
  afterId?: number
  limit?: number
}) {
  await ensureSeedData()
  const limit = Math.min(Math.max(input.limit || 500, 1), 1000)
  return (
    await env.DB.prepare(
      `SELECT s.id, s.slug, s.added_at AS addedAt FROM sites s
       WHERE ${visibleSiteSql} AND s.id > ? ORDER BY s.id ASC LIMIT ?`,
    )
      .bind(input.afterId || 0, limit)
      .all<{ id: number; slug: string; addedAt: number }>()
  ).results.map((row) => ({
    id: row.id,
    slug: row.slug,
    added: formatIsoDate(row.addedAt),
  }))
}

function buildSiteFilter(input: PublicDirectoryInput) {
  const clauses = [visibleSiteSql]
  const bindings: unknown[] = []
  if (input.query) {
    clauses.push(`(
      lower(s.name || ' ' || s.description) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM site_tags searched_assignment
        JOIN tags searched_tag ON searched_tag.id = searched_assignment.tag_id
        WHERE searched_assignment.site_id = s.id AND (
          lower(searched_assignment.raw_name) LIKE ? ESCAPE '\\'
          OR lower(searched_tag.name) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM tag_aliases searched_alias
            WHERE searched_alias.tag_id = searched_tag.id
              AND searched_alias.alias LIKE ? ESCAPE '\\'
          )
        )
      )
    )`)
    const query = `%${escapeLike(normalizeTag(input.query))}%`
    bindings.push(query, query, query, query)
  }
  for (const tag of input.include) clauses.push(tagMatchSql(tag, bindings))
  if (input.exclude.length) {
    clauses.push(
      `NOT (${input.exclude.map((tag) => tagMatchSql(tag, bindings)).join(' OR ')})`,
    )
  }
  return { sql: clauses.join(' AND '), bindings }
}

function tagMatchSql(tag: string, bindings: unknown[]) {
  if (tag.startsWith('~')) {
    bindings.push(normalizeTag(tag.slice(1)))
    return `EXISTS (
      SELECT 1 FROM site_tags assignment WHERE assignment.site_id = s.id
        AND lower(trim(assignment.raw_name, '~')) = ?
    )`
  }
  const normalized = normalizeTag(tag)
  bindings.push(normalized, normalized, normalized)
  return `EXISTS (
    SELECT 1 FROM site_tags assignment
    JOIN tags target ON target.canonical = 1 AND (
      lower(target.slug) = ? OR lower(target.name) = ? OR EXISTS (
        SELECT 1 FROM tag_aliases target_alias WHERE target_alias.tag_id = target.id AND lower(target_alias.alias) = ?
      )
    )
    JOIN tag_descendants closure
      ON closure.root_id = target.id AND closure.tag_id = assignment.tag_id
    WHERE assignment.site_id = s.id
  )`
}

const directoryOrder: Record<PublicSortMode, string> = {
  popular: 's.visits DESC, s.name ASC, s.id ASC',
  newest: 's.added_at DESC, s.id DESC',
  oldest: 's.added_at ASC, s.id ASC',
  tags: `(SELECT count(*) FROM site_tags ordered_tags WHERE ordered_tags.site_id = s.id) DESC,
    s.name ASC, s.id ASC`,
  az: 's.name ASC, s.id ASC',
  za: 's.name DESC, s.id DESC',
}

async function hydrateSiteRows(rows: SiteSqlRow[]): Promise<SiteEntry[]> {
  if (!rows.length) return []
  const placeholders = rows.map(() => '?').join(', ')
  const assignments = await env.DB.prepare(
    `SELECT assignment.site_id AS siteId, assignment.raw_name AS rawName,
            tag.slug, tag.name, tag.canonical
     FROM site_tags assignment JOIN tags tag ON tag.id = assignment.tag_id
     WHERE assignment.site_id IN (${placeholders})
     ORDER BY assignment.site_id ASC, assignment.rowid ASC`,
  )
    .bind(...rows.map((row) => row.id))
    .all<{
      siteId: number
      rawName: string
      slug: string
      name: string
      canonical: number
    }>()
  const tagsBySite = groupValues(
    assignments.results,
    (row) => row.siteId,
    (row) =>
      row.canonical
        ? row.slug
        : `~${normalizeTag(row.rawName).replace(/^~+/, '')}`,
  )
  const labelsBySite = new Map<number, Record<string, string>>()
  for (const row of assignments.results) {
    const token = row.canonical
      ? row.slug
      : `~${normalizeTag(row.rawName).replace(/^~+/, '')}`
    labelsBySite.set(row.siteId, {
      ...(labelsBySite.get(row.siteId) || {}),
      [token]: row.canonical ? row.name : row.rawName.replace(/^~+/, ''),
    })
  }
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    externalUrl: row.url,
    description: row.description,
    summary: row.summary,
    tags: tagsBySite.get(row.id) || [],
    tagLabels: labelsBySite.get(row.id) || {},
    categories: parseJson<string[]>(row.categories, []),
    poster: row.poster,
    notes: parseJson<string[]>(row.notes, []),
    facts: parseJson<Array<{ label: string; value: string }>>(row.facts, []),
    visits: row.visits,
    added: formatIsoDate(row.addedAt),
    addedLabel: formatShortDate(row.addedAt),
    accent: row.accent,
    thumbnailKey: row.thumbnailKey || undefined,
    thumbnailAlt: row.thumbnailAlt || undefined,
  }))
}

function groupValues<TRow, TKey, TValue>(
  rows: TRow[],
  key: (row: TRow) => TKey,
  value: (row: TRow) => TValue,
) {
  const grouped = new Map<TKey, TValue[]>()
  for (const row of rows) {
    const rowKey = key(row)
    const values = grouped.get(rowKey) || []
    const rowValue = value(row)
    if (!values.includes(rowValue)) values.push(rowValue)
    grouped.set(rowKey, values)
  }
  return grouped
}

function parseJson<TValue>(value: string, fallback: TValue): TValue {
  try {
    return JSON.parse(value) as TValue
  } catch {
    return fallback
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function formatIsoDate(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

function formatShortDate(timestamp: number) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp * 1000))
}
