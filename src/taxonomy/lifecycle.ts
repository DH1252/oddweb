import { normalizeTag, tagSlug } from '../data/tags'
import { normalizeWebsiteUrl } from '../lib/website-url'
import {
  normalizeTaxonomyTag,
  normalizeTaxonomyText,
  sha256Hex,
  stableJson,
} from './normalize'

export type SiteTaxonomyMetadata = {
  name: string
  url: string
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
  revision: number
  mergedIntoTagId?: number | null
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
  expectedTaxonomyVersion: number
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
    url: normalizeWebsiteUrl(input.url),
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
  const tagById = new Map(tags.map((tag) => [tag.id, tag]))
  const mergedTargets = tags.flatMap((source) => {
    if (source.status !== 'merged') return []
    const visited = new Set<number>([source.id])
    let target = source.mergedIntoTagId
      ? tagById.get(source.mergedIntoTagId)
      : undefined
    while (
      target?.status === 'merged' &&
      target.mergedIntoTagId &&
      !visited.has(target.id)
    ) {
      visited.add(target.id)
      target = tagById.get(target.mergedIntoTagId)
    }
    return target?.status === 'active' ? [{ source, target }] : []
  })
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
  const mergedBySlug = firstBy(mergedTargets, ({ source }) => source.slug)
  const mergedByName = firstBy(mergedTargets, ({ source }) =>
    normalizeHint(source.name),
  )
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
      standaloneByName.get(normalizedConcept) ??
      mergedBySlug.get(slug)?.target ??
      mergedByName.get(normalizedConcept)?.target
    const key = tag ? `id:${tag.id}` : `slug:${slug}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      ...(tag ? { tagId: tag.id } : {}),
      slug: tag?.slug ?? slug,
      rawName,
      normalizedConcept:
        tag && !tag.canonical ? normalizeHint(tag.name) : normalizedConcept,
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
  if (
    !Number.isSafeInteger(input.expectedTaxonomyVersion) ||
    input.expectedTaxonomyVersion < 1
  ) {
    throw new TypeError('expectedTaxonomyVersion must be a positive integer')
  }
  const [tagRows, aliasRows] = await Promise.all([
    db
      .prepare(
        `SELECT id, slug, name, canonical, status, revision,
                 merged_into_tag_id AS mergedIntoTagId FROM tags`,
      )
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
  const noncanonicalTagIds = new Set(
    tagRows.results
      .filter((tag) => tag.status === 'active' && !tag.canonical)
      .map((tag) => tag.id),
  )
  const evidenceHints = hints.filter(
    (hint) =>
      hint.novel ||
      (hint.tagId !== undefined && noncanonicalTagIds.has(hint.tagId)),
  )
  const target = siteTarget(input.target)
  const jobKey = jobKeySql(input.metadataHash)
  const tagSnapshot = JSON.stringify(
    tagRows.results.map((tag) => ({
      id: tag.id,
      status: tag.status,
      revision: tag.revision,
      mergedIntoTagId: tag.mergedIntoTagId ?? null,
    })),
  )
  const aliasSnapshot = JSON.stringify(
    aliasRows.results.map((alias) => ({
      alias: alias.alias,
      tagId: alias.tagId,
    })),
  )
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT CASE WHEN
           (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?1
           AND (SELECT count(*) FROM tags) = json_array_length(?2)
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?2) expected
             WHERE NOT EXISTS (
               SELECT 1 FROM tags tag
               WHERE tag.id = json_extract(expected.value, '$.id')
                 AND tag.status = json_extract(expected.value, '$.status')
                 AND tag.revision = json_extract(expected.value, '$.revision')
                 AND tag.merged_into_tag_id IS json_extract(expected.value, '$.mergedIntoTagId')
             )
           )
           AND (SELECT count(*) FROM tag_aliases) = json_array_length(?3)
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?3) expected
             WHERE NOT EXISTS (
               SELECT 1 FROM tag_aliases alias
               WHERE alias.alias = json_extract(expected.value, '$.alias')
                 AND alias.tag_id = json_extract(expected.value, '$.tagId')
             )
           )
         THEN 1 ELSE json_extract('taxonomy lifecycle snapshot changed', '$') END`,
      )
      .bind(input.expectedTaxonomyVersion, tagSnapshot, aliasSnapshot),
  ]

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

  if (evidenceHints.length) {
    const evidence = await Promise.all(
      evidenceHints.map(async (hint) => {
        const conceptInputHash = await sha256Hex(
          stableJson({ concept: hint.normalizedConcept }),
        )
        return {
          ...hint,
          id: `evidence-${crypto.randomUUID()}`,
          sourceKey: `raw-hint:${hint.normalizedConcept}`,
          evidenceHash: await sha256Hex(
            stableJson({
              concept: hint.normalizedConcept,
              rawHint: hint.rawName,
            }),
          ),
          conceptInputHash,
          jobKeyPrefix: `concept:${encodeURIComponent(hint.normalizedConcept)}:input:${conceptInputHash}:taxonomy:`,
          jobId: `tax:${crypto.randomUUID()}`,
          outboxId: `outbox-${crypto.randomUUID()}`,
        }
      }),
    )
    const concepts = [
      ...new Map(
        evidence.map((entry) => [entry.normalizedConcept, entry]),
      ).values(),
    ]
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
      db
        .prepare(
          `UPDATE taxonomy_outbox
           SET dispatched_at = NULL, available_at = unixepoch(),
               lease_token = NULL, leased_until = NULL, last_error = NULL
           WHERE job_id IN (
             SELECT job.id
             FROM taxonomy_state state
             JOIN taxonomy_policy_configs policy
               ON policy.id = state.active_policy_config_id
             JOIN json_each(?1) concept
             JOIN taxonomy_jobs job
               ON job.job_key = json_extract(concept.value, '$.jobKeyPrefix') ||
                                state.published_version || ':provider:' ||
                                coalesce(state.active_provider_config_id, 0)
              WHERE state.id = 1 AND job.kind = 'reassess_concept'
                AND job.status IN
                    ('succeeded','settled','obsolete','dead','cancelled','degraded')
                AND EXISTS (
                  SELECT 1 FROM taxonomy_concept_evidence inserted
                  WHERE inserted.id = json_extract(concept.value, '$.id')
                )
                AND (SELECT count(DISTINCT site_id)
                    FROM taxonomy_concept_evidence
                    WHERE normalized_concept =
                          json_extract(concept.value, '$.normalizedConcept')
                      AND accepted = 1) >= policy.novel_evidence_site_threshold
           )`,
        )
        .bind(JSON.stringify(concepts)),
      db
        .prepare(
          `INSERT INTO taxonomy_jobs (
             id, job_key, kind, concept_key, input_hash, taxonomy_version,
             provider_config_id, policy_config_id, status, max_attempts
           )
           SELECT json_extract(concept.value, '$.jobId'),
                  json_extract(concept.value, '$.jobKeyPrefix') ||
                    state.published_version || ':provider:' ||
                    coalesce(state.active_provider_config_id, 0),
                  'reassess_concept',
                  json_extract(concept.value, '$.normalizedConcept'),
                  json_extract(concept.value, '$.conceptInputHash'),
                  state.published_version, state.active_provider_config_id,
                  policy.id, 'pending', max(1, policy.retry_budget + 1)
           FROM taxonomy_state state
           JOIN taxonomy_policy_configs policy
             ON policy.id = state.active_policy_config_id
           JOIN json_each(?1) concept
            WHERE state.id = 1
              AND EXISTS (
                SELECT 1 FROM taxonomy_concept_evidence inserted
                WHERE inserted.id = json_extract(concept.value, '$.id')
              )
               AND (SELECT count(DISTINCT site_id)
                   FROM taxonomy_concept_evidence
                   WHERE normalized_concept =
                         json_extract(concept.value, '$.normalizedConcept')
                     AND accepted = 1) >= policy.novel_evidence_site_threshold
            ON CONFLICT(job_key) DO UPDATE SET
              concept_key = excluded.concept_key,
              input_hash = excluded.input_hash,
              taxonomy_version = excluded.taxonomy_version,
              provider_config_id = excluded.provider_config_id,
              policy_config_id = excluded.policy_config_id,
              max_attempts = excluded.max_attempts,
              status = 'pending', available_at = unixepoch(),
              lease_owner = NULL, lease_token = NULL, leased_until = NULL,
              attempt_count = 0, completed_at = NULL, updated_at = unixepoch(),
              last_error_code = NULL, last_error_summary = NULL
             WHERE taxonomy_jobs.kind = 'reassess_concept'
               AND taxonomy_jobs.status IN
                   ('succeeded','settled','obsolete','dead','cancelled','degraded')
               AND (SELECT count(DISTINCT site_id)
                    FROM taxonomy_concept_evidence
                    WHERE normalized_concept =
                          taxonomy_jobs.concept_key
                      AND accepted = 1) >
                   (SELECT count(DISTINCT site_id)
                    FROM taxonomy_concept_evidence
                    WHERE normalized_concept =
                          taxonomy_jobs.concept_key
                      AND accepted = 1
                      AND observed_at <= coalesce(taxonomy_jobs.completed_at,
                                                   taxonomy_jobs.updated_at))`,
        )
        .bind(JSON.stringify(concepts)),
      db
        .prepare(
          `INSERT INTO taxonomy_outbox (id, job_id, payload)
           SELECT json_extract(concept.value, '$.outboxId'), job.id,
                  json_object('jobId', job.id)
           FROM taxonomy_state state
           JOIN json_each(?1) concept
           JOIN taxonomy_jobs job
             ON job.job_key = json_extract(concept.value, '$.jobKeyPrefix') ||
                              state.published_version || ':provider:' ||
                              coalesce(state.active_provider_config_id, 0)
           WHERE state.id = 1
           ON CONFLICT(job_id) DO NOTHING`,
        )
        .bind(JSON.stringify(concepts)),
    )
  }

  return statements
}

