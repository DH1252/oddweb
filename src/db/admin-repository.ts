import { env } from 'cloudflare:workers'

import { ensureSeedData } from './repository'

import type {
  AdminSite,
  AdminSubmission,
  AdminTagRecord,
  GuestbookEntry,
} from './repository'

export const adminPageSize = 12

export type AdminPage<T> = {
  items: T[]
  page: number
  total: number
}

export type AdminOverview = {
  activeSites: number
  pendingSubmissions: number
  visits: number
  tagsInUse: number
  unmappedTags: number
}

type SiteFilters = {
  page: number
  status: 'active' | 'archived' | 'all'
  search: string
  includeTags: string[]
  excludeTags: string[]
}

export async function readAdminOverview(): Promise<AdminOverview> {
  await ensureSeedData()
  const totals = await env.DB.prepare(
    `SELECT
         (SELECT count(*) FROM sites WHERE status = 'active') AS activeSites,
         (SELECT count(*) FROM submissions WHERE status = 'pending') AS pendingSubmissions,
         (SELECT coalesce(sum(visits), 0) FROM sites) AS visits,
         (SELECT count(DISTINCT st.tag_id) FROM site_tags st
          JOIN sites s ON s.id = st.site_id
          LEFT JOIN submissions sub ON sub.id = s.submission_id
          WHERE s.status = 'active'
            AND (s.source <> 'Submission' OR sub.status = 'approved')) AS tagsInUse,
         (SELECT count(*) FROM tags WHERE canonical = 0) AS unmappedTags`,
  ).first<{
    activeSites: number
    pendingSubmissions: number
    visits: number
    tagsInUse: number
    unmappedTags: number
  }>()
  if (!totals) throw new Error('Could not load admin totals.')
  return totals
}

export async function readAdminSubmissions(input: {
  page: number
  status: 'pending' | 'approved' | 'rejected' | 'all'
}): Promise<AdminPage<AdminSubmission>> {
  await ensureSeedData()
  const where = input.status === 'all' ? '' : 'WHERE status = ?1'
  const bindings = input.status === 'all' ? [] : [input.status]
  const total = await countQuery(
    `SELECT count(*) AS total FROM submissions ${where}`,
    bindings,
  )
  const page = safePage(input.page, total)
  const result = await env.DB.prepare(
    `SELECT id, name, url, description, tags, thumbnail_key AS thumbnailKey,
            thumbnail_alt AS thumbnailAlt, status, submitted_at AS submittedAt
     FROM submissions ${where}
     ORDER BY submitted_at DESC, id DESC LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`,
  )
    .bind(...bindings, adminPageSize, page * adminPageSize)
    .all<
      Omit<AdminSubmission, 'tags' | 'date'> & {
        tags: string
        submittedAt: number
      }
    >()
  return {
    items: result.results.map(({ submittedAt, ...row }) => ({
      ...row,
      tags: jsonArray(row.tags),
      date: formatShortDate(submittedAt),
      submittedAt,
    })),
    page,
    total,
  }
}

export async function readAdminSites(
  input: SiteFilters,
): Promise<AdminPage<AdminSite>> {
  await ensureSeedData()
  const { sql, bindings } = siteWhere(input)
  const total = await countQuery(
    `SELECT count(*) AS total FROM sites s ${sql}`,
    bindings,
  )
  const page = safePage(input.page, total)
  const rows = await env.DB.prepare(
    `SELECT s.id, s.slug, s.name, s.url AS externalUrl, s.description,
            s.visits, s.status, s.source, s.thumbnail_key AS thumbnailKey,
            s.thumbnail_alt AS thumbnailAlt, s.added_at AS addedAt
     FROM sites s ${sql}
     ORDER BY s.added_at DESC, s.id DESC
     LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`,
  )
    .bind(...bindings, adminPageSize, page * adminPageSize)
    .all<
      Omit<
        AdminSite,
        | 'tags'
        | 'categories'
        | 'poster'
        | 'notes'
        | 'facts'
        | 'summary'
        | 'accent'
        | 'added'
        | 'addedLabel'
      > & { addedAt: number }
    >()
  const tags = await tagsForSites(rows.results.map((row) => row.id))
  return {
    items: rows.results.map(({ addedAt, ...row }) => ({
      ...row,
      added: formatIsoDate(addedAt),
      addedLabel: formatShortDate(addedAt),
      addedAt,
      tags: tags.get(row.id)?.tokens || [],
      tagLabels: tags.get(row.id)?.labels || {},
      summary: '',
      categories: [],
      poster: '',
      notes: [],
      facts: [],
      accent: '',
    })),
    page,
    total,
  }
}

