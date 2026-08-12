import { env } from 'cloudflare:workers'
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'

import { sites as seedSites } from '../data/sites'
import {
  canonicalTags,
  normalizeTag,
  resolveTagSlug,
  tagSlug,
} from '../data/tags'
import { websiteUrlKey } from '../lib/website-url'
import { getDb } from './index'
import {
  adminLoginAttemptsTable,
  adminSessionsTable,
  guestbookTable,
  publicRateLimitsTable,
  siteTagsTable,
  sitesTable,
  submissionsTable,
  tagAliasesTable,
  tagParentsTable,
  tagsTable,
} from './schema'

import type { RecentFiling, SiteEntry } from '../data/sites'
import type { CanonicalTag } from '../data/tags'
import type { SiteRow, SubmissionRow } from './schema'

export type GuestbookEntry = {
  id: number
  name: string
  message: string
  date: string
}

export type DirectoryData = {
  sites: SiteEntry[]
  guestbook: GuestbookEntry[]
  recentFilings: RecentFiling[]
  tagCatalog: CanonicalTag[]
}

export type AdminSite = SiteEntry & {
  id: number
  status: 'active' | 'archived'
  source: 'Directory' | 'Submission' | 'Manual'
}

export type AdminSubmission = RecentFiling & {
  id: number
  status: 'pending' | 'approved' | 'rejected'
}

export type AdminTagRecord = CanonicalTag & {
  id: number
  canonical: boolean
}

export type AdminData = {
  sites: AdminSite[]
  submissions: AdminSubmission[]
  guestbook: GuestbookEntry[]
  tagCatalog: CanonicalTag[]
  tagRecords: AdminTagRecord[]
}

