import { websiteUrlKey } from '../lib/website-url'
import {
  hashSiteTaxonomyMetadata,
  prepareSiteTaxonomyLifecycle,
  preserveRawTagHints,
} from './lifecycle'

export type SiteUpdateInput = {
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
}

export type SiteUpdateSnapshot = {
  name: string
  url: string
  description: string
  summary: string
  categories: string[]
  poster: string
  notes: string[]
  facts: { label: string; value: string }[]
  accent: string
  status: 'active' | 'archived'
  contentVersion: number
  classificationInputHash: string | null
  thumbnailKey: string | null
  thumbnailAlt: string | null
}

export async function updateSiteFromSnapshot(
  db: D1Database,
  input: SiteUpdateInput,
  existing: SiteUpdateSnapshot,
) {
  const rawTagHints = preserveRawTagHints(input.tags)
  const metadataHash = await hashSiteTaxonomyMetadata({
    name: input.name,
    url: input.url,
    description: input.description,
    summary: input.summary,
    notes: input.notes,
    facts: input.facts,
    rawTagHints,
  })
  const changed = metadataHash !== existing.classificationInputHash
  const contentVersion = existing.contentVersion + Number(changed)
  const version = await db
    .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
    .first<number>('published_version')
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    throw new Error('Taxonomy state is unavailable.')
  }
  const lifecycle = await prepareSiteTaxonomyLifecycle(db, {
    target: { kind: 'id', value: input.id },
    expectedTaxonomyVersion: Number(version),
    metadataHash,
    contentVersion,
    rawTagHints,
    assignmentSource: 'admin',
    enqueueClassification: changed,
  })
  const urlKey = websiteUrlKey(input.url)
  const thumbnailKey = input.thumbnailKey ?? existing.thumbnailKey
  await db.batch([
    db
      .prepare(
        `UPDATE sites
         SET name = ?1, url = ?2, url_key = ?3, description = ?4, summary = ?5,
             categories = ?6, poster = ?7, notes = ?8, facts = ?9, accent = ?10,
             status = ?11, thumbnail_key = ?12, thumbnail_alt = ?13,
             content_version = ?14, classification_input_hash = ?15,
             updated_at = CASE WHEN ?16 = 1 THEN unixepoch() ELSE updated_at END
         WHERE id = ?17 AND content_version = ?18
           AND classification_input_hash IS ?19
           AND name = ?20 AND url = ?21 AND description = ?22 AND summary = ?23
           AND categories = ?24 AND poster = ?25 AND notes = ?26 AND facts = ?27
           AND accent = ?28 AND status = ?29 AND thumbnail_key IS ?30
           AND thumbnail_alt IS ?31`,
      )
      .bind(
        input.name,
        input.url,
        urlKey,
        input.description,
        input.summary,
        JSON.stringify(input.categories),
        input.poster,
        JSON.stringify(input.notes),
        JSON.stringify(input.facts),
        input.accent,
        input.status,
        thumbnailKey,
        input.thumbnailAlt,
        contentVersion,
        metadataHash,
        Number(changed),
        input.id,
        existing.contentVersion,
        existing.classificationInputHash,
        existing.name,
        existing.url,
        existing.description,
        existing.summary,
        JSON.stringify(existing.categories),
        existing.poster,
        JSON.stringify(existing.notes),
        JSON.stringify(existing.facts),
        existing.accent,
        existing.status,
        existing.thumbnailKey,
        existing.thumbnailAlt,
      ),
    db.prepare(
      `SELECT CASE WHEN changes() = 1
       THEN 1 ELSE json_extract('site update conflict', '$') END`,
    ),
    ...lifecycle,
  ])
  return {
    previousThumbnailKey: existing.thumbnailKey,
    thumbnailKey,
  }
}
