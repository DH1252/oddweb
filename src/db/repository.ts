import { env } from 'cloudflare:workers'
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import { sites as seedSites } from '../data/sites'
import { canonicalTags, resolveTagSlug, tagSlug } from '../data/tags'
import { websiteUrlKey } from '../lib/website-url'
import {
  commitSubmissionReapproval,
  hashSiteTaxonomyMetadata,
  prepareSiteTaxonomyLifecycle,
  preserveRawTagHints,
} from '../taxonomy/lifecycle'
import { dispatchTaxonomyOutbox } from '../taxonomy/runtime'
import { updateSiteFromSnapshot } from '../taxonomy/site-update'
import { getDb } from './index'
import {
  adminLoginAttemptsTable,
  adminSessionsTable,
  guestbookTable,
  publicRateLimitsTable,
  sitesTable,
  submissionsTable,
} from './schema'

import type { RecentFiling, SiteEntry } from '../data/sites'
import type { CanonicalTag } from '../data/tags'
import { consumeSubmissionRateLimit as consumeSlidingSubmissionRateLimit } from './submission-rate-limit'

export type GuestbookEntry = {
  id: number
  name: string
  message: string
  date: string
  createdAt?: number
  hidden?: boolean
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

const seededKeys = new Set<string>()

export async function ensureSeedData() {
  const seedKey = 'catalog-seed-v2'
  if (seededKeys.has(seedKey)) return

  const seeded = await env.DB.prepare(
    'SELECT key FROM app_state WHERE key = ?1',
  )
    .bind(seedKey)
    .first()
  if (seeded) {
    seededKeys.add(seedKey)
    return
  }

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
      `INSERT INTO tags (slug, name, canonical)
       SELECT json_extract(value, '$.slug'), json_extract(value, '$.name'),
              1 FROM json_each(?1)
       WHERE true
       ON CONFLICT(slug) DO NOTHING`,
    ).bind(tagsJson),
    env.DB.prepare(
      `INSERT INTO tag_aliases (alias, tag_id)
       SELECT alias.value, tags.id
       FROM json_each(?1) definition
       JOIN tags ON tags.slug = json_extract(definition.value, '$.slug')
       JOIN json_each(json_extract(definition.value, '$.aliases')) alias
       WHERE true
       ON CONFLICT(alias) DO NOTHING`,
    ).bind(tagsJson),
    env.DB.prepare(
      `INSERT INTO tag_parents (parent_tag_id, child_tag_id)
       SELECT parent.id, child.id
       FROM json_each(?1) definition
       JOIN tags child ON child.slug = json_extract(definition.value, '$.slug')
       JOIN json_each(json_extract(definition.value, '$.parents')) relation
       JOIN tags parent ON parent.slug = relation.value
       WHERE true
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
       WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(sitesJson),
    env.DB.prepare(
      `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
       SELECT sites.id, tags.id, tags.slug, 'migration'
        FROM json_each(?1) definition
        JOIN sites ON sites.slug = json_extract(definition.value, '$.slug')
                  AND sites.source = 'Directory'
       JOIN json_each(json_extract(definition.value, '$.tagSlugs')) raw_tag
       JOIN tags ON tags.slug = raw_tag.value
       WHERE true
       ON CONFLICT(site_id, tag_id) DO NOTHING`,
    ).bind(sitesJson),
  ])
  const seedComplete = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM json_each(?1) definition
        JOIN tags ON tags.slug = json_extract(definition.value, '$.slug')) = json_array_length(?1)
       AND
       (SELECT count(*) FROM json_each(?2) definition
         JOIN sites ON sites.slug = json_extract(definition.value, '$.slug')
                   AND sites.source = 'Directory') = json_array_length(?2)
       AND
       (SELECT count(*)
        FROM json_each(?2) definition
        JOIN sites ON sites.slug = json_extract(definition.value, '$.slug')
                  AND sites.source = 'Directory'
        JOIN json_each(json_extract(definition.value, '$.tagSlugs')) raw_tag
        JOIN site_tags ON site_tags.site_id = sites.id
                      AND site_tags.raw_name = raw_tag.value)
       = (SELECT coalesce(sum(json_array_length(json_extract(value, '$.tagSlugs'))), 0)
          FROM json_each(?2))
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
  seededKeys.add(seedKey)
}

export async function createSubmission(input: {
  name: string
  url: string
  description: string
  tags: string[]
  thumbnailKey: string | null
  thumbnailAlt: string | null
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
        JSON.stringify(preserveRawTagHints(input.tags)),
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
      tags: preserveRawTagHints(input.tags),
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
  thumbnailKey: string | null
  thumbnailAlt: string | null
  status: 'active' | 'archived'
  source: 'Submission' | 'Manual'
}) {
  const db = getDb()
  const slug = await uniqueSiteSlug(input.name)
  const urlKey = websiteUrlKey(input.url)
  const rawTagHints = preserveRawTagHints(input.tags)
  const summary = input.description
  const notes = [input.description]
  const facts = [{ label: 'Address', value: new URL(input.url).hostname }]
  const metadataHash = await hashSiteTaxonomyMetadata({
    name: input.name,
    url: input.url,
    description: input.description,
    summary,
    notes,
    facts,
    rawTagHints,
  })
  const expectedTaxonomyVersion = await taxonomyPublishedVersion()
  const lifecycle = await prepareSiteTaxonomyLifecycle(env.DB, {
    target: { kind: 'slug', value: slug },
    expectedTaxonomyVersion,
    metadataHash,
    contentVersion: 1,
    rawTagHints,
    assignmentSource: 'admin',
    enqueueClassification: input.source === 'Manual',
  })
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sites (
         slug, name, url, url_key, description, summary, categories, poster, notes,
         facts, thumbnail_key, thumbnail_alt, status, source, content_version,
         classification_input_hash, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                  ?14, 1, ?15, unixepoch())`,
    ).bind(
      slug,
      input.name,
      input.url,
      urlKey,
      input.description,
      summary,
      JSON.stringify(['Recently added']),
      generatedPoster(input.name),
      JSON.stringify(notes),
      JSON.stringify(facts),
      input.thumbnailKey,
      input.thumbnailAlt,
      input.status,
      input.source,
      metadataHash,
    ),
    ...lifecycle,
  ])
  await dispatchTaxonomyOutbox(env, { limit: 25 })
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