export async function ensureSeedData() {
  const seedKey = 'catalog-seed-v1'
  const seeded = await env.DB.prepare(
    'SELECT key FROM app_state WHERE key = ?1',
  )
    .bind(seedKey)
    .first()
  if (seeded) return

  const tagsJson = JSON.stringify(canonicalTags)
  const sitesJson = JSON.stringify(
    seedSites.map((site) => ({
      ...site,
      tagSlugs: [...new Set(site.tags.map((tag) => resolveTagSlug(tag)))],
      urlKey: websiteUrlKey(site.externalUrl),
      addedAt: Math.floor(new Date(`${site.added}T12:00:00Z`).getTime() / 1000),
    })),
  )
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tags (slug, name, category, canonical)
       SELECT json_extract(value, '$.slug'), json_extract(value, '$.name'),
              json_extract(value, '$.category'), 1 FROM json_each(?1)
       ON CONFLICT(slug) DO NOTHING`,
    ).bind(tagsJson),
    env.DB.prepare(
      `INSERT INTO tag_aliases (alias, tag_id)
       SELECT alias.value, tags.id
       FROM json_each(?1) definition
       JOIN tags ON tags.slug = json_extract(definition.value, '$.slug')
       JOIN json_each(json_extract(definition.value, '$.aliases')) alias
       ON CONFLICT(alias) DO NOTHING`,
    ).bind(tagsJson),
    env.DB.prepare(
      `INSERT INTO tag_parents (parent_tag_id, child_tag_id)
       SELECT parent.id, child.id
       FROM json_each(?1) definition
       JOIN tags child ON child.slug = json_extract(definition.value, '$.slug')
       JOIN json_each(json_extract(definition.value, '$.parents')) relation
       JOIN tags parent ON parent.slug = relation.value
       ON CONFLICT(parent_tag_id, child_tag_id) DO NOTHING`,
    ).bind(tagsJson),
    env.DB.prepare(
      `INSERT INTO sites (
         slug, name, url, url_key, description, summary, categories, poster,
         notes, facts, accent, thumbnail_key, thumbnail_alt, visits, status,
         source, added_at
       ) SELECT
         json_extract(value, '$.slug'), json_extract(value, '$.name'),
         json_extract(value, '$.externalUrl'), json_extract(value, '$.urlKey'),
         json_extract(value, '$.description'), json_extract(value, '$.summary'),
         json_extract(value, '$.categories'), json_extract(value, '$.poster'),
         json_extract(value, '$.notes'), json_extract(value, '$.facts'),
         json_extract(value, '$.accent'), json_extract(value, '$.thumbnailKey'),
         json_extract(value, '$.thumbnailAlt'), 0, 'active', 'Directory',
         json_extract(value, '$.addedAt') FROM json_each(?1)
       ON CONFLICT DO NOTHING`,
    ).bind(sitesJson),
    env.DB.prepare(
      `INSERT INTO site_tags (site_id, tag_id, raw_name)
       SELECT sites.id, tags.id, tags.slug
       FROM json_each(?1) definition
        JOIN sites ON sites.slug = json_extract(definition.value, '$.slug')
                  AND sites.url_key = json_extract(definition.value, '$.urlKey')
       JOIN json_each(json_extract(definition.value, '$.tagSlugs')) raw_tag
       JOIN tags ON tags.slug = raw_tag.value
       ON CONFLICT(site_id, raw_name) DO NOTHING`,
    ).bind(sitesJson),
  ])
  const seedComplete = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM json_each(?1) definition
        JOIN tags ON tags.slug = json_extract(definition.value, '$.slug')) = json_array_length(?1)
       AND
       (SELECT count(*) FROM json_each(?2) definition
        JOIN sites ON sites.slug = json_extract(definition.value, '$.slug')
                  AND sites.url_key = json_extract(definition.value, '$.urlKey')) = json_array_length(?2)
       AS complete`,
  )
    .bind(tagsJson, sitesJson)
    .first<{ complete: number }>()
  if (!seedComplete?.complete) {
    throw new Error(
      'Catalog seed validation failed; resolve conflicting records.',
    )
  }
  await env.DB.prepare(
    `INSERT INTO app_state (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(seedKey, new Date().toISOString())
    .run()
}

export async function readDirectoryData(): Promise<DirectoryData> {
  await ensureSeedData()
  const db = getDb()
  const rows = await db
    .select()
    .from(sitesTable)
    .where(
      and(
        eq(sitesTable.status, 'active'),
        or(
          ne(sitesTable.source, 'Submission'),
          exists(
            db
              .select({ id: submissionsTable.id })
              .from(submissionsTable)
              .where(
                and(
                  eq(submissionsTable.id, sitesTable.submissionId),
                  eq(submissionsTable.status, 'approved'),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(desc(sitesTable.visits), asc(sitesTable.name))
  const tagState = await loadTagState()
  const sites = await hydrateSites(rows, tagState)
  const guestbookRows = await db
    .select()
    .from(guestbookTable)
    .orderBy(desc(guestbookTable.createdAt))
    .limit(5)
  const submissionRows = await db
    .select(getTableColumns(submissionsTable))
    .from(submissionsTable)
    .innerJoin(
      sitesTable,
      and(
        eq(sitesTable.submissionId, submissionsTable.id),
        eq(sitesTable.status, 'active'),
      ),
    )
    .where(eq(submissionsTable.status, 'approved'))
    .orderBy(desc(submissionsTable.submittedAt))
    .limit(6)

  return {
    sites,
    guestbook: guestbookRows.map((entry) => ({
      id: entry.id,
      name: entry.name,
      message: entry.message,
      date: formatShortDate(entry.createdAt),
    })),
    recentFilings: submissionRows.map(mapSubmission),
    tagCatalog: tagState.catalog,
  }
}

export async function readAdminData(): Promise<AdminData> {
  await ensureSeedData()
  const db = getDb()
  const siteRows = await db
    .select()
    .from(sitesTable)
    .orderBy(desc(sitesTable.addedAt))
  const tagState = await loadTagState()
  const hydratedSites = await hydrateSites(siteRows, tagState)
  const submissions = await db
    .select()
    .from(submissionsTable)
    .orderBy(desc(submissionsTable.submittedAt))
  const guestbook = await db
    .select()
    .from(guestbookTable)
    .orderBy(desc(guestbookTable.createdAt))

  return {
    sites: hydratedSites.map((site, index) => ({
      ...site,
      id: siteRows[index].id,
      status: siteRows[index].status,
      source: siteRows[index].source,
    })),
    submissions: submissions.map((submission) => ({
      ...mapSubmission(submission),
      id: submission.id,
      status: submission.status,
    })),
    guestbook: guestbook.map((entry) => ({
      id: entry.id,
      name: entry.name,
      message: entry.message,
      date: formatShortDate(entry.createdAt),
    })),
    tagCatalog: tagState.catalog,
    tagRecords: tagState.records,
  }
}

export async function createSubmission(input: {
  name: string
  url: string
  description: string
  tags: string[]
  thumbnailKey: string
  thumbnailAlt: string
}) {
  const db = getDb()
  const urlKey = websiteUrlKey(input.url)
  const reusable = await env.DB.prepare(
    `SELECT submissions.id, submissions.thumbnail_key AS thumbnailKey
     FROM submissions
     LEFT JOIN sites ON sites.submission_id = submissions.id
     WHERE submissions.url_key = ?1
       AND submissions.status IN ('approved', 'rejected')
       AND (sites.id IS NULL OR sites.status = 'archived')
     ORDER BY submissions.submitted_at DESC LIMIT 1`,
  )
    .bind(urlKey)
    .first<{ id: number; thumbnailKey: string | null }>()
  if (reusable) {
    await env.DB.prepare(
      `UPDATE submissions
       SET name = ?2, url = ?3, description = ?4, tags = ?5,
           thumbnail_key = ?6, thumbnail_alt = ?7, status = 'pending',
           submitted_at = unixepoch(), reviewed_at = NULL
       WHERE id = ?1`,
    )
      .bind(
        reusable.id,
        input.name,
        input.url,
        input.description,
        JSON.stringify([
          ...new Set(input.tags.map(normalizeFreeformTag).filter(Boolean)),
        ]),
        input.thumbnailKey,
        input.thumbnailAlt,
      )
      .run()
    return {
      reused: true as const,
      previousThumbnailKey: reusable.thumbnailKey,
    }
  }

  const existingSite = await db
    .select({ id: sitesTable.id, submissionId: sitesTable.submissionId })
    .from(sitesTable)
    .where(eq(sitesTable.urlKey, urlKey))
    .limit(1)
  if (existingSite.length) {
    throw new Error('This website is already in the directory.')
  }
  try {
    await db.insert(submissionsTable).values({
      ...input,
      urlKey,
      tags: [...new Set(input.tags.map(normalizeFreeformTag).filter(Boolean))],
    })
    return { reused: false as const, previousThumbnailKey: null }
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new Error('This website already has an open submission.')
    }
    throw error
  }
}

export async function createSite(input: {
  name: string
  url: string
  description: string
  tags: string[]
  thumbnailKey: string
  thumbnailAlt: string
  status: 'active' | 'archived'
  source: 'Submission' | 'Manual'
}) {
  const db = getDb()
  const slug = await uniqueSiteSlug(input.name)
  const urlKey = websiteUrlKey(input.url)
  const storedTags = await ensureStoredTags(input.tags)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sites (
         slug, name, url, url_key, description, summary, categories, poster, notes,
         facts, thumbnail_key, thumbnail_alt, status, source
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ).bind(
      slug,
      input.name,
      input.url,
      urlKey,
      input.description,
      JSON.stringify(['New filing']),
      generatedPoster(input.name),
      JSON.stringify([input.description]),
      JSON.stringify([
        { label: 'Address', value: new URL(input.url).hostname },
      ]),
      input.thumbnailKey,
      input.thumbnailAlt,
      input.status,
      input.source,
    ),
    ...storedTags.map((tag) =>
      env.DB.prepare(
        `INSERT INTO site_tags (site_id, tag_id, raw_name)
         SELECT id, ?1, ?2 FROM sites WHERE slug = ?3`,
      ).bind(tag.id, tag.rawName, slug),
    ),
  ])
  const site = (
    await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.slug, slug))
      .limit(1)
  ).at(0)
  if (!site) throw new Error('Site creation did not complete.')
  return site.id
}

export async function addGuestbookEntry(input: {
  name: string
  message: string
}) {
  try {
    await getDb().insert(guestbookTable).values(input)
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new Error('That guestbook entry has already been recorded.')
    }
    throw error
  }
}

export async function deleteGuestbookEntry(id: number) {
  await getDb().delete(guestbookTable).where(eq(guestbookTable.id, id))
}

export async function incrementSiteVisits(slug: string) {
  await getDb()
    .update(sitesTable)
    .set({ visits: sql`${sitesTable.visits} + 1` })
    .where(and(eq(sitesTable.slug, slug), eq(sitesTable.status, 'active')))
}

export async function isActiveSite(slug: string) {
  return Boolean(
    (
      await getDb()
        .select({ id: sitesTable.id })
        .from(sitesTable)
        .where(and(eq(sitesTable.slug, slug), eq(sitesTable.status, 'active')))
        .limit(1)
    ).at(0),
  )
}

export async function moderateSubmission(
  id: number,
  status: 'pending' | 'approved' | 'rejected',
) {
  const db = getDb()
  const submission = (
    await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id))
      .limit(1)
  ).at(0)
  if (!submission) throw new Error('Submission not found.')
  const ownedSite = (
    await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.submissionId, submission.id))
      .limit(1)
  ).at(0)

  if (status === 'approved') {
    const slug = await uniqueSiteSlug(submission.name)
    const storedTags = await ensureStoredTags(submission.tags)
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE submissions
         SET status = 'approved', reviewed_at = unixepoch()
         WHERE id = ?1`,
      ).bind(submission.id),
      ...(ownedSite
        ? [
            env.DB.prepare(
              `DELETE FROM site_tags
               WHERE site_id = (SELECT id FROM sites WHERE submission_id = ?1)`,
            ).bind(submission.id),
          ]
        : []),
      env.DB.prepare(
        `INSERT INTO sites (
           slug, name, url, url_key, description, summary, categories, poster, notes,
           facts, thumbnail_key, thumbnail_alt, status, source, submission_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', 'Submission', ?12)
         ON CONFLICT(submission_id) DO UPDATE SET
            name = excluded.name,
            url = excluded.url,
            url_key = excluded.url_key,
           description = excluded.description,
           summary = excluded.summary,
           notes = excluded.notes,
           facts = excluded.facts,
           thumbnail_key = excluded.thumbnail_key,
           thumbnail_alt = excluded.thumbnail_alt,
           status = 'active'`,
      ).bind(
        slug,
        submission.name,
        submission.url,
        submission.urlKey,
        submission.description,
        JSON.stringify(['New filing']),
        generatedPoster(submission.name),
        JSON.stringify([submission.description]),
        JSON.stringify([
          { label: 'Address', value: new URL(submission.url).hostname },
        ]),
        submission.thumbnailKey,
        submission.thumbnailAlt || `Preview of ${submission.name}`,
        submission.id,
      ),
      ...(!ownedSite
        ? [
            env.DB.prepare(
              `DELETE FROM site_tags
               WHERE site_id = (SELECT id FROM sites WHERE submission_id = ?1)`,
            ).bind(submission.id),
          ]
        : []),
      ...storedTags.map((tag) =>
        env.DB.prepare(
          `INSERT INTO site_tags (site_id, tag_id, raw_name)
           SELECT id, ?1, ?2 FROM sites WHERE submission_id = ?3`,
        ).bind(tag.id, tag.rawName, submission.id),
      ),
    ])
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sites SET status = 'archived'
         WHERE submission_id = ?1 AND source = 'Submission'`,
      ).bind(submission.id),
      env.DB.prepare(
        `UPDATE submissions
         SET status = ?2,
             reviewed_at = CASE WHEN ?2 = 'pending' THEN NULL ELSE unixepoch() END
         WHERE id = ?1`,
      ).bind(submission.id, status),
    ])
  }
}

export async function setSiteStatus(id: number, status: 'active' | 'archived') {
  const result = await env.DB.prepare(
    `UPDATE sites SET status = ?2
     WHERE id = ?1 AND (
       ?2 = 'archived' OR source <> 'Submission' OR EXISTS (
         SELECT 1 FROM submissions
         WHERE submissions.id = sites.submission_id
           AND submissions.status = 'approved'
       )
     ) RETURNING id`,
  )
    .bind(id, status)
    .first()
  if (!result) {
    throw new Error('Site not found or its submission is not approved.')
  }
}

export async function updateSite(input: {
  id: number
  name: string
  url: string
  description: string
  tags: string[]
  status: 'active' | 'archived'
  thumbnailKey?: string
  thumbnailAlt?: string
}) {
  const existing = (
    await getDb()
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, input.id))
      .limit(1)
  ).at(0)
  if (!existing) throw new Error('Site not found.')

  const storedTags = await ensureStoredTags(input.tags)
  const urlKey = websiteUrlKey(input.url)
  const updateSummary = existing.summary === existing.description
  const updateNotes =
    existing.notes.length === 1 && existing.notes[0] === existing.description
  const oldGeneratedPoster = generatedPoster(existing.name)
  const facts = existing.facts.map((fact) =>
    fact.label === 'Address'
      ? { ...fact, value: new URL(input.url).hostname }
      : fact,
  )
  const thumbnailKey = input.thumbnailKey ?? existing.thumbnailKey
  const thumbnailAlt = input.thumbnailKey
    ? input.thumbnailAlt || `Preview of ${input.name}`
    : existing.thumbnailAlt
  const statements = [
    env.DB.prepare(
      `UPDATE sites
       SET name = ?1, url = ?2, url_key = ?3, description = ?4, summary = ?5,
           notes = ?6, facts = ?7, poster = ?8, status = ?9,
           thumbnail_key = ?10, thumbnail_alt = ?11
       WHERE id = ?12`,
    ).bind(
      input.name,
      input.url,
      urlKey,
      input.description,
      updateSummary ? input.description : existing.summary,
      JSON.stringify(updateNotes ? [input.description] : existing.notes),
      JSON.stringify(facts),
      existing.poster === oldGeneratedPoster
        ? generatedPoster(input.name)
        : existing.poster,
      input.status,
      thumbnailKey,
      thumbnailAlt,
      input.id,
    ),
    env.DB.prepare('DELETE FROM site_tags WHERE site_id = ?1').bind(input.id),
    ...storedTags.map((tag) =>
      env.DB.prepare(
        'INSERT INTO site_tags (site_id, tag_id, raw_name) VALUES (?1, ?2, ?3)',
      ).bind(input.id, tag.id, tag.rawName),
    ),
  ]
  await env.DB.batch(statements)
  return {
    previousThumbnailKey: existing.thumbnailKey,
    thumbnailKey,
  }
}

export async function isThumbnailReferenced(key: string) {
  if (!key) return false
  const row = await env.DB.prepare(
    `SELECT (
       EXISTS(SELECT 1 FROM sites WHERE thumbnail_key = ?1) OR
       EXISTS(SELECT 1 FROM submissions WHERE thumbnail_key = ?1)
     ) AS referenced`,
  )
    .bind(key)
    .first<{ referenced: number }>()
  return row?.referenced === 1
}

export async function listReferencedThumbnailKeys() {
  const result = await env.DB.prepare(
    `SELECT thumbnail_key AS key FROM sites WHERE thumbnail_key IS NOT NULL
     UNION
     SELECT thumbnail_key AS key FROM submissions WHERE thumbnail_key IS NOT NULL`,
  ).all<{ key: string }>()
  return new Set(result.results.map((row) => row.key))
}

export async function saveTagDefinition(input: {
  id: number
  name: string
  aliases: string[]
  parents: string[]
}) {
  const db = getDb()
  const [tags, aliases, relations] = await Promise.all([
    db.select().from(tagsTable),
    db.select().from(tagAliasesTable),
    db.select().from(tagParentsTable),
  ])
  const current = tags.find((tag) => tag.id === input.id)
  if (!current) throw new Error('Tag not found.')
  const normalizedAliases = [
    ...new Set(input.aliases.map(normalizeTag).filter(Boolean)),
  ]
  const parentRows = input.parents.map((slug) => {
    const parent = tags.find((tag) => tag.slug === slug && tag.canonical)
    if (!parent) throw new Error(`Canonical parent not found: ${slug}`)
    if (parent.id === current.id) throw new Error('A tag cannot parent itself.')
    return parent
  })
  for (const alias of normalizedAliases) {
    const slugCollision = tags.find(
      (tag) => tag.id !== current.id && tag.slug === tagSlug(alias),
    )
    const aliasCollision = aliases.find(
      (entry) => entry.alias === alias && entry.tagId !== current.id,
    )
    if (slugCollision || aliasCollision) {
      throw new Error(`Alias is already in use: ${alias}`)
    }
  }
  const parentsByChild = new Map<number, number[]>()
  for (const relation of relations) {
    const values = parentsByChild.get(relation.childTagId) || []
    values.push(relation.parentTagId)
    parentsByChild.set(relation.childTagId, values)
  }
  for (const parent of parentRows) {
    const pending = [parent.id]
    const visited = new Set<number>()
    while (pending.length) {
      const id = pending.pop()
      if (!id || visited.has(id)) continue
      if (id === current.id)
        throw new Error('Parent relationship would create a cycle.')
      visited.add(id)
      pending.push(...(parentsByChild.get(id) || []))
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE tags SET name = ?1, canonical = 1 WHERE id = ?2',
    ).bind(input.name, input.id),
    env.DB.prepare('DELETE FROM tag_aliases WHERE tag_id = ?1').bind(input.id),
    env.DB.prepare('DELETE FROM tag_parents WHERE child_tag_id = ?1').bind(
      input.id,
    ),
    ...normalizedAliases.map((alias) =>
      env.DB.prepare(
        'INSERT INTO tag_aliases (alias, tag_id) VALUES (?1, ?2)',
      ).bind(alias, input.id),
    ),
    ...parentRows.map((parent) =>
      env.DB.prepare(
        'INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (?1, ?2)',
      ).bind(parent.id, input.id),
    ),
  ])
}

export async function mergeTagAsAlias(sourceId: number, targetSlug: string) {
  const db = getDb()
  const tags = await db.select().from(tagsTable)
  const source = tags.find((tag) => tag.id === sourceId && !tag.canonical)
  const target = tags.find((tag) => tag.slug === targetSlug && tag.canonical)
  if (!source || !target)
    throw new Error('Valid source and target tags are required.')
  const alias = normalizeTag(source.name)
  const existingAlias = (
    await db
      .select()
      .from(tagAliasesTable)
      .where(eq(tagAliasesTable.alias, alias))
      .limit(1)
  ).at(0)
  if (existingAlias && existingAlias.tagId !== target.id) {
    throw new Error('That alias already belongs to another canonical tag.')
  }
  const statements = [
    env.DB.prepare('UPDATE site_tags SET tag_id = ?1 WHERE tag_id = ?2').bind(
      target.id,
      source.id,
    ),
    ...(existingAlias
      ? []
      : [
          env.DB.prepare(
            'INSERT INTO tag_aliases (alias, tag_id) VALUES (?1, ?2)',
          ).bind(alias, target.id),
        ]),
    env.DB.prepare('DELETE FROM tags WHERE id = ?1').bind(source.id),
  ]
  await env.DB.batch(statements)
}

export async function consumeLoginLimit(
  key: string,
  limit: number,
  windowSeconds: number,
) {
  const now = Math.floor(Date.now() / 1000)
  const cutoff = now - windowSeconds
  const blockedUntil = now + windowSeconds
  const row = await env.DB.prepare(
    `INSERT INTO admin_login_attempts (key, failures, window_started, blocked_until)
     VALUES (?1, 1, ?2, NULL)
     ON CONFLICT(key) DO UPDATE SET
       failures = CASE
         WHEN blocked_until IS NOT NULL AND blocked_until > ?2 THEN failures
         WHEN window_started <= ?3 THEN 1
         ELSE failures + 1
       END,
       window_started = CASE
         WHEN (blocked_until IS NULL OR blocked_until <= ?2) AND window_started <= ?3 THEN ?2
         ELSE window_started
       END,
       blocked_until = CASE
         WHEN blocked_until IS NOT NULL AND blocked_until > ?2 THEN blocked_until
         WHEN window_started <= ?3 THEN NULL
         WHEN failures + 1 > ?4 THEN ?5
         ELSE NULL
       END
     RETURNING failures, blocked_until AS blockedUntil`,
  )
    .bind(key, now, cutoff, limit, blockedUntil)
    .first<{ failures: number; blockedUntil: number | null }>()

  if (!row) throw new Error('Could not evaluate login limit.')
  return {
    allowed: row.blockedUntil === null || row.blockedUntil <= now,
    retryAfter: row.blockedUntil ? Math.max(0, row.blockedUntil - now) : 0,
  }
}

export async function consumePublicRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
) {
  const now = Math.floor(Date.now() / 1000)
  const cutoff = now - windowSeconds
  const [limitResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO public_rate_limits (key, count, window_started)
     VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE
         WHEN window_started <= ?3 THEN 1
         ELSE count + 1
       END,
       window_started = CASE
         WHEN window_started <= ?3 THEN ?2
         ELSE window_started
       END
     RETURNING count, window_started AS windowStarted`,
    ).bind(key, now, cutoff),
    env.DB.prepare(
      `DELETE FROM public_rate_limits
       WHERE window_started < ?1 AND key <> ?2`,
    ).bind(now - 24 * 60 * 60, key),
  ])
  const row = limitResult.results[0] as
    { count: number; windowStarted: number } | undefined
  if (!row) throw new Error('Could not evaluate public rate limit.')
  return {
    allowed: row.count <= limit,
    retryAfter: Math.max(1, row.windowStarted + windowSeconds - now),
  }
}