export async function commitSubmissionReapproval(
  db: D1Database,
  input: {
    submissionId: number
    siteId: number
    expectedContentVersion: number
    expectedInputHash: string | null
    expectedSubmission: {
      name: string
      url: string
      urlKey: string
      description: string
      tags: string[]
      thumbnailKey: string | null
      thumbnailAlt: string | null
      submittedAt: Date
    }
    contentVersion: number
    metadataHash: string
    changed: boolean
    lifecycle: readonly D1PreparedStatement[]
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE submissions
         SET status = 'approved', reviewed_at = unixepoch()
         WHERE id = ?1 AND status = 'pending' AND name = ?2 AND url = ?3
           AND url_key = ?4 AND description = ?5 AND tags = ?6
           AND thumbnail_key IS ?7 AND thumbnail_alt IS ?8 AND submitted_at = ?9`,
      )
      .bind(
        input.submissionId,
        input.expectedSubmission.name,
        input.expectedSubmission.url,
        input.expectedSubmission.urlKey,
        input.expectedSubmission.description,
        JSON.stringify(input.expectedSubmission.tags),
        input.expectedSubmission.thumbnailKey,
        input.expectedSubmission.thumbnailAlt,
        Math.floor(input.expectedSubmission.submittedAt.getTime() / 1000),
      ),
    db.prepare(
      `SELECT CASE WHEN changes() = 1
       THEN 1 ELSE json_extract('submission approval input changed', '$') END`,
    ),
    db
      .prepare(
        `UPDATE sites
         SET status = 'active', content_version = ?2,
             classification_input_hash = ?3,
             updated_at = CASE WHEN ?4 = 1 THEN unixepoch() ELSE updated_at END
         WHERE id = ?1 AND source = 'Submission' AND content_version = ?5
           AND classification_input_hash IS ?6`,
      )
      .bind(
        input.siteId,
        input.contentVersion,
        input.metadataHash,
        Number(input.changed),
        input.expectedContentVersion,
        input.expectedInputHash,
      ),
    db.prepare(
      `SELECT CASE WHEN changes() = 1
       THEN 1 ELSE json_extract('submission approval site changed', '$') END`,
    ),
    ...input.lifecycle,
  ])
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
