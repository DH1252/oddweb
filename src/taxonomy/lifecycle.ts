import { normalizeTag, tagSlug } from '../data/tags'
import {
  normalizeTaxonomyTag,
  normalizeTaxonomyText,
  sha256Hex,
  stableJson,
} from './normalize'

export type SiteTaxonomyMetadata = {
  name: string
  description: string
  summary: string
  notes: readonly string[]
  facts: ReadonlyArray<{ label: string; value: string }>
  rawTagHints: readonly string[]
}

type TaxonomyTag = {
  id: number
  slug: string
  name: string
  canonical: number
  status: string
}

type TaxonomyAlias = {
  alias: string
  tagId: number
}

export type ResolvedTaxonomyHint = {
  tagId?: number
  slug: string
  rawName: string
  normalizedConcept: string
  novel: boolean
}

type SiteTarget =
  | { kind: 'id'; value: number }
  | { kind: 'slug'; value: string }
  | { kind: 'submission'; value: number }

export type SiteTaxonomyLifecycleInput = {
  target: SiteTarget
  metadataHash: string
  contentVersion: number
  rawTagHints: readonly string[]
  assignmentSource: 'deterministic' | 'admin'
  preserveAdminAssignments?: boolean
  enqueueClassification: boolean
}

export function preserveRawTagHints(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function normalizeSiteTaxonomyMetadata(input: SiteTaxonomyMetadata) {
  return {
    name: normalizeTaxonomyText(input.name),
    description: normalizeTaxonomyText(input.description),
    summary: normalizeTaxonomyText(input.summary),
    notes: input.notes.map(normalizeTaxonomyText).filter(Boolean),
    factsText: input.facts
      .map(({ label, value }) => {
        const normalizedLabel = normalizeTaxonomyText(label)
        const normalizedValue = normalizeTaxonomyText(value)
        return normalizedLabel
          ? `${normalizedLabel}: ${normalizedValue}`.trim()
          : normalizedValue
      })
      .filter(Boolean),
    rawHints: [
      ...new Set(
        preserveRawTagHints(input.rawTagHints)
          .map(normalizeHint)
          .filter(Boolean),
      ),
    ].sort((left, right) => left.localeCompare(right, 'en-US')),
  }
}

export function hashSiteTaxonomyMetadata(
  input: SiteTaxonomyMetadata,
): Promise<string> {
  return sha256Hex(stableJson(normalizeSiteTaxonomyMetadata(input)))
}

export function resolveTaxonomyHints(
  rawTagHints: readonly string[],
  tags: readonly TaxonomyTag[],
  aliases: readonly TaxonomyAlias[],
): ResolvedTaxonomyHint[] {
  const active = tags
    .filter((tag) => tag.status === 'active')
    .sort(
      (left, right) =>
        Number(right.canonical) - Number(left.canonical) || left.id - right.id,
    )
  const canonical = active.filter((tag) => Boolean(tag.canonical))
  const standalone = active.filter((tag) => !tag.canonical)
  const canonicalBySlug = firstBy(canonical, (tag) => tag.slug)
  const canonicalByName = firstBy(canonical, (tag) => normalizeHint(tag.name))
  const standaloneBySlug = firstBy(standalone, (tag) => tag.slug)
  const standaloneByName = firstBy(standalone, (tag) => normalizeHint(tag.name))
  const activeById = new Map(active.map((tag) => [tag.id, tag]))
  const aliasTargets = firstBy(
    aliases
      .map((alias) => ({
        alias: alias.alias,
        tag: activeById.get(alias.tagId),
      }))
      .filter((entry): entry is { alias: string; tag: TaxonomyTag } =>
        Boolean(entry.tag),
      ),
    (entry) => normalizeHint(entry.alias),
  )
  const result: ResolvedTaxonomyHint[] = []
  const seen = new Set<string>()

  for (const rawName of preserveRawTagHints(rawTagHints)) {
    const normalizedConcept = normalizeHint(rawName)
    const slug = tagSlug(normalizedConcept)
    if (!slug)
      throw new Error(`Tag must contain a letter or number: ${rawName}`)
    const tag =
      canonicalBySlug.get(slug) ??
      canonicalByName.get(normalizedConcept) ??
      aliasTargets.get(normalizedConcept)?.tag ??
      standaloneBySlug.get(slug) ??
      standaloneByName.get(normalizedConcept)
    const key = tag ? `id:${tag.id}` : `slug:${slug}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      ...(tag ? { tagId: tag.id } : {}),
      slug: tag?.slug ?? slug,
      rawName,
      normalizedConcept,
      novel: !tag,
    })
  }

  return result
}

export async function prepareSiteTaxonomyLifecycle(
  db: D1Database,
  input: SiteTaxonomyLifecycleInput,
): Promise<D1PreparedStatement[]> {
  if (!/^[a-f0-9]{64}$/i.test(input.metadataHash)) {
    throw new TypeError('metadataHash must be a SHA-256 hex digest')
  }
  if (!Number.isInteger(input.contentVersion) || input.contentVersion < 1) {
    throw new TypeError('contentVersion must be a positive integer')
  }
  const [tagRows, aliasRows] = await Promise.all([
    db
      .prepare('SELECT id, slug, name, canonical, status FROM tags')
      .all<TaxonomyTag>(),
    db
      .prepare('SELECT alias, tag_id AS tagId FROM tag_aliases')
      .all<TaxonomyAlias>(),
  ])
  const hints = resolveTaxonomyHints(
    input.rawTagHints,
    tagRows.results,
    aliasRows.results,
  )
  const novel = hints.filter((hint) => hint.novel)
  const target = siteTarget(input.target)
  const jobKey = jobKeySql(input.metadataHash)
  const statements: D1PreparedStatement[] = []

  if (novel.length) {
    statements.push(
      db
        .prepare(
          `INSERT INTO tags (slug, name, canonical, status)
           SELECT json_extract(value, '$.slug'), json_extract(value, '$.rawName'), 0, 'active'
           FROM json_each(?1)
           WHERE true
           ON CONFLICT(slug) DO NOTHING`,
        )
        .bind(JSON.stringify(novel)),
    )
  }

  statements.push(
    db
      .prepare(
        `DELETE FROM site_tags
         WHERE site_id = (SELECT id FROM sites site WHERE ${target.sql})
           ${input.preserveAdminAssignments ? "AND source <> 'admin'" : ''}
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(?2) hint
             JOIN tags tag ON tag.id = json_extract(hint.value, '$.tagId')
               OR (json_extract(hint.value, '$.tagId') IS NULL
                   AND tag.slug = json_extract(hint.value, '$.slug'))
             WHERE tag.id = site_tags.tag_id
           )`,
      )
      .bind(target.value, JSON.stringify(hints)),
    db
      .prepare(
        `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
         SELECT site.id, tag.id, json_extract(hint.value, '$.rawName'), ?2
         FROM sites site
         JOIN json_each(?3) hint
         JOIN tags tag ON tag.id = json_extract(hint.value, '$.tagId')
           OR (json_extract(hint.value, '$.tagId') IS NULL
               AND tag.slug = json_extract(hint.value, '$.slug'))
         WHERE ${target.sql} AND tag.status = 'active'
         ON CONFLICT(site_id, tag_id) ${
           input.preserveAdminAssignments
             ? 'DO NOTHING'
             : `DO UPDATE SET
                  raw_name = excluded.raw_name,
                  source = excluded.source,
                  decision_id = NULL,
                  revision = site_tags.revision + 1,
                  updated_at = unixepoch()
                WHERE site_tags.raw_name <> excluded.raw_name
                   OR site_tags.source <> excluded.source
                   OR site_tags.decision_id IS NOT NULL`
         }`,
      )
      .bind(target.value, input.assignmentSource, JSON.stringify(hints)),
  )

  if (!input.enqueueClassification) return statements

  const pendingJobId = `job-${crypto.randomUUID()}`
  statements.push(
    db
      .prepare(
        `INSERT INTO taxonomy_jobs (
           id, job_key, kind, site_id, input_hash, site_content_version,
           taxonomy_version, provider_config_id, policy_config_id, status,
           max_attempts
         )
         SELECT ?2, ${jobKey}, 'classify_site', site.id, ?3, ?4,
                state.published_version, state.active_provider_config_id,
                state.active_policy_config_id, 'pending',
                coalesce(policy.retry_budget, 0) + 1
         FROM sites site
         JOIN taxonomy_state state ON state.id = 1
         LEFT JOIN taxonomy_policy_configs policy
           ON policy.id = state.active_policy_config_id
         WHERE ${target.sql}
         ON CONFLICT(job_key) DO NOTHING`,
      )
      .bind(
        target.value,
        pendingJobId,
        input.metadataHash,
        input.contentVersion,
      ),
    db
      .prepare(
        `INSERT INTO taxonomy_outbox (id, job_id, payload)
         SELECT ?2, job.id, json_object('jobId', job.id)
         FROM sites site
         JOIN taxonomy_state state ON state.id = 1
         JOIN taxonomy_jobs job ON job.job_key = ${jobKey}
         WHERE ${target.sql}
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(target.value, `outbox-${crypto.randomUUID()}`),
  )

  if (novel.length) {
    const evidence = await Promise.all(
      novel.map(async (hint) => ({
        ...hint,
        id: `evidence-${crypto.randomUUID()}`,
        sourceKey: `raw-hint:${hint.normalizedConcept}`,
        evidenceHash: await sha256Hex(
          stableJson({
            concept: hint.normalizedConcept,
            rawHint: hint.rawName,
          }),
        ),
      })),
    )
    statements.push(
      db
        .prepare(
          `INSERT INTO taxonomy_concept_evidence (
             id, normalized_concept, site_id, input_hash, source_key, source,
             policy_config_id, job_id, evidence_hash, evidence_snippet,
             confidence_micros, accepted
           )
           SELECT json_extract(evidence.value, '$.id'),
                  json_extract(evidence.value, '$.normalizedConcept'), site.id,
                  ?2, json_extract(evidence.value, '$.sourceKey'), 'submitted_hint',
                  state.active_policy_config_id, job.id,
                  json_extract(evidence.value, '$.evidenceHash'),
                  json_extract(evidence.value, '$.rawName'), 1000000, 1
           FROM sites site
           JOIN taxonomy_state state ON state.id = 1
           JOIN taxonomy_jobs job ON job.job_key = ${jobKey}
           JOIN json_each(?3) evidence
           WHERE ${target.sql}
           ON CONFLICT(normalized_concept, site_id, input_hash, source_key)
           DO NOTHING`,
        )
        .bind(target.value, input.metadataHash, JSON.stringify(evidence)),
    )
  }

  return statements
}

function normalizeHint(value: string) {
  return normalizeTag(normalizeTaxonomyTag(value)).replace(/^~+/, '').trim()
}

function firstBy<T>(values: readonly T[], key: (value: T) => string) {
  const result = new Map<string, T>()
  for (const value of values) {
    const entryKey = key(value)
    if (entryKey && !result.has(entryKey)) result.set(entryKey, value)
  }
  return result
}

function siteTarget(target: SiteTarget) {
  if (target.kind === 'id') return { sql: 'site.id = ?1', value: target.value }
  if (target.kind === 'slug')
    return { sql: 'site.slug = ?1', value: target.value }
  return { sql: 'site.submission_id = ?1', value: target.value }
}

function jobKeySql(metadataHash: string) {
  return `'site:' || site.id || ':input:${metadataHash}:taxonomy:' ||
    state.published_version || ':classifier:' ||
    coalesce(state.active_policy_config_id, 0) || '-' ||
    coalesce(state.active_provider_config_id, 0)`
}