export async function clearLoginLimits(keys: string[]) {
  if (!keys.length) return
  await getDb()
    .delete(adminLoginAttemptsTable)
    .where(inArray(adminLoginAttemptsTable.key, keys))
}

export async function createAdminSession(input: {
  id: string
  username: string
  credentialVersion: string
  expiresAt: Date
}) {
  const now = new Date()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE admin_sessions SET revoked_at = ?2
       WHERE username = ?1 AND revoked_at IS NULL`,
    ).bind(input.username, Math.floor(now.getTime() / 1000)),
    env.DB.prepare(
      `INSERT INTO admin_sessions (
         id, username, credential_version, created_at, expires_at, revoked_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
    ).bind(
      input.id,
      input.username,
      input.credentialVersion,
      Math.floor(now.getTime() / 1000),
      Math.floor(input.expiresAt.getTime() / 1000),
    ),
  ])
}

export async function getAdminSessionRecord(id: string) {
  return (
    await getDb()
      .select()
      .from(adminSessionsTable)
      .where(eq(adminSessionsTable.id, id))
      .limit(1)
  ).at(0)
}

export async function revokeAdminSession(id: string) {
  await getDb()
    .update(adminSessionsTable)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(adminSessionsTable.id, id), isNull(adminSessionsTable.revokedAt)),
    )
}