export async function readAdminSite(id: number): Promise<AdminSite | null> {
  await ensureSeedData()
  const row = await env.DB.prepare(
    `SELECT id, slug, name, url AS externalUrl, description, summary, categories,
            poster, notes, facts, accent, thumbnail_key AS thumbnailKey,
            thumbnail_alt AS thumbnailAlt, visits, status, source,
            added_at AS addedAt
     FROM sites WHERE id = ?1`,
  )
    .bind(id)
    .first<
      Omit<
        AdminSite,
        'tags' | 'categories' | 'notes' | 'facts' | 'added' | 'addedLabel'
      > & {
        categories: string
        notes: string
        facts: string
        addedAt: number
      }
    >()
  if (!row) return null
  const tags = await tagsForSites([id])
  const { addedAt, ...site } = row
  return {
    ...site,
    added: formatIsoDate(addedAt),
    addedLabel: formatShortDate(addedAt),
    addedAt,
    categories: jsonArray(row.categories),
    notes: jsonArray(row.notes),
    facts: jsonArray<{ label: string; value: string }>(row.facts),
    tags: tags.get(id)?.tokens || [],
    tagLabels: tags.get(id)?.labels || {},
  }
}

export async function readAdminTags(input: {
  page: number
  search: string
}): Promise<AdminPage<AdminTagRecord>> {
  await ensureSeedData()
  const search = input.search.trim().toLowerCase()
  const where = search
    ? `WHERE lower(t.name) LIKE ?1 ESCAPE char(92) OR lower(t.slug) LIKE ?1 ESCAPE char(92) OR EXISTS (
         SELECT 1 FROM tag_aliases a WHERE a.tag_id = t.id AND lower(a.alias) LIKE ?1 ESCAPE char(92)
       )`
    : ''
  const bindings = search ? [`%${escapeLike(search)}%`] : []
  const total = await countQuery(
    `SELECT count(*) AS total FROM tags t ${where}`,
    bindings,
  )
  const page = safePage(input.page, total)
  const rows = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.canonical,
            coalesce((SELECT json_group_array(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id), '[]') AS aliases,
            coalesce((SELECT json_group_array(parent.slug) FROM tag_parents p JOIN tags parent ON parent.id = p.parent_tag_id WHERE p.child_tag_id = t.id), '[]') AS parents,
            (SELECT count(DISTINCT st.site_id) FROM site_tags st JOIN sites s ON s.id = st.site_id LEFT JOIN submissions sub ON sub.id = s.submission_id WHERE st.tag_id = t.id AND s.status = 'active' AND (s.source <> 'Submission' OR sub.status = 'approved')) AS directCount,
            (WITH RECURSIVE descendants(id) AS (
               SELECT t.id UNION SELECT p.child_tag_id FROM tag_parents p JOIN descendants d ON p.parent_tag_id = d.id
             ) SELECT count(DISTINCT st.site_id) FROM descendants d JOIN site_tags st ON st.tag_id = d.id JOIN sites s ON s.id = st.site_id LEFT JOIN submissions sub ON sub.id = s.submission_id WHERE s.status = 'active' AND (s.source <> 'Submission' OR sub.status = 'approved')) AS count
     FROM tags t ${where}
     ORDER BY t.canonical DESC, lower(t.name), t.id
     LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`,
  )
    .bind(...bindings, adminPageSize, page * adminPageSize)
    .all<{
      id: number
      slug: string
      name: string
      canonical: number
      aliases: string
      parents: string
      directCount: number
      count: number
    }>()
  return {
    items: rows.results.map((row) => ({
      ...row,
      canonical: Boolean(row.canonical),
      aliases: jsonArray(row.aliases),
      parents: jsonArray(row.parents),
    })),
    page,
    total,
  }
}

export async function readAdminGuestbook(input: {
  page: number
}): Promise<AdminPage<GuestbookEntry>> {
  await ensureSeedData()
  const total = await countQuery('SELECT count(*) AS total FROM guestbook', [])
  const page = safePage(input.page, total)
  const result = await env.DB.prepare(
    `SELECT id, name, message, hidden_at IS NOT NULL AS hidden,
            created_at AS createdAt
     FROM guestbook ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2`,
  )
    .bind(adminPageSize, page * adminPageSize)
    .all<{
      id: number
      name: string
      message: string
      createdAt: number
      hidden: number
    }>()
  return {
    items: result.results.map(({ createdAt, ...row }) => ({
      ...row,
      date: formatShortDate(createdAt),
      createdAt,
      hidden: Boolean(row.hidden),
    })),
    page,
    total,
  }
}

function siteWhere(input: SiteFilters) {
  const clauses: string[] = []
  const bindings: unknown[] = []
  const bind = (value: unknown) => {
    bindings.push(value)
    return `?${bindings.length}`
  }
  if (input.status !== 'all') clauses.push(`s.status = ${bind(input.status)}`)
  const search = input.search.trim().toLowerCase()
  if (search) {
    const token = bind(`%${escapeLike(search)}%`)
    clauses.push(`(lower(s.name) LIKE ${token} ESCAPE '\\' OR lower(s.url) LIKE ${token} ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM site_tags search_st JOIN tags search_t ON search_t.id = search_st.tag_id
      WHERE search_st.site_id = s.id AND (lower(search_t.name) LIKE ${token} ESCAPE '\\' OR lower(search_t.slug) LIKE ${token} ESCAPE '\\' OR lower(search_st.raw_name) LIKE ${token} ESCAPE '\\')
    ))`)
  }
  for (const tag of input.includeTags) clauses.push(tagClause(tag, bind, false))
  for (const tag of input.excludeTags) clauses.push(tagClause(tag, bind, true))
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    bindings,
  }
}

function tagClause(
  tag: string,
  bind: (value: unknown) => string,
  negate: boolean,
) {
  const freeform = tag.startsWith('~')
  const value = bind(tag.replace(/^~+/, '').trim().toLowerCase())
  const exists = freeform
    ? `EXISTS (SELECT 1 FROM site_tags filter_st JOIN tags filter_t ON filter_t.id = filter_st.tag_id WHERE filter_st.site_id = s.id AND filter_t.canonical = 0 AND lower(filter_t.name) = ${value})`
    : `EXISTS (WITH RECURSIVE descendants(id) AS (SELECT id FROM tags WHERE slug = ${value} AND canonical = 1 UNION SELECT p.child_tag_id FROM tag_parents p JOIN descendants d ON p.parent_tag_id = d.id) SELECT 1 FROM site_tags filter_st JOIN descendants d ON d.id = filter_st.tag_id WHERE filter_st.site_id = s.id)`
  return negate ? `NOT ${exists}` : exists
}

async function tagsForSites(ids: number[]) {
  const result = new Map<
    number,
    { tokens: string[]; labels: Record<string, string> }
  >()
  if (!ids.length) return result
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT st.site_id AS siteId, CASE WHEN t.canonical = 1 THEN t.slug ELSE '~' || lower(t.name) END AS tag,
            CASE WHEN t.canonical = 1 THEN t.name ELSE st.raw_name END AS label
     FROM site_tags st JOIN tags t ON t.id = st.tag_id
     WHERE st.site_id IN (${placeholders}) ORDER BY t.canonical DESC, lower(t.name)`,
  )
    .bind(...ids)
    .all<{ siteId: number; tag: string; label: string }>()
  for (const row of rows.results) {
    const current = result.get(row.siteId) || { tokens: [], labels: {} }
    current.tokens.push(row.tag)
    current.labels[row.tag] = row.label.replace(/^~+/, '')
    result.set(row.siteId, current)
  }
  return result
}

async function countQuery(sql: string, bindings: unknown[]) {
  const row = await env.DB.prepare(sql)
    .bind(...bindings)
    .first<{ total: number }>()
  return row?.total || 0
}

function safePage(page: number, total: number) {
  return Math.min(
    Math.max(0, page),
    Math.max(0, Math.ceil(total / adminPageSize) - 1),
  )
}

function jsonArray<T = string>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function formatShortDate(seconds: number) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(seconds * 1000))
}

function formatIsoDate(seconds: number) {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}