export async function setGuestbookVisibility(id: number, hidden: boolean) {
  const updated = await getDb()
    .update(guestbookTable)
    .set({ hiddenAt: hidden ? new Date() : null })
    .where(eq(guestbookTable.id, id))
    .returning({ id: guestbookTable.id })
  if (!updated.length) throw new Error('Guestbook entry no longer exists.')
  return { id, hidden }
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
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.submissionId, submission.id))
      .limit(1)
  ).at(0)

  if (status === 'approved') {
    const rawTagHints = preserveRawTagHints(submission.tags)
    if (ownedSite) {
      const metadataHash = await hashSiteTaxonomyMetadata({
        name: ownedSite.name,
        url: ownedSite.url,
        description: ownedSite.description,
        summary: ownedSite.summary,
        notes: ownedSite.notes,
        facts: ownedSite.facts,
        rawTagHints,
      })
      const changed = metadataHash !== ownedSite.classificationInputHash
      const contentVersion = ownedSite.contentVersion + Number(changed)
      const expectedTaxonomyVersion = await taxonomyPublishedVersion()
      const lifecycle = await prepareSiteTaxonomyLifecycle(env.DB, {
        target: { kind: 'id', value: ownedSite.id },
        expectedTaxonomyVersion,
        metadataHash,
        contentVersion,
        rawTagHints,
        assignmentSource: 'deterministic',
        preserveAdminAssignments: true,
        enqueueClassification: changed,
      })
      await commitSubmissionReapproval(env.DB, {
        submissionId: submission.id,
        siteId: ownedSite.id,
        expectedContentVersion: ownedSite.contentVersion,
        expectedInputHash: ownedSite.classificationInputHash,
        expectedSubmission: submission,
        contentVersion,
        metadataHash,
        changed,
        lifecycle,
      })
      await dispatchTaxonomyOutbox(env, { limit: 25 })
      return
    }
    const slug = await uniqueSiteSlug(submission.name)
    const summary = submission.description
    const notes = [submission.description]
    const facts = [
      { label: 'Address', value: new URL(submission.url).hostname },
    ]
    const metadataHash = await hashSiteTaxonomyMetadata({
      name: submission.name,
      url: submission.url,
      description: submission.description,
      summary,
      notes,
      facts,
      rawTagHints,
    })
    const expectedTaxonomyVersion = await taxonomyPublishedVersion()
    const lifecycle = await prepareSiteTaxonomyLifecycle(env.DB, {
      target: { kind: 'submission', value: submission.id },
      expectedTaxonomyVersion,
      metadataHash,
      contentVersion: 1,
      rawTagHints,
      assignmentSource: 'deterministic',
      enqueueClassification: true,
    })
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE submissions
         SET status = 'approved', reviewed_at = unixepoch()
         WHERE id = ?1`,
      ).bind(submission.id),
      env.DB.prepare(
        `INSERT INTO sites (
           slug, name, url, url_key, description, summary, categories, poster, notes,
           facts, thumbnail_key, thumbnail_alt, status, source, submission_id,
           content_version, classification_input_hash, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    'active', 'Submission', ?13, 1, ?14, unixepoch())`,
      ).bind(
        slug,
        submission.name,
        submission.url,
        submission.urlKey,
        submission.description,
        summary,
        JSON.stringify(['Recently added']),
        generatedPoster(submission.name),
        JSON.stringify(notes),
        JSON.stringify(facts),
        submission.thumbnailKey,
        submission.thumbnailAlt || `Preview of ${submission.name}`,
        submission.id,
        metadataHash,
      ),
      ...lifecycle,
    ])
    await dispatchTaxonomyOutbox(env, { limit: 25 })
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
  summary: string
  categories: string[]
  poster: string
  notes: string[]
  facts: { label: string; value: string }[]
  accent: string
  tags: string[]
  status: 'active' | 'archived'
  thumbnailKey?: string
  thumbnailAlt: string
}) {
  const existing = (
    await getDb()
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, input.id))
      .limit(1)
  ).at(0)
  if (!existing) throw new Error('Site not found.')
  if (existing.source === 'Directory' && input.status !== existing.status) {
    throw new Error(
      'Bundled directory records cannot change publication status.',
    )
  }

  const result = await updateSiteFromSnapshot(env.DB, input, existing)
  await dispatchTaxonomyOutbox(env, { limit: 25 })
  return result
}

async function taxonomyPublishedVersion(db: D1Database = env.DB) {
  const version = await db
    .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
    .first<number>('published_version')
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    throw new Error('Taxonomy state is unavailable.')
  }
  return Number(version)
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

export async function findReferencedThumbnailKeys(keys: string[]) {
  if (keys.length === 0) return new Set<string>()
  const result = await env.DB.prepare(
    `SELECT DISTINCT candidate.value AS key
     FROM json_each(?1) candidate
     WHERE EXISTS(SELECT 1 FROM sites WHERE thumbnail_key = candidate.value)
        OR EXISTS(SELECT 1 FROM submissions WHERE thumbnail_key = candidate.value)`,
  )
    .bind(JSON.stringify(keys))
    .all<{ key: string }>()
  return new Set(result.results.map((row) => row.key))
}

export async function listReferencedThumbnailKeyBatch(
  afterKey: string | undefined,
  limit: number,
) {
  const result = await env.DB.prepare(
    `SELECT key FROM (
       SELECT thumbnail_key AS key FROM sites
       WHERE thumbnail_key IS NOT NULL AND thumbnail_key > ?1
       UNION
       SELECT thumbnail_key AS key FROM submissions
       WHERE thumbnail_key IS NOT NULL AND thumbnail_key > ?1
     )
     ORDER BY key
     LIMIT ?2`,
  )
    .bind(afterKey ?? '', limit + 1)
    .all<{ key: string }>()
  return {
    keys: result.results.slice(0, limit).map((row) => row.key),
    hasMore: result.results.length > limit,
  }
}

export async function saveTagDefinition(input: {
  id: number
  name: string
  aliases: string[]
  parents: string[]
}) {
  const { createTaxonomyService } = await import('../taxonomy')
  return createTaxonomyService(env).correctTag({
    ...input,
    actorId: 'legacy-admin',
  })
}

export async function mergeTagAsAlias(sourceId: number, targetSlug: string) {
  const { createTaxonomyService } = await import('../taxonomy')
  const target = await env.DB.prepare(
    'SELECT id FROM tags WHERE slug = ? AND canonical = 1',
  )
    .bind(targetSlug)
    .first<{ id: number }>()
  if (!target) throw new Error('Valid source and target tags are required.')
  return createTaxonomyService(env).correctMerge({
    sourceId,
    targetId: target.id,
    actorId: 'legacy-admin',
  })
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

export async function consumeSubmissionRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
) {
  return consumeSlidingSubmissionRateLimit(env.DB, key, limit, windowSeconds)
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

function generatedPoster(name: string) {
  return name.split(/\s+/).slice(0, 2).join(' ').toUpperCase()
}