export async function revokeAllAdminSessions(username: string) {
  await getDb()
    .update(adminSessionsTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(adminSessionsTable.username, username),
        isNull(adminSessionsTable.revokedAt),
      ),
    )
}

export async function cleanupAuthRecords() {
  const db = getDb()
  const now = new Date()
  const staleAttempts = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const staleSessions = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  await db
    .delete(adminLoginAttemptsTable)
    .where(
      and(
        lt(adminLoginAttemptsTable.windowStarted, staleAttempts),
        or(
          isNull(adminLoginAttemptsTable.blockedUntil),
          lt(adminLoginAttemptsTable.blockedUntil, now),
        ),
      ),
    )
  await db
    .delete(adminSessionsTable)
    .where(
      or(
        lt(adminSessionsTable.expiresAt, staleSessions),
        and(
          isNotNull(adminSessionsTable.revokedAt),
          lt(adminSessionsTable.revokedAt, staleSessions),
        ),
      ),
    )
  await db
    .delete(publicRateLimitsTable)
    .where(lt(publicRateLimitsTable.windowStarted, staleAttempts))
}

async function loadTagState() {
  const db = getDb()
  const [tagRows, aliasRows, parentRows, assignments] = await Promise.all([
    db.select().from(tagsTable),
    db.select().from(tagAliasesTable),
    db.select().from(tagParentsTable),
    db
      .select({
        siteId: siteTagsTable.siteId,
        tagId: siteTagsTable.tagId,
        status: sitesTable.status,
        source: sitesTable.source,
        submissionStatus: submissionsTable.status,
      })
      .from(siteTagsTable)
      .innerJoin(sitesTable, eq(siteTagsTable.siteId, sitesTable.id))
      .leftJoin(
        submissionsTable,
        eq(sitesTable.submissionId, submissionsTable.id),
      ),
  ])
  const byId = new Map(tagRows.map((tag) => [tag.id, tag]))
  const aliasesById = new Map<number, string[]>()
  for (const alias of aliasRows) {
    const values = aliasesById.get(alias.tagId) || []
    values.push(alias.alias)
    aliasesById.set(alias.tagId, values)
  }
  const parentsById = new Map<number, number[]>()
  for (const relation of parentRows) {
    const values = parentsById.get(relation.childTagId) || []
    values.push(relation.parentTagId)
    parentsById.set(relation.childTagId, values)
  }
  const directSites = new Map<number, Set<number>>()
  const inheritedSites = new Map<number, Set<number>>()
  for (const assignment of assignments) {
    if (
      assignment.status !== 'active' ||
      (assignment.source === 'Submission' &&
        assignment.submissionStatus !== 'approved')
    )
      continue
    const direct = directSites.get(assignment.tagId) || new Set<number>()
    direct.add(assignment.siteId)
    directSites.set(assignment.tagId, direct)
    const pending = [assignment.tagId]
    const visited = new Set<number>()
    while (pending.length) {
      const id = pending.pop()
      if (!id || visited.has(id)) continue
      visited.add(id)
      const sites = inheritedSites.get(id) || new Set<number>()
      sites.add(assignment.siteId)
      inheritedSites.set(id, sites)
      pending.push(...(parentsById.get(id) || []))
    }
  }
  const records: AdminTagRecord[] = tagRows.map((tag) => ({
    id: tag.id,
    slug: tag.slug,
    name: tag.name,
    category: isTagCategory(tag.category) ? tag.category : 'Topic',
    canonical: tag.canonical,
    aliases: aliasesById.get(tag.id) || [],
    parents: (parentsById.get(tag.id) || [])
      .map((id) => byId.get(id)?.slug)
      .filter((slug): slug is string => Boolean(slug)),
    directCount: directSites.get(tag.id)?.size || 0,
    count: inheritedSites.get(tag.id)?.size || 0,
  }))
  return {
    catalog: records.filter((tag) => tag.canonical),
    records,
    tokenById: new Map(
      records.map((tag) => [
        tag.id,
        tag.canonical ? tag.slug : normalizeFreeformTag(tag.name),
      ]),
    ),
  }
}

async function hydrateSites(
  rows: SiteRow[],
  tagState: Awaited<ReturnType<typeof loadTagState>>,
): Promise<SiteEntry[]> {
  if (!rows.length) return []
  const tagRows = await getDb()
    .select()
    .from(siteTagsTable)
    .where(
      inArray(
        siteTagsTable.siteId,
        rows.map((row) => row.id),
      ),
    )
  const tagsBySite = new Map<number, string[]>()
  for (const tag of tagRows) {
    const values = tagsBySite.get(tag.siteId) || []
    const token = tagState.tokenById.get(tag.tagId)
    if (token && !values.includes(token)) values.push(token)
    tagsBySite.set(tag.siteId, values)
  }
  return rows.map((row) => mapSite(row, tagsBySite.get(row.id) || []))
}

async function ensureStoredTags(rawTags: string[]) {
  const db = getDb()
  const result: Array<{ id: number; rawName: string }> = []
  let [storedTags, aliases] = await Promise.all([
    db.select().from(tagsTable),
    db.select().from(tagAliasesTable),
  ])
  const normalizedTags = [
    ...new Set(rawTags.map(normalizeFreeformTag).filter(Boolean)),
  ]
  for (const rawTag of normalizedTags) {
    if (!tagSlug(rawTag)) {
      throw new Error(`Tag must contain a letter or number: ${rawTag}`)
    }
  }
  const knownSlugs = new Set(storedTags.map((tag) => tag.slug))
  const aliasNames = new Set(aliases.map((alias) => alias.alias))
  const missing = normalizedTags
    .filter(
      (rawTag) => !knownSlugs.has(tagSlug(rawTag)) && !aliasNames.has(rawTag),
    )
    .map((rawTag) => ({ slug: tagSlug(rawTag), name: rawTag }))
  if (missing.length) {
    await env.DB.prepare(
      `INSERT INTO tags (slug, name, category, canonical)
       SELECT json_extract(value, '$.slug'), json_extract(value, '$.name'),
              'Topic', 0 FROM json_each(?1)
       ON CONFLICT(slug) DO NOTHING`,
    )
      .bind(JSON.stringify(missing))
      .run()
    ;[storedTags, aliases] = await Promise.all([
      db.select().from(tagsTable),
      db.select().from(tagAliasesTable),
    ])
  }
  const bySlug = new Map(storedTags.map((tag) => [tag.slug, tag]))
  const aliasTargets = new Map(
    aliases.map((alias) => [alias.alias, alias.tagId]),
  )
  const byId = new Map(storedTags.map((tag) => [tag.id, tag]))
  const seenIds = new Set<number>()
  for (const rawTag of normalizedTags) {
    const slug = tagSlug(rawTag)
    let storedTag = bySlug.get(slug)
    if (!storedTag) {
      const aliasTarget = aliasTargets.get(rawTag)
      storedTag = aliasTarget ? byId.get(aliasTarget) : undefined
    }
    if (!storedTag) {
      storedTag = storedTags.find(
        (tag) => tag.canonical && normalizeTag(tag.name) === rawTag,
      )
    }
    if (!storedTag) throw new Error(`Could not create tag: ${rawTag}`)
    if (seenIds.has(storedTag.id)) continue
    seenIds.add(storedTag.id)
    result.push({
      id: storedTag.id,
      rawName: storedTag.canonical ? storedTag.slug : rawTag,
    })
  }
  return result
}

async function uniqueSiteSlug(name: string) {
  const db = getDb()
  const base = tagSlug(name) || `site-${crypto.randomUUID()}`
  let slug = base
  let suffix = 2
  while (
    (
      await db
        .select({ id: sitesTable.id })
        .from(sitesTable)
        .where(eq(sitesTable.slug, slug))
        .limit(1)
    ).length
  ) {
    slug = `${base}-${suffix++}`
  }
  return slug
}

function mapSite(row: SiteRow, tags: string[]): SiteEntry {
  return {
    slug: row.slug,
    name: row.name,
    externalUrl: row.url,
    description: row.description,
    summary: row.summary,
    tags,
    categories: row.categories,
    poster: row.poster,
    notes: row.notes,
    facts: row.facts,
    visits: row.visits,
    added: row.addedAt.toISOString().slice(0, 10),
    addedLabel: formatShortDate(row.addedAt),
    accent: row.accent,
    thumbnailKey: row.thumbnailKey || undefined,
    thumbnailAlt: row.thumbnailAlt || undefined,
  }
}

function mapSubmission(row: SubmissionRow): RecentFiling {
  return {
    name: row.name,
    url: row.url,
    description: row.description,
    tags: row.tags,
    date: formatShortDate(row.submittedAt),
    thumbnailKey: row.thumbnailKey || undefined,
    thumbnailAlt: row.thumbnailAlt || undefined,
  }
}

function formatShortDate(date: Date) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function generatedPoster(name: string) {
  return name.split(/\s+/).slice(0, 2).join(' ').toUpperCase()
}

function normalizeFreeformTag(value: string) {
  return normalizeTag(value).replace(/^~+/, '').trim()
}

function isTagCategory(value: string): value is CanonicalTag['category'] {
  return ['Activity', 'Medium', 'Mood', 'Topic'].includes(value)
}
