import { sha256Hex, stableJson } from './normalize'
import type {
  CandidateSnapshot,
  ProviderConfig,
  RuntimePolicy,
  SiteSnapshot,
  TagSnapshot,
  TaxonomyJob,
  TaxonomyMode,
  TaxonomyState,
} from './runtime-types'

type BindValue = ArrayBuffer | ArrayBufferView | null | number | string
type Row = Record<string, unknown>

function integer(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`Invalid integer column: ${key}`)
  }
  return value
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key)
}

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string')
    throw new TypeError(`Invalid text column: ${key}`)
  return value
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key)
}

function statement(
  db: D1Database,
  sql: string,
  values: readonly BindValue[] = [],
): D1PreparedStatement {
  return db.prepare(sql).bind(...values)
}

async function first(
  db: D1Database,
  sql: string,
  values: readonly BindValue[] = [],
) {
  return statement(db, sql, values).first<Row>()
}

async function all(
  db: D1Database,
  sql: string,
  values: readonly BindValue[] = [],
) {
  const result = await statement(db, sql, values).all<Row>()
  return result.results
}

async function changes(
  db: D1Database,
  sql: string,
  values: readonly BindValue[] = [],
): Promise<number> {
  const result = await statement(db, sql, values).run()
  return result.meta.changes
}

function mapState(row: Row): TaxonomyState {
  return {
    publishedVersion: integer(row, 'published_version'),
    activeProviderConfigId: nullableInteger(row, 'active_provider_config_id'),
    activePolicyConfigId: nullableInteger(row, 'active_policy_config_id'),
    mode: text(row, 'mode') as TaxonomyMode,
    circuitState: text(row, 'circuit_state') as TaxonomyState['circuitState'],
    circuitReason: nullableText(row, 'circuit_reason'),
    circuitOpenedAt: nullableInteger(row, 'circuit_opened_at'),
    modeChangedAt: integer(row, 'mode_changed_at'),
  }
}

function mapPolicy(row: Row): RuntimePolicy {
  return {
    id: integer(row, 'id'),
    revision: integer(row, 'revision'),
    assignmentLimit: integer(row, 'assignment_limit'),
    novelEvidenceSiteThreshold: integer(row, 'novel_evidence_site_threshold'),
    assignmentConfidenceMicros: integer(row, 'assignment_confidence_micros'),
    ontologyConfidenceMicros: integer(row, 'ontology_confidence_micros'),
    minimumMarginMicros: integer(row, 'minimum_margin_micros'),
    hierarchyMaxDepth: integer(row, 'hierarchy_max_depth'),
    hierarchyMaxFanout: integer(row, 'hierarchy_max_fanout'),
    ontologyProviderAgreement: integer(row, 'ontology_provider_agreement'),
    retryBudget: integer(row, 'retry_budget'),
    retryBaseSeconds: integer(row, 'retry_base_seconds'),
    retryMaxSeconds: integer(row, 'retry_max_seconds'),
    rolloutBasisPoints: integer(row, 'rollout_basis_points'),
    dailyRequestBudget: integer(row, 'daily_request_budget'),
    dailyTokenBudget: integer(row, 'daily_token_budget'),
    schemaFailureTripBasisPoints: integer(
      row,
      'schema_failure_trip_basis_points',
    ),
    disagreementTripBasisPoints: integer(row, 'disagreement_trip_basis_points'),
    rollbackTripBasisPoints: integer(row, 'rollback_trip_basis_points'),
    mutationVolumeTripCount: integer(row, 'mutation_volume_trip_count'),
    rawResponseRetentionSeconds: integer(row, 'raw_response_retention_seconds'),
    shadowMinimumSamples: integer(row, 'shadow_minimum_samples'),
    shadowMinimumCoverageBasisPoints: integer(
      row,
      'shadow_minimum_coverage_basis_points',
    ),
    shadowSchemaSuccessBasisPoints: integer(
      row,
      'shadow_schema_success_basis_points',
    ),
    shadowProviderAgreementBasisPoints: integer(
      row,
      'shadow_provider_agreement_basis_points',
    ),
    promptHash: text(row, 'prompt_hash'),
    schemaHash: text(row, 'schema_hash'),
  }
}

function mapProvider(row: Row): ProviderConfig {
  return {
    id: integer(row, 'id'),
    name: text(row, 'name'),
    revision: integer(row, 'revision'),
    providerKind: text(row, 'provider_kind') as ProviderConfig['providerKind'],
    endpoint: text(row, 'endpoint'),
    model: text(row, 'model'),
    dialect: nullableText(row, 'dialect') as ProviderConfig['dialect'],
    routingGroup: text(row, 'routing_group'),
    routingRole: text(row, 'routing_role') as ProviderConfig['routingRole'],
    routingPriority: integer(row, 'routing_priority'),
    timeoutMs: integer(row, 'timeout_ms'),
    keyVersion: integer(row, 'key_version'),
    credentialNonce: text(row, 'credential_nonce'),
    credentialCiphertext: text(row, 'credential_ciphertext'),
  }
}

function mapJob(row: Row): TaxonomyJob {
  return {
    id: text(row, 'id'),
    jobKey: text(row, 'job_key'),
    kind: text(row, 'kind') as TaxonomyJob['kind'],
    siteId: nullableInteger(row, 'site_id'),
    conceptKey: nullableText(row, 'concept_key'),
    inputHash: text(row, 'input_hash'),
    siteContentVersion: nullableInteger(row, 'site_content_version'),
    taxonomyVersion: integer(row, 'taxonomy_version'),
    providerConfigId: nullableInteger(row, 'provider_config_id'),
    policyConfigId: nullableInteger(row, 'policy_config_id'),
    batchId: nullableText(row, 'batch_id'),
    status: text(row, 'status'),
    attemptCount: integer(row, 'attempt_count'),
    maxAttempts: integer(row, 'max_attempts'),
    leaseToken: text(row, 'lease_token'),
  }
}

export interface NewTaxonomyJob {
  id: string
  jobKey: string
  kind: TaxonomyJob['kind']
  siteId?: number | null
  conceptKey?: string | null
  inputHash: string
  siteContentVersion?: number | null
  taxonomyVersion: number
  providerConfigId?: number | null
  policyConfigId?: number | null
  batchId?: string | null
  priority?: number
  maxAttempts: number
}

interface OntologyApplication {
  candidateId: string
  job: TaxonomyJob
}

interface AssignmentSettlementInput {
  job: TaxonomyJob
  site: SiteSnapshot
  tag: TagSnapshot
  candidateId: string
  attemptId: string
  candidateKey: string
  payload: Record<string, unknown>
  marginMicros: number
  rank: number
  decisionId: string
  batchId: string
  eventId: string
  action: 'add' | 'remove'
  outcome:
    'applied' | 'rejected' | 'shadow' | 'locked' | 'obsolete' | 'conservative'
  confidenceMicros: number
  reason: string
  providerConfigId: number
  providerModel: string
  policy: RuntimePolicy
  releaseSha: string
  now: number
}

export class TaxonomyRepository {
  readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  async loadState(): Promise<TaxonomyState> {
    const row = await first(
      this.db,
      'SELECT * FROM taxonomy_state WHERE id = 1',
    )
    if (!row) throw new Error('Taxonomy state is not initialized')
    return mapState(row)
  }

  async loadPolicy(id: number | null): Promise<RuntimePolicy> {
    if (id === null) throw new Error('No active taxonomy policy')
    const row = await first(
      this.db,
      'SELECT * FROM taxonomy_policy_configs WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('Taxonomy policy not found')
    return mapPolicy(row)
  }

  async loadProviderRoute(id: number | null): Promise<ProviderConfig[]> {
    if (id === null) return []
    const active = await first(
      this.db,
      'SELECT routing_group FROM taxonomy_provider_configs WHERE id = ? AND enabled = 1',
      [id],
    )
    if (!active) return []
    return (
      await all(
        this.db,
        `SELECT * FROM taxonomy_provider_configs
         WHERE enabled = 1 AND routing_group = ?
         ORDER BY CASE routing_role WHEN 'primary' THEN 0 WHEN 'failover' THEN 1 ELSE 2 END,
                  routing_priority ASC, id ASC
         LIMIT 16`,
        [text(active, 'routing_group')],
      )
    ).map(mapProvider)
  }

  async loadProvider(id: number): Promise<ProviderConfig | null> {
    const row = await first(
      this.db,
      'SELECT * FROM taxonomy_provider_configs WHERE id = ?',
      [id],
    )
    return row ? mapProvider(row) : null
  }

  async budgetUsage(
    now: number,
  ): Promise<{ requests: number; tokens: number }> {
    const dayStart = Math.floor(now / 86_400) * 86_400
    const row = await first(
      this.db,
      `SELECT count(*) AS requests,
              coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) AS tokens
       FROM taxonomy_job_attempts WHERE started_at >= ?`,
      [dayStart],
    )
    return row
      ? { requests: integer(row, 'requests'), tokens: integer(row, 'tokens') }
      : { requests: 0, tokens: 0 }
  }

  async enqueueJob(job: NewTaxonomyJob, now: number): Promise<boolean> {
    const payload = stableJson({ jobId: job.id })
    const result = await this.db.batch([
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_jobs
         (id, job_key, kind, site_id, concept_key, input_hash, site_content_version,
          taxonomy_version, provider_config_id, policy_config_id, batch_id, priority,
          max_attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.jobKey,
          job.kind,
          job.siteId ?? null,
          job.conceptKey ?? null,
          job.inputHash,
          job.siteContentVersion ?? null,
          job.taxonomyVersion,
          job.providerConfigId ?? null,
          job.policyConfigId ?? null,
          job.batchId ?? null,
          job.priority ?? 0,
          job.maxAttempts,
          now,
          now,
          now,
        ],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_outbox
         (id, job_id, payload, available_at, created_at)
         SELECT ?, id, ?, ?, ? FROM taxonomy_jobs WHERE job_key = ?`,
        [`outbox:${job.id}`, payload, now, now, job.jobKey],
      ),
    ])
    return (result[0]?.meta.changes ?? 0) > 0
  }

  async leaseJob(
    jobId: string,
    owner: string,
    token: string,
    now: number,
    leaseSeconds: number,
  ): Promise<TaxonomyJob | null> {
    const updated = await changes(
      this.db,
      `UPDATE taxonomy_jobs SET status = 'leased', lease_owner = ?, lease_token = ?,
       leased_until = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND attempt_count < max_attempts AND available_at <= ?
       AND (status IN ('pending', 'retry_wait') OR (status = 'leased' AND leased_until < ?))`,
      [owner, token, now + leaseSeconds, now, jobId, now, now],
    )
    if (!updated) return null
    const row = await first(
      this.db,
      `SELECT * FROM taxonomy_jobs WHERE id = ? AND lease_token = ? AND status = 'leased'`,
      [jobId, token],
    )
    return row ? mapJob(row) : null
  }

  async settleJob(
    job: TaxonomyJob,
    status: 'settled' | 'obsolete' | 'degraded',
    now: number,
    errorCode: string | null = null,
    errorSummary: string | null = null,
  ): Promise<boolean> {
    return Boolean(
      await changes(
        this.db,
        `UPDATE taxonomy_jobs SET status = ?, lease_owner = NULL, lease_token = NULL,
         leased_until = NULL, completed_at = ?, updated_at = ?, last_error_code = ?,
         last_error_summary = ? WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [status, now, now, errorCode, errorSummary, job.id, job.leaseToken],
      ),
    )
  }

  async settleRolloutExcludedCandidate(
    candidateId: string,
    job: TaxonomyJob,
    now: number,
  ): Promise<boolean> {
    return Boolean(
      await changes(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'settled', lease_owner = NULL,
         lease_token = NULL, leased_until = NULL, completed_at = ?, updated_at = ?,
         last_error_code = 'rollout_excluded',
         last_error_summary = 'Ontology candidate remains proposed for explicit admin review.'
         WHERE id = ? AND status = 'leased' AND lease_token = ?
           AND EXISTS (SELECT 1 FROM taxonomy_candidates
                       WHERE id = ? AND status = 'proposed')`,
        [now, now, job.id, job.leaseToken, candidateId],
      ),
    )
  }

  async renewJobLease(
    job: TaxonomyJob,
    now: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    return Boolean(
      await changes(
        this.db,
        `UPDATE taxonomy_jobs SET leased_until = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [now + leaseSeconds, now, job.id, job.leaseToken],
      ),
    )
  }

  async retryJob(
    job: TaxonomyJob,
    availableAt: number,
    now: number,
    code: string,
    summary: string,
  ): Promise<boolean> {
    const terminal = job.attemptCount >= job.maxAttempts
    const result = await this.db.batch([
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = ?, available_at = ?, lease_owner = NULL,
         lease_token = NULL, leased_until = NULL, completed_at = ?, updated_at = ?,
         last_error_code = ?, last_error_summary = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [
          terminal ? 'dead' : 'retry_wait',
          availableAt,
          terminal ? now : null,
          now,
          code,
          summary.slice(0, 500),
          job.id,
          job.leaseToken,
        ],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_outbox SET dispatched_at = NULL, available_at = ?, lease_token = NULL,
         leased_until = NULL WHERE job_id = ? AND ? = 0`,
        [availableAt, job.id, terminal ? 1 : 0],
      ),
    ])
    return (result[0]?.meta.changes ?? 0) > 0
  }

  async candidateSnapshot(
    job: TaxonomyJob,
    limit: number,
  ): Promise<CandidateSnapshot | null> {
    if (job.siteId === null) return null
    const siteRow = await first(
      this.db,
      `SELECT id, name, url, description, content_version, classification_input_hash
       FROM sites WHERE id = ? AND status = 'active'`,
      [job.siteId],
    )
    if (!siteRow) return null
    const relevantTags = `WITH relevant_tags AS (
      SELECT id FROM (
        SELECT id FROM tags WHERE status = 'active'
        ORDER BY canonical DESC, id ASC LIMIT ?
      )
      UNION
      SELECT tag.id FROM site_tags assignment
      JOIN tags tag ON tag.id = assignment.tag_id
      WHERE assignment.site_id = ? AND tag.status = 'active'
    )`
    const [assignedRows, tagRows, aliasRows, parentRows, lockRows] =
      await Promise.all([
        all(
          this.db,
          `SELECT tag_id, raw_name, source, decision_id, revision, created_at, updated_at
         FROM site_tags WHERE site_id = ? ORDER BY tag_id`,
          [job.siteId],
        ),
        all(
          this.db,
          `${relevantTags}
           SELECT tag.id, tag.slug, tag.name, tag.canonical, tag.revision,
                  tag.automation_locked FROM tags tag
           JOIN relevant_tags relevant ON relevant.id = tag.id
           ORDER BY tag.canonical DESC, tag.id ASC`,
          [limit, job.siteId],
        ),
        all(
          this.db,
          `${relevantTags}
           SELECT alias.tag_id, alias.alias FROM tag_aliases alias
           JOIN relevant_tags relevant ON relevant.id = alias.tag_id
           ORDER BY alias.tag_id, alias.alias`,
          [limit, job.siteId],
        ),
        all(
          this.db,
          `${relevantTags}
           SELECT parent.parent_tag_id, parent.child_tag_id FROM tag_parents parent
           JOIN relevant_tags relevant ON relevant.id = parent.child_tag_id
           ORDER BY parent.child_tag_id, parent.parent_tag_id`,
          [limit, job.siteId],
        ),
        all(
          this.db,
          `${relevantTags}
           SELECT lock.resource_key FROM taxonomy_locks lock
           JOIN relevant_tags relevant ON relevant.id = lock.tag_id
           WHERE lock.released_at IS NULL
             AND (lock.scope = 'tag'
                  OR (lock.scope = 'site_assignment' AND lock.site_id = ?))
           ORDER BY lock.resource_key`,
          [limit, job.siteId, job.siteId],
        ),
      ])
    const aliases = new Map<number, string[]>()
    for (const row of aliasRows) {
      const tagId = integer(row, 'tag_id')
      aliases.set(tagId, [...(aliases.get(tagId) ?? []), text(row, 'alias')])
    }
    const parents = new Map<number, number[]>()
    for (const row of parentRows) {
      const childId = integer(row, 'child_tag_id')
      parents.set(childId, [
        ...(parents.get(childId) ?? []),
        integer(row, 'parent_tag_id'),
      ])
    }
    const site: SiteSnapshot = {
      id: integer(siteRow, 'id'),
      name: text(siteRow, 'name'),
      url: text(siteRow, 'url'),
      description: text(siteRow, 'description'),
      contentVersion: integer(siteRow, 'content_version'),
      classificationInputHash: nullableText(
        siteRow,
        'classification_input_hash',
      ),
      assignedTagIds: assignedRows.map((row) => integer(row, 'tag_id')),
      automationAssignedTagIds: assignedRows
        .filter((row) => text(row, 'source') === 'automation')
        .map((row) => integer(row, 'tag_id')),
      assignments: assignedRows.map((row) => ({
        tagId: integer(row, 'tag_id'),
        rawName: text(row, 'raw_name'),
        source: text(
          row,
          'source',
        ) as SiteSnapshot['assignments'][number]['source'],
        decisionId: nullableText(row, 'decision_id'),
        revision: integer(row, 'revision'),
        createdAt: integer(row, 'created_at'),
        updatedAt: integer(row, 'updated_at'),
      })),
    }
    const tags: TagSnapshot[] = tagRows.map((row) => {
      const id = integer(row, 'id')
      return {
        id,
        slug: text(row, 'slug'),
        name: text(row, 'name'),
        canonical: integer(row, 'canonical') === 1,
        revision: integer(row, 'revision'),
        automationLocked: integer(row, 'automation_locked') === 1,
        aliases: aliases.get(id) ?? [],
        parentIds: parents.get(id) ?? [],
      }
    })
    return {
      site,
      tags,
      activeLockKeys: lockRows.map((row) => text(row, 'resource_key')),
    }
  }

  async classificationInputCurrent(job: TaxonomyJob): Promise<boolean> {
    if (job.siteId === null || job.siteContentVersion === null) return false
    return Boolean(
      await first(
        this.db,
        `SELECT 1 AS present FROM sites
         WHERE id = ? AND status = 'active' AND content_version = ?
           AND classification_input_hash = ?`,
        [job.siteId, job.siteContentVersion, job.inputHash],
      ),
    )
  }

  async ontologyContext(
    concept: string | null,
    limit: number,
  ): Promise<{
    tags: TagSnapshot[]
    evidence: Array<{
      concept: string
      snippet: string
      siteId: number
      confidenceMicros: number
    }>
  }> {
    const tagRows = await all(
      this.db,
      `SELECT id, slug, name, canonical, revision, automation_locked
       FROM tags WHERE status = 'active' ORDER BY canonical DESC, id LIMIT ?`,
      [limit],
    )
    const tags = tagRows.map((row) => ({
      id: integer(row, 'id'),
      slug: text(row, 'slug'),
      name: text(row, 'name'),
      canonical: integer(row, 'canonical') === 1,
      revision: integer(row, 'revision'),
      automationLocked: integer(row, 'automation_locked') === 1,
      aliases: [],
      parentIds: [],
    }))
    const evidenceRows = concept
      ? await all(
          this.db,
          `SELECT normalized_concept, evidence_snippet, site_id, confidence_micros
           FROM taxonomy_concept_evidence WHERE normalized_concept = ? AND accepted = 1
           ORDER BY observed_at DESC, id LIMIT 100`,
          [concept],
        )
      : []
    return {
      tags,
      evidence: evidenceRows.map((row) => ({
        concept: text(row, 'normalized_concept'),
        snippet: text(row, 'evidence_snippet'),
        siteId: integer(row, 'site_id'),
        confidenceMicros: integer(row, 'confidence_micros'),
      })),
    }
  }

  async candidate(candidateId: string): Promise<Row | null> {
    return first(this.db, 'SELECT * FROM taxonomy_candidates WHERE id = ?', [
      candidateId,
    ])
  }

  async decideCandidate(
    candidateId: string,
    status: 'accepted' | 'rejected' | 'deferred' | 'conflict',
    reason: string,
    now: number,
  ): Promise<boolean> {
    return Boolean(
      await changes(
        this.db,
        `UPDATE taxonomy_candidates SET status = ?, decision_reason = ?, decided_at = ?
         WHERE id = ? AND status = 'proposed'`,
        [status, reason.slice(0, 500), now, candidateId],
      ),
    )
  }

  async acceptAndEnqueueCandidate(input: {
    candidateId: string
    reason: string
    job: NewTaxonomyJob
    now: number
  }): Promise<boolean> {
    const payload = stableJson({ jobId: input.job.id })
    const result = await this.db.batch([
      statement(
        this.db,
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM taxonomy_candidates
           WHERE id = ? AND status = 'proposed' AND kind IN ('novel_concept','alias','merge','parent_edge')
         ) THEN 1 ELSE json_extract('candidate acceptance guard failed', '$') END`,
        [input.candidateId],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_candidates SET status = 'accepted', decision_reason = ?, decided_at = ?
         WHERE id = ? AND status = 'proposed'`,
        [input.reason.slice(0, 500), input.now, input.candidateId],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_jobs
         (id, job_key, kind, site_id, concept_key, input_hash, site_content_version,
          taxonomy_version, provider_config_id, policy_config_id, batch_id, priority,
          max_attempts, available_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM taxonomy_candidates WHERE id = ? AND status = 'accepted')
          ON CONFLICT(job_key) DO UPDATE SET
            kind = excluded.kind, site_id = excluded.site_id,
            concept_key = excluded.concept_key, input_hash = excluded.input_hash,
            site_content_version = excluded.site_content_version,
            taxonomy_version = excluded.taxonomy_version,
            provider_config_id = excluded.provider_config_id,
            policy_config_id = excluded.policy_config_id, batch_id = excluded.batch_id,
            priority = excluded.priority, max_attempts = excluded.max_attempts,
            status = 'pending', available_at = excluded.available_at,
            lease_owner = NULL, lease_token = NULL, leased_until = NULL,
            attempt_count = 0, completed_at = NULL, updated_at = excluded.updated_at,
            last_error_code = NULL, last_error_summary = NULL
          WHERE taxonomy_jobs.id = excluded.id
            AND taxonomy_jobs.status IN ('leased','settled','obsolete','dead','cancelled','degraded')`,
        [
          input.job.id,
          input.job.jobKey,
          input.job.kind,
          input.job.siteId ?? null,
          input.job.conceptKey ?? null,
          input.job.inputHash,
          input.job.siteContentVersion ?? null,
          input.job.taxonomyVersion,
          input.job.providerConfigId ?? null,
          input.job.policyConfigId ?? null,
          input.job.batchId ?? null,
          input.job.priority ?? 0,
          input.job.maxAttempts,
          input.now,
          input.now,
          input.now,
          input.candidateId,
        ],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_outbox (id, job_id, payload, available_at, created_at)
          SELECT ?, id, ?, ?, ? FROM taxonomy_jobs WHERE id = ?`,
        [`outbox:${input.job.id}`, payload, input.now, input.now, input.job.id],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_outbox SET dispatched_at = NULL, available_at = ?,
         lease_token = NULL, leased_until = NULL, last_error = NULL
         WHERE job_id = ? AND EXISTS (SELECT 1 FROM taxonomy_jobs
                                      WHERE id = ? AND status IN ('pending','retry_wait'))`,
        [input.now, input.job.id, input.job.id],
      ),
      statement(
        this.db,
        `SELECT CASE WHEN
          EXISTS (SELECT 1 FROM taxonomy_candidates WHERE id = ? AND status = 'accepted')
          AND EXISTS (SELECT 1 FROM taxonomy_jobs WHERE id = ?
                      AND status IN ('pending','retry_wait'))
          THEN 1 ELSE json_extract('candidate acceptance enqueue failed', '$') END`,
        [input.candidateId, input.job.id],
      ),
    ])
    return (result[1]?.meta.changes ?? 0) === 1
  }

  async settleAlreadyAppliedCandidate(
    candidateId: string,
    job: TaxonomyJob,
    now: number,
  ): Promise<void> {
    await this.db.batch([
      statement(
        this.db,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM taxonomy_candidates
                                 WHERE id = ? AND status IN ('proposed','accepted'))
         AND EXISTS (SELECT 1 FROM taxonomy_jobs
                     WHERE id = ? AND status = 'leased' AND lease_token = ?)
         THEN 1 ELSE json_extract('candidate recovery guard failed', '$') END`,
        [candidateId, job.id, job.leaseToken],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_candidates SET status = 'accepted',
         decision_reason = 'Matching taxonomy mutation was already applied.', decided_at = ?
         WHERE id = ? AND status IN ('proposed','accepted')`,
        [now, candidateId],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'settled', lease_owner = NULL,
         lease_token = NULL, leased_until = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [now, now, job.id, job.leaseToken],
      ),
    ])
  }

  async reserveAttempt(input: {
    id: string
    jobId: string
    number: number
    provider: ProviderConfig
    requestHash: string
    now: number
    estimatedInputTokens: number
    estimatedOutputTokens: number
    requestBudget: number
    tokenBudget: number
  }): Promise<boolean> {
    const dayStart = Math.floor(input.now / 86_400) * 86_400
    return Boolean(
      await changes(
        this.db,
        `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, input_tokens, output_tokens, started_at)
       SELECT ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?
       WHERE (SELECT count(*) FROM taxonomy_job_attempts WHERE started_at >= ?) < ?
       AND (SELECT coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)
            FROM taxonomy_job_attempts WHERE started_at >= ?) + ? + ? <= ?`,
        [
          input.id,
          input.jobId,
          input.number,
          input.provider.id,
          input.provider.model,
          input.requestHash,
          input.estimatedInputTokens,
          input.estimatedOutputTokens,
          input.now,
          dayStart,
          input.requestBudget,
          dayStart,
          input.estimatedInputTokens,
          input.estimatedOutputTokens,
          input.tokenBudget,
        ],
      ),
    )
  }

  async nextAttemptNumber(jobId: string): Promise<number> {
    const row = await first(
      this.db,
      `SELECT coalesce(max(attempt_number), 0) + 1 AS next_number
       FROM taxonomy_job_attempts WHERE job_id = ?`,
      [jobId],
    )
    return row ? integer(row, 'next_number') : 1
  }

  async finishAttempt(input: {
    id: string
    status:
      | 'succeeded'
      | 'retryable_failure'
      | 'permanent_failure'
      | 'invalid_response'
      | 'cancelled'
    now: number
    providerRequestId?: string | null
    responseHash?: string | null
    rawResponse?: string | null
    rawResponseExpiresAt?: number | null
    inputTokens?: number | null
    outputTokens?: number | null
    latencyMs?: number | null
    errorCode?: string | null
    errorSummary?: string | null
  }): Promise<void> {
    await changes(
      this.db,
      `UPDATE taxonomy_job_attempts SET status = ?, provider_request_id = ?, response_hash = ?,
       raw_response = ?, raw_response_expires_at = ?,
       input_tokens = coalesce(?, input_tokens), output_tokens = coalesce(?, output_tokens),
       latency_ms = ?, error_code = ?, error_summary = ?, completed_at = ?
       WHERE id = ? AND status = 'started'`,
      [
        input.status,
        input.providerRequestId ?? null,
        input.responseHash ?? null,
        input.rawResponse ?? null,
        input.rawResponseExpiresAt ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.latencyMs ?? null,
        input.errorCode ?? null,
        input.errorSummary?.slice(0, 500) ?? null,
        input.now,
        input.id,
      ],
    )
  }

  async saveCandidate(input: {
    id: string
    jobId: string
    attemptId: string | null
    candidateKey: string
    kind: 'existing_tag' | 'novel_concept' | 'alias' | 'merge' | 'parent_edge'
    tagId?: number | null
    relatedTagId?: number | null
    normalizedConcept?: string | null
    proposedName?: string | null
    proposedSlug?: string | null
    payload: Record<string, unknown>
    confidenceMicros: number
    marginMicros?: number | null
    rank: number
    now: number
    supersedesKey?: string
  }): Promise<void> {
    const statements: D1PreparedStatement[] = []
    if (input.supersedesKey) {
      statements.push(
        statement(
          this.db,
          `UPDATE taxonomy_candidates SET status = 'deferred',
           decision_reason = 'Superseded by a later provider attempt.', decided_at = ?
           WHERE job_id = ? AND status = 'proposed' AND
             (candidate_key = ? OR substr(candidate_key, 1, length(? || ':attempt:')) = ? || ':attempt:')`,
          [
            input.now,
            input.jobId,
            input.supersedesKey,
            input.supersedesKey,
            input.supersedesKey,
          ],
        ),
      )
    }
    statements.push(
      statement(
        this.db,
        `INSERT INTO taxonomy_candidates
         (id, job_id, attempt_id, candidate_key, kind, tag_id, related_tag_id,
          normalized_concept, proposed_name, proposed_slug, payload, confidence_micros,
          margin_micros, rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, candidate_key) DO UPDATE SET
           attempt_id = excluded.attempt_id, kind = excluded.kind,
           tag_id = excluded.tag_id, related_tag_id = excluded.related_tag_id,
           normalized_concept = excluded.normalized_concept,
           proposed_name = excluded.proposed_name,
           proposed_slug = excluded.proposed_slug, payload = excluded.payload,
           confidence_micros = excluded.confidence_micros,
           margin_micros = excluded.margin_micros, rank = excluded.rank
         WHERE taxonomy_candidates.status = 'proposed'`,
        [
          input.id,
          input.jobId,
          input.attemptId,
          input.candidateKey,
          input.kind,
          input.tagId ?? null,
          input.relatedTagId ?? null,
          input.normalizedConcept ?? null,
          input.proposedName ?? null,
          input.proposedSlug ?? null,
          stableJson(input.payload),
          input.confidenceMicros,
          input.marginMicros ?? null,
          input.rank,
          input.now,
        ],
      ),
    )
    await this.db.batch(statements)
  }

  async recordEvidence(input: {
    id: string
    concept: string
    siteId: number
    inputHash: string
    sourceKey: string
    source: 'submitted_hint' | 'deterministic' | 'provider'
    providerConfigId?: number | null
    policyConfigId?: number | null
    jobId?: string | null
    attemptId?: string | null
    evidenceHash: string
    evidenceSnippet: string
    confidenceMicros: number
    accepted: boolean
    materiallyNewSupport?: boolean
    now: number
  }): Promise<void> {
    const conceptInputHash = await sha256Hex(
      stableJson({ concept: input.concept }),
    )
    const jobKeyPrefix = `concept:${encodeURIComponent(input.concept)}:input:${conceptInputHash}:taxonomy:`
    const jobId = `tax:${crypto.randomUUID()}`
    await this.db.batch([
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_concept_evidence
         (id, normalized_concept, site_id, input_hash, source_key, source,
          provider_config_id, policy_config_id, job_id, attempt_id, evidence_hash,
          evidence_snippet, confidence_micros, accepted, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.concept,
          input.siteId,
          input.inputHash,
          input.sourceKey,
          input.source,
          input.providerConfigId ?? null,
          input.policyConfigId ?? null,
          input.jobId ?? null,
          input.attemptId ?? null,
          input.evidenceHash,
          input.evidenceSnippet.slice(0, 500),
          input.confidenceMicros,
          input.accepted ? 1 : 0,
          input.now,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_jobs
         (id, job_key, kind, concept_key, input_hash, taxonomy_version,
           provider_config_id, policy_config_id, priority, max_attempts,
           available_at, created_at, updated_at)
         SELECT ?, ? || state.published_version || ':provider:' ||
                   coalesce(state.active_provider_config_id, 0),
                'reassess_concept', ?, ?, state.published_version,
                state.active_provider_config_id, policy.id, 0,
                max(1, policy.retry_budget + 1), ?, ?, ?
         FROM taxonomy_state state
         JOIN taxonomy_policy_configs policy ON policy.id = state.active_policy_config_id
           WHERE state.id = 1 AND ? = 1 AND changes() > 0
             AND (SELECT count(DISTINCT site_id)
                 FROM taxonomy_concept_evidence
                 WHERE normalized_concept = ? AND accepted = 1) >=
                policy.novel_evidence_site_threshold
           ON CONFLICT(job_key) DO UPDATE SET
            concept_key = excluded.concept_key,
            input_hash = excluded.input_hash,
            taxonomy_version = excluded.taxonomy_version,
            provider_config_id = excluded.provider_config_id,
            policy_config_id = excluded.policy_config_id,
            priority = excluded.priority,
            max_attempts = excluded.max_attempts,
            status = 'pending', available_at = excluded.available_at,
            lease_owner = NULL, lease_token = NULL, leased_until = NULL,
            attempt_count = 0, completed_at = NULL,
            updated_at = excluded.updated_at,
            last_error_code = NULL, last_error_summary = NULL
           WHERE taxonomy_jobs.kind = 'reassess_concept'
             AND taxonomy_jobs.status IN
                 ('succeeded','settled','obsolete','dead','cancelled','degraded')
             AND (
               ? > 0 OR
                EXISTS (
                  SELECT 1 FROM taxonomy_concept_evidence evidence
                  WHERE evidence.normalized_concept = ? AND evidence.accepted = 1
                    AND evidence.id = ?
                    AND NOT EXISTS (
                      SELECT 1 FROM taxonomy_concept_evidence prior
                      WHERE prior.normalized_concept = evidence.normalized_concept
                        AND prior.site_id = evidence.site_id
                        AND prior.id <> evidence.id
                        AND prior.observed_at <= coalesce(taxonomy_jobs.completed_at,
                                                         taxonomy_jobs.updated_at)
                    )
                )
              )`,
        [
          jobId,
          jobKeyPrefix,
          input.concept,
          conceptInputHash,
          input.now,
          input.now,
          input.now,
          input.accepted ? 1 : 0,
          input.concept,
          input.materiallyNewSupport ? 1 : 0,
          input.concept,
          input.id,
        ],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_outbox SET dispatched_at = NULL, available_at = ?,
         lease_token = NULL, leased_until = NULL, last_error = NULL
         WHERE changes() > 0 AND job_id IN (
           SELECT job.id FROM taxonomy_state state
           JOIN taxonomy_jobs job
             ON job.job_key = ? || state.published_version || ':provider:' ||
                              coalesce(state.active_provider_config_id, 0)
           WHERE state.id = 1 AND job.kind = 'reassess_concept'
             AND job.status = 'pending'
         )`,
        [input.now, jobKeyPrefix],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_outbox
         (id, job_id, payload, available_at, created_at)
         SELECT ?, job.id, json_object('jobId', job.id), ?, ?
         FROM taxonomy_state state
         JOIN taxonomy_jobs job
           ON job.job_key = ? || state.published_version || ':provider:' ||
                            coalesce(state.active_provider_config_id, 0)
         WHERE state.id = 1 AND ? = 1`,
        [
          `outbox:${crypto.randomUUID()}`,
          input.now,
          input.now,
          jobKeyPrefix,
          input.accepted ? 1 : 0,
        ],
      ),
    ])
  }

  async evidenceSiteCount(concept: string): Promise<number> {
    const row = await first(
      this.db,
      `SELECT count(DISTINCT site_id) AS count FROM taxonomy_concept_evidence
       WHERE normalized_concept = ? AND accepted = 1`,
      [concept],
    )
    return row ? integer(row, 'count') : 0
  }

  async hierarchyEdges(): Promise<
    Array<{ parentId: number; childId: number }>
  > {
    return (
      await all(
        this.db,
        'SELECT parent_tag_id, child_tag_id FROM tag_parents ORDER BY parent_tag_id, child_tag_id LIMIT 10000',
      )
    ).map((row) => ({
      parentId: integer(row, 'parent_tag_id'),
      childId: integer(row, 'child_tag_id'),
    }))
  }

  async tagRecord(tagId: number): Promise<{
    id: number
    slug: string
    name: string
    canonical: boolean
    status: string
    revision: number
    automationLocked: boolean
  } | null> {
    const row = await first(
      this.db,
      `SELECT id, slug, name, canonical, status, revision, automation_locked
       FROM tags WHERE id = ?`,
      [tagId],
    )
    return row
      ? {
          id: integer(row, 'id'),
          slug: text(row, 'slug'),
          name: text(row, 'name'),
          canonical: integer(row, 'canonical') === 1,
          status: text(row, 'status'),
          revision: integer(row, 'revision'),
          automationLocked: integer(row, 'automation_locked') === 1,
        }
      : null
  }

  async publishCanonical(input: {
    batchId: string
    eventId: string
    expectedVersion: number
    name: string
    slug: string
    normalizedConcept: string
    evidenceThreshold: number
    policy: RuntimePolicy
    releaseSha: string
    actorId: string
    now: number
    application?: OntologyApplication
  }): Promise<number> {
    const nextVersion = input.expectedVersion + 1
    const guard = statement(
      this.db,
      `SELECT CASE WHEN
       (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
       AND (SELECT count(DISTINCT site_id) FROM taxonomy_concept_evidence
            WHERE normalized_concept = ? AND accepted = 1) >= ?
       AND (NOT EXISTS (SELECT 1 FROM tags WHERE slug = ?)
            OR EXISTS (SELECT 1 FROM tags WHERE slug = ? AND status = 'active'
                       AND canonical = 0 AND automation_locked = 0))
       AND NOT EXISTS (SELECT 1 FROM tag_aliases WHERE alias = ?)
        AND NOT EXISTS (SELECT 1 FROM taxonomy_locks
                        WHERE released_at IS NULL
                          AND scope <> 'site_assignment'
                          AND (resource_key = ? OR tag_id =
                               (SELECT id FROM tags WHERE slug = ?)))
       AND NOT EXISTS (SELECT 1 FROM taxonomy_candidates
                       WHERE status = 'proposed' AND id <> coalesce(?, '')
                       AND (proposed_slug = ? OR normalized_concept = ?))
        AND (? IS NULL OR (EXISTS (SELECT 1 FROM taxonomy_candidates
                                  WHERE id = ? AND status IN ('proposed','accepted'))
            AND EXISTS (SELECT 1 FROM taxonomy_jobs
                        WHERE id = ? AND status = 'leased' AND lease_token = ?)))
       THEN 1 ELSE json_extract('taxonomy publication guard failed', '$') END`,
      [
        input.expectedVersion,
        input.normalizedConcept,
        input.evidenceThreshold,
        input.slug,
        input.slug,
        input.slug,
        `alias:${input.slug}`,
        input.slug,
        input.application?.candidateId ?? null,
        input.slug,
        input.normalizedConcept,
        input.application?.candidateId ?? null,
        input.application?.candidateId ?? null,
        input.application?.job.id ?? null,
        input.application?.job.leaseToken ?? null,
      ],
    )
    const identityIndex = 3
    const statements = [
      guard,
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'system', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          `Published canonical tag ${input.slug}`,
          input.now,
          input.now,
          input.now,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO tags
          (slug, name, canonical, status, revision, automation_locked, created_at, updated_at)
          VALUES (?, ?, 1, 'active', 1, 0, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            name = excluded.name, canonical = 1,
            revision = tags.revision + 1, updated_at = excluded.updated_at
          WHERE tags.status = 'active' AND tags.canonical = 0
            AND tags.automation_locked = 0`,
        [input.slug, input.name, input.now, input.now],
      ),
      statement(
        this.db,
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM tags WHERE slug = ? AND status = 'active' AND canonical = 1
         ) THEN (SELECT id FROM tags WHERE slug = ? AND status = 'active' AND canonical = 1)
         ELSE json_extract('canonical tag identity missing', '$') END AS id`,
        [input.slug, input.slug],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_state SET published_version = ?, updated_at = ?
         WHERE id = 1 AND published_version = ?`,
        [nextVersion, input.now, input.expectedVersion],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
          policy_config_id, prompt_hash, schema_hash, taxonomy_version_before,
          taxonomy_version_after, scores, evidence, before, after, release_sha, created_at)
         VALUES (?, ?, 'canonical_created', 'tag', ?, 'system', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
        [
          input.eventId,
          input.batchId,
          input.slug,
          input.actorId,
          input.policy.id,
          input.policy.promptHash,
          input.policy.schemaHash,
          input.expectedVersion,
          nextVersion,
          stableJson({ evidenceThreshold: input.evidenceThreshold }),
          input.normalizedConcept,
          stableJson({ name: input.name, slug: input.slug, canonical: true }),
          input.releaseSha,
          input.now,
        ],
      ),
    ]
    this.appendOntologyApplication(statements, input.application, input.now)
    const results = await this.db.batch(statements)
    const identity = results[identityIndex]?.results[0] as Row | undefined
    if (!identity)
      throw new Error('Canonical tag publication returned no identity')
    return integer(identity, 'id')
  }

  async publishAlias(input: {
    batchId: string
    eventId: string
    expectedVersion: number
    targetTagId: number
    expectedTagRevision: number
    alias: string
    policy: RuntimePolicy
    releaseSha: string
    actorId: string
    now: number
    application?: OntologyApplication
  }): Promise<void> {
    const nextVersion = input.expectedVersion + 1
    const statements = [
      statement(
        this.db,
        `SELECT CASE WHEN
         (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active'
                     AND canonical = 1 AND automation_locked = 0)
         AND NOT EXISTS (SELECT 1 FROM tags WHERE slug = ?)
         AND NOT EXISTS (SELECT 1 FROM tag_aliases WHERE alias = ?)
         AND (? <> 'applied' OR NOT EXISTS
              (SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
               AND resource_key IN (?, ?)))
         AND (? IS NULL OR (EXISTS (SELECT 1 FROM taxonomy_candidates WHERE id = ? AND status IN ('proposed','accepted'))
              AND EXISTS (SELECT 1 FROM taxonomy_jobs WHERE id = ? AND status = 'leased' AND lease_token = ?)))
         THEN 1 ELSE json_extract('taxonomy publication guard failed', '$') END`,
        [
          input.expectedVersion,
          input.targetTagId,
          input.expectedTagRevision,
          input.alias,
          input.alias,
          'applied',
          `alias:${input.alias}`,
          `tag:${input.targetTagId}`,
          input.application?.candidateId ?? null,
          input.application?.candidateId ?? null,
          input.application?.job.id ?? null,
          input.application?.job.leaseToken ?? null,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'system', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          `Published alias ${input.alias}`,
          input.now,
          input.now,
          input.now,
        ],
      ),
      statement(
        this.db,
        'INSERT INTO tag_aliases (alias, tag_id) VALUES (?, ?)',
        [input.alias, input.targetTagId],
      ),
      statement(
        this.db,
        'UPDATE tags SET revision = revision + 1, updated_at = ? WHERE id = ?',
        [input.now, input.targetTagId],
      ),
      statement(
        this.db,
        'UPDATE taxonomy_state SET published_version = ?, updated_at = ? WHERE id = 1 AND published_version = ?',
        [nextVersion, input.now, input.expectedVersion],
      ),
      this.auditOntologyStatement({
        ...input,
        eventType: 'alias_created',
        entityType: 'alias',
        entityId: input.alias,
        nextVersion,
        before: {},
        after: {
          alias: input.alias,
          targetTagId: input.targetTagId,
          targetTagRevision: input.expectedTagRevision + 1,
        },
      }),
    ]
    this.appendOntologyApplication(statements, input.application, input.now)
    await this.db.batch(statements)
  }

  async publishParent(input: {
    batchId: string
    eventId: string
    expectedVersion: number
    childTagId: number
    parentTagId: number
    expectedTagRevision: number
    policy: RuntimePolicy
    releaseSha: string
    actorId: string
    now: number
    application?: OntologyApplication
  }): Promise<void> {
    const nextVersion = input.expectedVersion + 1
    const statements = [
      statement(
        this.db,
        `SELECT CASE WHEN
         (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active' AND canonical = 1 AND automation_locked = 0)
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND status = 'active' AND canonical = 1 AND automation_locked = 0)
         AND NOT EXISTS (SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
                         AND resource_key IN (?, ?, ?))
         AND (? IS NULL OR (EXISTS (SELECT 1 FROM taxonomy_candidates WHERE id = ? AND status IN ('proposed','accepted'))
              AND EXISTS (SELECT 1 FROM taxonomy_jobs WHERE id = ? AND status = 'leased' AND lease_token = ?)))
         THEN 1 ELSE json_extract('taxonomy publication guard failed', '$') END`,
        [
          input.expectedVersion,
          input.childTagId,
          input.expectedTagRevision,
          input.parentTagId,
          `parent:${input.parentTagId}:${input.childTagId}`,
          `tag:${input.parentTagId}`,
          `tag:${input.childTagId}`,
          input.application?.candidateId ?? null,
          input.application?.candidateId ?? null,
          input.application?.job.id ?? null,
          input.application?.job.leaseToken ?? null,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'system', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          `Published parent edge ${input.parentTagId}:${input.childTagId}`,
          input.now,
          input.now,
          input.now,
        ],
      ),
      statement(
        this.db,
        'INSERT OR IGNORE INTO tag_parents (parent_tag_id, child_tag_id) VALUES (?, ?)',
        [input.parentTagId, input.childTagId],
      ),
      statement(
        this.db,
        'UPDATE tags SET revision = revision + 1, updated_at = ? WHERE id = ?',
        [input.now, input.childTagId],
      ),
      statement(
        this.db,
        'UPDATE taxonomy_state SET published_version = ?, updated_at = ? WHERE id = 1 AND published_version = ?',
        [nextVersion, input.now, input.expectedVersion],
      ),
      this.auditOntologyStatement({
        ...input,
        eventType: 'parent_created',
        entityType: 'parent_edge',
        entityId: `${input.parentTagId}:${input.childTagId}`,
        nextVersion,
        before: {},
        after: {
          parentTagId: input.parentTagId,
          childTagId: input.childTagId,
          childTagRevision: input.expectedTagRevision + 1,
        },
      }),
    ]
    this.appendOntologyApplication(statements, input.application, input.now)
    await this.db.batch(statements)
  }

  async publishMerge(input: {
    batchId: string
    eventId: string
    expectedVersion: number
    sourceTagId: number
    targetTagId: number
    expectedTagRevision: number
    expectedTargetRevision: number
    policy: RuntimePolicy
    releaseSha: string
    actorId: string
    now: number
    application?: OntologyApplication
  }): Promise<void> {
    const nextVersion = input.expectedVersion + 1
    const source = await this.tagRecord(input.sourceTagId)
    const target = await this.tagRecord(input.targetTagId)
    if (!source || !target) throw new Error('Merge tag not found')
    const [sourceAssignments, targetAssignments, sourceAliases, sourceEdges] =
      await Promise.all([
        all(
          this.db,
          'SELECT site_id, raw_name, source FROM site_tags WHERE tag_id = ? ORDER BY site_id LIMIT 501',
          [input.sourceTagId],
        ),
        all(
          this.db,
          'SELECT site_id FROM site_tags WHERE tag_id = ? ORDER BY site_id LIMIT 501',
          [input.targetTagId],
        ),
        all(
          this.db,
          'SELECT alias FROM tag_aliases WHERE tag_id = ? ORDER BY alias LIMIT 101',
          [input.sourceTagId],
        ),
        all(
          this.db,
          `SELECT parent_tag_id, child_tag_id FROM tag_parents
           WHERE parent_tag_id = ? OR child_tag_id = ? ORDER BY parent_tag_id, child_tag_id LIMIT 101`,
          [input.sourceTagId, input.sourceTagId],
        ),
      ])
    if (
      sourceAssignments.length > 500 ||
      targetAssignments.length > 500 ||
      sourceAliases.length > 100 ||
      sourceEdges.length > 100
    ) {
      throw new Error('Merge exceeds bounded mutation size')
    }
    const statements = [
      statement(
        this.db,
        `SELECT CASE WHEN
         (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active' AND automation_locked = 0)
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active' AND canonical = 1 AND automation_locked = 0)
         AND NOT EXISTS (SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
                         AND resource_key IN (?, ?, ?, ?))
         AND (SELECT count(*) FROM site_tags WHERE tag_id IN (?, ?)) <= 1000
         AND (SELECT count(*) FROM tag_parents WHERE parent_tag_id = ? OR child_tag_id = ?) <= 100
         AND (? IS NULL OR (EXISTS (SELECT 1 FROM taxonomy_candidates WHERE id = ? AND status IN ('proposed','accepted'))
              AND EXISTS (SELECT 1 FROM taxonomy_jobs WHERE id = ? AND status = 'leased' AND lease_token = ?)))
         THEN 1 ELSE json_extract('taxonomy publication guard failed', '$') END`,
        [
          input.expectedVersion,
          input.sourceTagId,
          input.expectedTagRevision,
          input.targetTagId,
          input.expectedTargetRevision,
          `merge:${input.sourceTagId}:${input.targetTagId}`,
          `merge:${input.targetTagId}:${input.sourceTagId}`,
          `tag:${input.sourceTagId}`,
          `tag:${input.targetTagId}`,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.application?.candidateId ?? null,
          input.application?.candidateId ?? null,
          input.application?.job.id ?? null,
          input.application?.job.leaseToken ?? null,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'system', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          `Merged tag ${input.sourceTagId} into ${input.targetTagId}`,
          input.now,
          input.now,
          input.now,
        ],
      ),
      statement(
        this.db,
        `UPDATE site_tags AS target SET
         raw_name = (SELECT source.raw_name FROM site_tags source
                     WHERE source.site_id = target.site_id AND source.tag_id = ?),
         source = (SELECT source.source FROM site_tags source
                   WHERE source.site_id = target.site_id AND source.tag_id = ?),
         revision = target.revision + 1, updated_at = ?
         WHERE target.tag_id = ? AND target.source = 'automation'
         AND EXISTS (SELECT 1 FROM site_tags source
                     WHERE source.site_id = target.site_id AND source.tag_id = ?
                     AND source.source <> 'automation')`,
        [
          input.sourceTagId,
          input.sourceTagId,
          input.now,
          input.targetTagId,
          input.sourceTagId,
        ],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO site_tags (site_id, tag_id, raw_name, source, revision, created_at, updated_at)
         SELECT site_id, ?, raw_name, source, revision + 1, created_at, ? FROM site_tags WHERE tag_id = ?`,
        [input.targetTagId, input.now, input.sourceTagId],
      ),
      statement(this.db, 'DELETE FROM site_tags WHERE tag_id = ?', [
        input.sourceTagId,
      ]),
      statement(this.db, 'UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?', [
        input.targetTagId,
        input.sourceTagId,
      ]),
      statement(
        this.db,
        `INSERT OR IGNORE INTO tag_parents (parent_tag_id, child_tag_id)
         SELECT CASE WHEN parent_tag_id = ? THEN ? ELSE parent_tag_id END,
                CASE WHEN child_tag_id = ? THEN ? ELSE child_tag_id END
         FROM tag_parents WHERE (parent_tag_id = ? OR child_tag_id = ?)
         AND (CASE WHEN parent_tag_id = ? THEN ? ELSE parent_tag_id END) <>
             (CASE WHEN child_tag_id = ? THEN ? ELSE child_tag_id END)`,
        [
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
        ],
      ),
      statement(
        this.db,
        'DELETE FROM tag_parents WHERE parent_tag_id = ? OR child_tag_id = ?',
        [input.sourceTagId, input.sourceTagId],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_locks SET
           tag_id = CASE WHEN tag_id = ? THEN ? ELSE tag_id END,
           related_tag_id = CASE WHEN related_tag_id = ? THEN ? ELSE related_tag_id END,
           resource_key = printf('parent:%d:%d',
             CASE WHEN tag_id = ? THEN ? ELSE tag_id END,
             CASE WHEN related_tag_id = ? THEN ? ELSE related_tag_id END),
           revision = revision + 1
         WHERE released_at IS NULL AND scope = 'parent_edge'
           AND (tag_id = ? OR related_tag_id = ?)
           AND CASE WHEN tag_id = ? THEN ? ELSE tag_id END <>
               CASE WHEN related_tag_id = ? THEN ? ELSE related_tag_id END`,
        [
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
        ],
      ),
      statement(
        this.db,
        `UPDATE tags SET status = 'merged', canonical = 0, merged_into_tag_id = ?,
         deprecated_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        [input.targetTagId, input.now, input.now, input.sourceTagId],
      ),
      statement(
        this.db,
        'UPDATE tags SET revision = revision + 1, updated_at = ? WHERE id = ?',
        [input.now, input.targetTagId],
      ),
      statement(
        this.db,
        'UPDATE taxonomy_state SET published_version = ?, updated_at = ? WHERE id = 1 AND published_version = ?',
        [nextVersion, input.now, input.expectedVersion],
      ),
      this.auditOntologyStatement({
        ...input,
        eventType: 'tags_merged',
        entityType: 'merge',
        entityId: `${input.sourceTagId}:${input.targetTagId}`,
        nextVersion,
        before: {
          source,
          target,
          sourceAssignments: sourceAssignments.map((row) => ({
            siteId: integer(row, 'site_id'),
            rawName: text(row, 'raw_name'),
            source: text(row, 'source'),
          })),
          targetSiteIds: targetAssignments.map((row) =>
            integer(row, 'site_id'),
          ),
          sourceAliases: sourceAliases.map((row) => text(row, 'alias')),
          sourceEdges: sourceEdges.map((row) => ({
            parentTagId: integer(row, 'parent_tag_id'),
            childTagId: integer(row, 'child_tag_id'),
          })),
        },
        after: {
          sourceTagId: input.sourceTagId,
          targetTagId: input.targetTagId,
          sourceTagRevision: input.expectedTagRevision + 1,
          targetTagRevision: input.expectedTargetRevision + 1,
        },
      }),
    ]
    this.appendOntologyApplication(statements, input.application, input.now)
    await this.db.batch(statements)
  }

  async applyAdminTagCorrection(input: {
    tagId: number
    expectedTagRevision: number
    expectedVersion: number
    name: string
    aliases: string[]
    parentTagIds: number[]
    lockResourceKeys: string[]
    batchId: string
    eventId: string
    actorId: string
    releaseSha: string
    now: number
    before: unknown
  }): Promise<void> {
    const nextVersion = input.expectedVersion + 1
    const aliasJson = stableJson(input.aliases)
    const parentJson = stableJson(input.parentTagIds)
    const lockJson = stableJson(input.lockResourceKeys)
    const statements: D1PreparedStatement[] = [
      statement(
        this.db,
        `SELECT CASE WHEN
         (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active')
         AND NOT EXISTS (SELECT 1 FROM taxonomy_locks lock
                         JOIN json_each(?) requested ON requested.value = lock.resource_key
                         WHERE lock.released_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM json_each(?) requested
                         JOIN tags tag ON tag.slug = requested.value AND tag.id <> ?)
         AND NOT EXISTS (SELECT 1 FROM json_each(?) requested
                         JOIN tag_aliases alias ON alias.alias = requested.value AND alias.tag_id <> ?)
         THEN 1 ELSE json_extract('admin tag correction guard failed', '$') END`,
        [
          input.expectedVersion,
          input.tagId,
          input.expectedTagRevision,
          lockJson,
          aliasJson,
          input.tagId,
          aliasJson,
          input.tagId,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'admin', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          `Admin correction for tag ${input.tagId}`,
          input.now,
          input.now,
          input.now,
        ],
      ),
      statement(this.db, 'DELETE FROM tag_aliases WHERE tag_id = ?', [
        input.tagId,
      ]),
      statement(
        this.db,
        `INSERT INTO tag_aliases (alias, tag_id)
         SELECT value, ? FROM json_each(?)`,
        [input.tagId, aliasJson],
      ),
      statement(this.db, 'DELETE FROM tag_parents WHERE child_tag_id = ?', [
        input.tagId,
      ]),
      statement(
        this.db,
        `INSERT INTO tag_parents (parent_tag_id, child_tag_id)
         SELECT value, ? FROM json_each(?)`,
        [input.tagId, parentJson],
      ),
      statement(
        this.db,
        `UPDATE tags SET name = ?, canonical = 1, automation_locked = 1,
         revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [input.name, input.now, input.tagId, input.expectedTagRevision],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_locks
         (id, scope, resource_key, tag_id, related_tag_id, alias, reason,
          revision, created_by, created_at)
          SELECT 'taxonomy-lock:' || lower(hex(randomblob(16))),
                CASE WHEN value LIKE 'alias:%' THEN 'alias'
                     WHEN value LIKE 'parent:%' THEN 'parent_edge' ELSE 'tag' END,
                value,
                CASE WHEN value LIKE 'parent:%'
                     THEN CAST(substr(value, 8, instr(substr(value, 8), ':') - 1) AS INTEGER)
                     ELSE ? END,
                CASE WHEN value LIKE 'parent:%'
                     THEN CAST(substr(value, 8 + instr(substr(value, 8), ':')) AS INTEGER) END,
                CASE WHEN value LIKE 'alias:%' THEN substr(value, 7) END,
                'Durable admin taxonomy correction', 1, ?, ?
         FROM json_each(?)`,
        [input.tagId, input.actorId, input.now, lockJson],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'obsolete', completed_at = ?, updated_at = ?
         WHERE taxonomy_version = ? AND status IN ('pending', 'retry_wait')`,
        [input.now, input.now, input.expectedVersion],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_state SET published_version = ?, updated_at = ?
         WHERE id = 1 AND published_version = ?`,
        [nextVersion, input.now, input.expectedVersion],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
          taxonomy_version_before, taxonomy_version_after, scores, evidence, before,
          after, release_sha, created_at)
         VALUES (?, ?, 'admin_tag_corrected', 'tag', ?, 'admin', ?, ?, ?, '{}', '', ?, ?, ?, ?)`,
        [
          input.eventId,
          input.batchId,
          String(input.tagId),
          input.actorId,
          input.expectedVersion,
          nextVersion,
          stableJson(input.before),
          stableJson({
            name: input.name,
            canonical: true,
            aliases: input.aliases,
            parentTagIds: input.parentTagIds,
            revision: input.expectedTagRevision + 1,
            locked: true,
          }),
          input.releaseSha,
          input.now,
        ],
      ),
    ]
    await this.db.batch(statements)
  }

  async applyAdminMerge(input: {
    sourceTagId: number
    targetTagId: number
    expectedSourceRevision: number
    expectedTargetRevision: number
    expectedVersion: number
    alias: string | null
    lockResourceKeys: string[]
    batchId: string
    eventId: string
    actorId: string
    releaseSha: string
    now: number
    before: unknown
  }): Promise<void> {
    const nextVersion = input.expectedVersion + 1
    const lockJson = stableJson(input.lockResourceKeys)
    const statements: D1PreparedStatement[] = [
      statement(
        this.db,
        `SELECT CASE WHEN
         (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active')
         AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND revision = ? AND status = 'active' AND canonical = 1)
         AND NOT EXISTS (SELECT 1 FROM taxonomy_locks lock
                          JOIN json_each(?) requested ON requested.value = lock.resource_key
                          WHERE lock.released_at IS NULL
                            AND NOT (lock.scope = 'parent_edge'
                                     AND (lock.tag_id = ? OR lock.related_tag_id = ?)))
         AND (? IS NULL OR NOT EXISTS
              (SELECT 1 FROM tags WHERE slug = ? AND id NOT IN (?, ?)))
         AND (? IS NULL OR NOT EXISTS
              (SELECT 1 FROM tag_aliases WHERE alias = ? AND tag_id NOT IN (?, ?)))
         AND ((SELECT count(*) FROM site_tags WHERE tag_id = ?)
            + (SELECT count(*) FROM tag_aliases WHERE tag_id = ?)
            + (SELECT count(*) FROM tag_parents WHERE parent_tag_id = ? OR child_tag_id = ?)) <= 500
         THEN 1 ELSE json_extract('admin merge guard failed', '$') END`,
        [
          input.expectedVersion,
          input.sourceTagId,
          input.expectedSourceRevision,
          input.targetTagId,
          input.expectedTargetRevision,
          lockJson,
          input.sourceTagId,
          input.sourceTagId,
          input.alias,
          input.alias,
          input.sourceTagId,
          input.targetTagId,
          input.alias,
          input.alias,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.sourceTagId,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'admin', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          `Admin merge ${input.sourceTagId} into ${input.targetTagId}`,
          input.now,
          input.now,
          input.now,
        ],
      ),
      statement(
        this.db,
        `UPDATE site_tags AS target SET
         raw_name = (SELECT source.raw_name FROM site_tags source WHERE source.site_id = target.site_id AND source.tag_id = ?),
         source = (SELECT source.source FROM site_tags source WHERE source.site_id = target.site_id AND source.tag_id = ?),
         decision_id = (SELECT source.decision_id FROM site_tags source WHERE source.site_id = target.site_id AND source.tag_id = ?),
         revision = target.revision + 1, updated_at = ?
         WHERE target.tag_id = ? AND EXISTS (
           SELECT 1 FROM site_tags source WHERE source.site_id = target.site_id AND source.tag_id = ?
           AND CASE source.source WHEN 'admin' THEN 4 WHEN 'deterministic' THEN 3 WHEN 'migration' THEN 2 ELSE 1 END
             > CASE target.source WHEN 'admin' THEN 4 WHEN 'deterministic' THEN 3 WHEN 'migration' THEN 2 ELSE 1 END)`,
        [
          input.sourceTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.now,
          input.targetTagId,
          input.sourceTagId,
        ],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO site_tags
         (site_id, tag_id, raw_name, source, decision_id, revision, created_at, updated_at)
         SELECT site_id, ?, raw_name, source, decision_id, revision + 1, created_at, ?
         FROM site_tags WHERE tag_id = ?`,
        [input.targetTagId, input.now, input.sourceTagId],
      ),
      statement(this.db, 'DELETE FROM site_tags WHERE tag_id = ?', [
        input.sourceTagId,
      ]),
      statement(this.db, 'UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?', [
        input.targetTagId,
        input.sourceTagId,
      ]),
      statement(
        this.db,
        `INSERT INTO tag_aliases (alias, tag_id)
         SELECT ?, ? WHERE ? IS NOT NULL
          ON CONFLICT(alias) DO UPDATE SET tag_id = excluded.tag_id
          WHERE tag_aliases.tag_id = ?`,
        [input.alias, input.targetTagId, input.alias, input.sourceTagId],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO tag_parents (parent_tag_id, child_tag_id)
         SELECT CASE WHEN parent_tag_id = ? THEN ? ELSE parent_tag_id END,
                CASE WHEN child_tag_id = ? THEN ? ELSE child_tag_id END
         FROM tag_parents WHERE (parent_tag_id = ? OR child_tag_id = ?)
         AND (CASE WHEN parent_tag_id = ? THEN ? ELSE parent_tag_id END) <>
             (CASE WHEN child_tag_id = ? THEN ? ELSE child_tag_id END)`,
        [
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
        ],
      ),
      statement(
        this.db,
        'DELETE FROM tag_parents WHERE parent_tag_id = ? OR child_tag_id = ?',
        [input.sourceTagId, input.sourceTagId],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_locks SET
           tag_id = CASE WHEN tag_id = ? THEN ? ELSE tag_id END,
           related_tag_id = CASE WHEN related_tag_id = ? THEN ? ELSE related_tag_id END,
           resource_key = printf('parent:%d:%d',
             CASE WHEN tag_id = ? THEN ? ELSE tag_id END,
             CASE WHEN related_tag_id = ? THEN ? ELSE related_tag_id END),
           revision = revision + 1
         WHERE released_at IS NULL AND scope = 'parent_edge'
           AND (tag_id = ? OR related_tag_id = ?)`,
        [
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.sourceTagId,
          input.sourceTagId,
        ],
      ),
      statement(
        this.db,
        `UPDATE tags SET status = 'merged', canonical = 0, automation_locked = 1,
         merged_into_tag_id = ?, deprecated_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [
          input.targetTagId,
          input.now,
          input.now,
          input.sourceTagId,
          input.expectedSourceRevision,
        ],
      ),
      statement(
        this.db,
        `UPDATE tags SET automation_locked = 1, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [input.now, input.targetTagId, input.expectedTargetRevision],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_locks
         (id, scope, resource_key, tag_id, related_tag_id, alias, reason,
          revision, created_by, created_at)
         SELECT 'taxonomy-lock:' || lower(hex(randomblob(16))),
                CASE WHEN value LIKE 'alias:%' THEN 'alias'
                     WHEN value LIKE 'parent:%' THEN 'parent_edge'
                     WHEN value LIKE 'merge:%' THEN 'merge' ELSE 'tag' END,
                value,
                CASE WHEN value LIKE 'parent:%'
                     THEN CAST(substr(value, 8, instr(substr(value, 8), ':') - 1) AS INTEGER)
                     WHEN value LIKE 'alias:%' OR value = ? THEN ? ELSE ? END,
                CASE WHEN value LIKE 'parent:%'
                     THEN CAST(substr(value, 8 + instr(substr(value, 8), ':')) AS INTEGER)
                     WHEN value LIKE 'merge:%' THEN ? END,
                CASE WHEN value LIKE 'alias:%' THEN substr(value, 7) END,
                 'Durable admin taxonomy merge', 1, ?, ? FROM json_each(?)
          WHERE NOT EXISTS (SELECT 1 FROM taxonomy_locks existing
                            WHERE existing.resource_key = value
                              AND existing.released_at IS NULL)`,
        [
          `tag:${input.targetTagId}`,
          input.targetTagId,
          input.sourceTagId,
          input.targetTagId,
          input.actorId,
          input.now,
          lockJson,
        ],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'obsolete', completed_at = ?, updated_at = ?
         WHERE taxonomy_version = ? AND status IN ('pending', 'retry_wait')`,
        [input.now, input.now, input.expectedVersion],
      ),
      statement(
        this.db,
        'UPDATE taxonomy_state SET published_version = ?, updated_at = ? WHERE id = 1 AND published_version = ?',
        [nextVersion, input.now, input.expectedVersion],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
          taxonomy_version_before, taxonomy_version_after, scores, evidence, before,
          after, release_sha, created_at)
         VALUES (?, ?, 'admin_tags_merged', 'merge', ?, 'admin', ?, ?, ?, '{}', '', ?, ?, ?, ?)`,
        [
          input.eventId,
          input.batchId,
          `${input.sourceTagId}:${input.targetTagId}`,
          input.actorId,
          input.expectedVersion,
          nextVersion,
          stableJson(input.before),
          stableJson({
            sourceTagId: input.sourceTagId,
            targetTagId: input.targetTagId,
            sourceStatus: 'merged',
            sourceRevision: input.expectedSourceRevision + 1,
            targetRevision: input.expectedTargetRevision + 1,
            locked: true,
          }),
          input.releaseSha,
          input.now,
        ],
      ),
    ]
    await this.db.batch(statements)
  }

  private appendOntologyApplication(
    statements: D1PreparedStatement[],
    application: OntologyApplication | undefined,
    now: number,
  ): void {
    if (!application) return
    statements.push(
      statement(
        this.db,
        `UPDATE taxonomy_candidates SET status = 'accepted',
         decision_reason = 'Published by ontology application job.', decided_at = ?
         WHERE id = ? AND status IN ('proposed','accepted')`,
        [now, application.candidateId],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'settled', lease_owner = NULL,
         lease_token = NULL, leased_until = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [now, now, application.job.id, application.job.leaseToken],
      ),
    )
  }

  private auditOntologyStatement(input: {
    batchId: string
    eventId: string
    eventType: string
    entityType: string
    entityId: string
    actorId: string
    policy: RuntimePolicy
    expectedVersion: number
    nextVersion: number
    before: unknown
    after: unknown
    releaseSha: string
    now: number
  }): D1PreparedStatement {
    return statement(
      this.db,
      `INSERT INTO taxonomy_audit_events
       (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
        policy_config_id, prompt_hash, schema_hash, taxonomy_version_before,
        taxonomy_version_after, scores, evidence, before, after, release_sha, created_at)
       VALUES (?, ?, ?, ?, ?, 'system', ?, ?, ?, ?, ?, ?, '{}', '', ?, ?, ?, ?)`,
      [
        input.eventId,
        input.batchId,
        input.eventType,
        input.entityType,
        input.entityId,
        input.actorId,
        input.policy.id,
        input.policy.promptHash,
        input.policy.schemaHash,
        input.expectedVersion,
        input.nextVersion,
        stableJson(input.before),
        stableJson(input.after),
        input.releaseSha,
        input.now,
      ],
    )
  }

  async hasActiveLock(resourceKey: string): Promise<boolean> {
    return Boolean(
      await first(
        this.db,
        `SELECT 1 AS present FROM taxonomy_locks
         WHERE resource_key = ? AND released_at IS NULL LIMIT 1`,
        [resourceKey],
      ),
    )
  }

  async applyAssignments(
    inputs: readonly AssignmentSettlementInput[],
    settleJob: boolean,
  ): Promise<number> {
    if (!inputs.length) return 0
    const firstInput = inputs[0]
    const rows = inputs.map((input) => {
      if (
        input.job.id !== firstInput.job.id ||
        input.job.leaseToken !== firstInput.job.leaseToken ||
        input.site.id !== firstInput.site.id ||
        input.batchId !== firstInput.batchId
      ) {
        throw new Error('Assignment settlements must share one job and site')
      }
      const assignment = input.site.assignments.find(
        ({ tagId }) => tagId === input.tag.id,
      )
      const wasAssigned = Boolean(assignment)
      const shouldAssign = input.action === 'add'
      const mutates =
        input.outcome === 'applied' &&
        wasAssigned !== shouldAssign &&
        (shouldAssign || assignment?.source === 'automation')
      const addedAssignment = {
        rawName: input.tag.name,
        source: 'automation' as const,
        decisionId: input.decisionId,
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      }
      const tagProvenance = {
        id: input.tag.id,
        status: 'active' as const,
        revision: input.tag.revision,
      }
      const before = {
        assigned: wasAssigned,
        tagId: input.tag.id,
        tag: tagProvenance,
        ...(assignment ? { assignment } : {}),
      }
      const resultingAssignment = mutates
        ? shouldAssign
          ? addedAssignment
          : null
        : assignment
      const after = {
        assigned: mutates ? shouldAssign : wasAssigned,
        tagId: input.tag.id,
        tag: tagProvenance,
        ...(resultingAssignment ? { assignment: resultingAssignment } : {}),
      }
      return {
        candidateId: input.candidateId,
        attemptId: input.attemptId,
        candidateKey: input.candidateKey,
        tagId: input.tag.id,
        tagRevision: input.tag.revision,
        payload: stableJson(input.payload),
        confidenceMicros: input.confidenceMicros,
        marginMicros: input.marginMicros,
        rank: input.rank,
        decisionId: input.decisionId,
        action: input.action,
        outcome: input.outcome,
        wasAssigned,
        isAssigned: mutates ? shouldAssign : wasAssigned,
        reason: input.reason.slice(0, 500),
        expectedAssignment: assignment ?? null,
        mutates,
        rawName: resultingAssignment?.rawName ?? input.tag.name,
        assignment: resultingAssignment,
        eventId: input.eventId,
        eventType: mutates
          ? `assignment_${input.action}`
          : 'assignment_evaluated',
        before: stableJson(before),
        after: stableJson(after),
      }
    })
    const decisions = stableJson(rows)
    const statements = [
      statement(
        this.db,
        `SELECT CASE WHEN
           EXISTS (SELECT 1 FROM taxonomy_jobs
                   WHERE id = ?1 AND status = 'leased' AND lease_token = ?2)
           AND EXISTS (SELECT 1 FROM sites
                       WHERE id = ?3 AND status = 'active' AND content_version = ?4
                         AND classification_input_hash = ?5)
           AND (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?6
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?7) decision
             WHERE NOT EXISTS (
               SELECT 1 FROM tags tag
               WHERE tag.id = json_extract(decision.value, '$.tagId')
                 AND tag.status = 'active'
                 AND tag.revision = json_extract(decision.value, '$.tagRevision')
                 AND (json_extract(decision.value, '$.outcome') <> 'applied'
                      OR tag.automation_locked = 0)
             ) OR (
               json_type(decision.value, '$.expectedAssignment') = 'null'
               AND EXISTS (SELECT 1 FROM site_tags assignment
                           WHERE assignment.site_id = ?3
                             AND assignment.tag_id = json_extract(decision.value, '$.tagId'))
             ) OR (
               json_type(decision.value, '$.expectedAssignment') <> 'null'
               AND NOT EXISTS (
                 SELECT 1 FROM site_tags assignment
                 WHERE assignment.site_id = ?3
                   AND assignment.tag_id = json_extract(decision.value, '$.tagId')
                   AND assignment.raw_name = json_extract(decision.value, '$.expectedAssignment.rawName')
                   AND assignment.source = json_extract(decision.value, '$.expectedAssignment.source')
                   AND assignment.decision_id IS json_extract(decision.value, '$.expectedAssignment.decisionId')
                   AND assignment.revision = json_extract(decision.value, '$.expectedAssignment.revision')
                   AND assignment.created_at = json_extract(decision.value, '$.expectedAssignment.createdAt')
                   AND assignment.updated_at = json_extract(decision.value, '$.expectedAssignment.updatedAt')
               )
             ) OR (
               json_extract(decision.value, '$.outcome') = 'applied'
               AND EXISTS (
                 SELECT 1 FROM taxonomy_locks active
                 WHERE active.released_at IS NULL AND active.resource_key IN (
                   'site:' || ?3 || ':tag:' || json_extract(decision.value, '$.tagId'),
                   'tag:' || json_extract(decision.value, '$.tagId')
                 )
               )
             )
           )
         THEN 1 ELSE json_extract('assignment settlement guard failed', '$') END`,
        [
          firstInput.job.id,
          firstInput.job.leaseToken,
          firstInput.site.id,
          firstInput.site.contentVersion,
          firstInput.job.inputHash,
          firstInput.job.taxonomyVersion,
          decisions,
        ],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_change_batches
         (id, kind, status, actor_type, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'classification', 'applied', 'system', ?, ?, ?, ?, ?, ?)`,
        [
          firstInput.batchId,
          firstInput.job.taxonomyVersion,
          firstInput.job.taxonomyVersion,
          `Classification settlement for job ${firstInput.job.id}`,
          firstInput.now,
          firstInput.now,
          firstInput.now,
        ],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_candidates
         (id, job_id, attempt_id, candidate_key, kind, tag_id, payload,
          confidence_micros, margin_micros, rank, status, decision_reason,
          created_at, decided_at)
         SELECT json_extract(value, '$.candidateId'), ?,
                json_extract(value, '$.attemptId'), json_extract(value, '$.candidateKey'),
                'existing_tag', json_extract(value, '$.tagId'),
                json_extract(value, '$.payload'), json_extract(value, '$.confidenceMicros'),
                json_extract(value, '$.marginMicros'), json_extract(value, '$.rank'),
                CASE WHEN json_extract(value, '$.outcome') = 'applied'
                     THEN 'accepted' ELSE 'deferred' END,
                json_extract(value, '$.reason'), ?, ?
         FROM json_each(?)`,
        [firstInput.job.id, firstInput.now, firstInput.now, decisions],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO tag_assignment_decisions
         (id, site_id, tag_id, job_id, candidate_id, action, outcome, source,
          confidence_micros, was_assigned, is_assigned, reason, input_hash,
          taxonomy_version, site_content_version, provider_config_id,
          policy_config_id, created_at)
         SELECT json_extract(value, '$.decisionId'), ?, json_extract(value, '$.tagId'),
                ?, json_extract(value, '$.candidateId'), json_extract(value, '$.action'),
                json_extract(value, '$.outcome'), 'provider',
                json_extract(value, '$.confidenceMicros'),
                json_extract(value, '$.wasAssigned'), json_extract(value, '$.isAssigned'),
                json_extract(value, '$.reason'), ?, ?, ?, ?, ?, ?
         FROM json_each(?)`,
        [
          firstInput.site.id,
          firstInput.job.id,
          firstInput.job.inputHash,
          firstInput.job.taxonomyVersion,
          firstInput.site.contentVersion,
          firstInput.providerConfigId,
          firstInput.policy.id,
          firstInput.now,
          decisions,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO site_tags
         (site_id, tag_id, raw_name, source, decision_id, revision, created_at, updated_at)
         SELECT ?, json_extract(value, '$.tagId'), json_extract(value, '$.assignment.rawName'),
                'automation', json_extract(value, '$.decisionId'),
                json_extract(value, '$.assignment.revision'),
                json_extract(value, '$.assignment.createdAt'),
                json_extract(value, '$.assignment.updatedAt')
         FROM json_each(?)
         WHERE json_extract(value, '$.mutates') = 1
           AND json_extract(value, '$.action') = 'add'`,
        [firstInput.site.id, decisions],
      ),
      statement(
        this.db,
        `DELETE FROM site_tags
         WHERE site_id = ? AND EXISTS (
           SELECT 1 FROM json_each(?) decision
           WHERE json_extract(decision.value, '$.mutates') = 1
             AND json_extract(decision.value, '$.action') = 'remove'
             AND json_extract(decision.value, '$.tagId') = site_tags.tag_id
         )`,
        [firstInput.site.id, decisions],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_audit_events
         (id, batch_id, job_id, decision_id, event_type, entity_type, entity_id,
          actor_type, actor_id, provider_config_id, provider_model, policy_config_id,
          prompt_hash, schema_hash, input_hash, taxonomy_version_before,
          taxonomy_version_after, scores, evidence, before, after, release_sha, created_at)
         SELECT json_extract(value, '$.eventId'), ?, ?,
                json_extract(value, '$.decisionId'), json_extract(value, '$.eventType'),
                'site_assignment', ? || ':' || json_extract(value, '$.tagId'),
                'provider', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                json_object('confidenceMicros', json_extract(value, '$.confidenceMicros')),
                json_extract(value, '$.reason'), json_extract(value, '$.before'),
                json_extract(value, '$.after'), ?, ?
         FROM json_each(?)`,
        [
          firstInput.batchId,
          firstInput.job.id,
          String(firstInput.site.id),
          String(firstInput.providerConfigId),
          firstInput.providerConfigId,
          firstInput.providerModel,
          firstInput.policy.id,
          firstInput.policy.promptHash,
          firstInput.policy.schemaHash,
          firstInput.job.inputHash,
          firstInput.job.taxonomyVersion,
          firstInput.job.taxonomyVersion,
          firstInput.releaseSha,
          firstInput.now,
          decisions,
        ],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'settled', lease_owner = NULL,
         lease_token = NULL, leased_until = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ? AND ? = 1
           AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND content_version = ?
                       AND classification_input_hash = ?)`,
        [
          firstInput.now,
          firstInput.now,
          firstInput.job.id,
          firstInput.job.leaseToken,
          settleJob ? 1 : 0,
          firstInput.site.id,
          firstInput.site.contentVersion,
          firstInput.job.inputHash,
        ],
      ),
    ]
    await this.db.batch(statements)
    return rows.filter(({ mutates }) => mutates).length
  }

  async settleClassification(
    job: TaxonomyJob,
    site: SiteSnapshot,
    now: number,
  ): Promise<void> {
    await this.db.batch([
      statement(
        this.db,
        `SELECT CASE WHEN
           EXISTS (SELECT 1 FROM taxonomy_jobs
                   WHERE id = ? AND status = 'leased' AND lease_token = ?)
           AND EXISTS (SELECT 1 FROM sites
                       WHERE id = ? AND status = 'active' AND content_version = ?
                         AND classification_input_hash = ?)
           AND (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
         THEN 1 ELSE json_extract('classification settlement guard failed', '$') END`,
        [
          job.id,
          job.leaseToken,
          site.id,
          site.contentVersion,
          job.inputHash,
          job.taxonomyVersion,
        ],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = 'settled', lease_owner = NULL,
         lease_token = NULL, leased_until = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [now, now, job.id, job.leaseToken],
      ),
    ])
  }

  async leaseOutbox(limit: number, now: number, leaseSeconds: number) {
    const rows = await all(
      this.db,
      `SELECT id FROM taxonomy_outbox WHERE dispatched_at IS NULL AND available_at <= ?
       AND (leased_until IS NULL OR leased_until < ?) ORDER BY available_at, id LIMIT ?`,
      [now, now, limit],
    )
    const leased: Array<{ id: string; jobId: string; token: string }> = []
    for (const row of rows) {
      const id = text(row, 'id')
      const token = crypto.randomUUID()
      const changed = await changes(
        this.db,
        `UPDATE taxonomy_outbox SET lease_token = ?, leased_until = ?,
         dispatch_attempts = dispatch_attempts + 1 WHERE id = ? AND dispatched_at IS NULL
         AND (leased_until IS NULL OR leased_until < ?)`,
        [token, now + leaseSeconds, id, now],
      )
      if (!changed) continue
      const leasedRow = await first(
        this.db,
        'SELECT job_id FROM taxonomy_outbox WHERE id = ? AND lease_token = ?',
        [id, token],
      )
      if (leasedRow)
        leased.push({ id, jobId: text(leasedRow, 'job_id'), token })
    }
    return leased
  }

  async completeOutbox(id: string, token: string, now: number): Promise<void> {
    await changes(
      this.db,
      `UPDATE taxonomy_outbox SET dispatched_at = ?, lease_token = NULL, leased_until = NULL,
       last_error = NULL WHERE id = ? AND lease_token = ?`,
      [now, id, token],
    )
  }

  async failOutbox(
    id: string,
    token: string,
    availableAt: number,
    error: string,
  ): Promise<void> {
    await changes(
      this.db,
      `UPDATE taxonomy_outbox SET available_at = ?, lease_token = NULL, leased_until = NULL,
       last_error = ? WHERE id = ? AND lease_token = ?`,
      [availableAt, error.slice(0, 500), id, token],
    )
  }

  async maintenance(now: number): Promise<{
    staleJobs: number
    staleOutbox: number
    rawResponsesPurged: number
    reconciledOutbox: number
  }> {
    const results = await this.db.batch([
      statement(
        this.db,
        `UPDATE taxonomy_jobs SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'retry_wait' END,
         available_at = ?, lease_owner = NULL, lease_token = NULL, leased_until = NULL,
         completed_at = CASE WHEN attempt_count >= max_attempts THEN ? ELSE NULL END,
         updated_at = ?, last_error_code = 'stale_lease', last_error_summary = 'Lease expired before settlement.'
         WHERE status = 'leased' AND leased_until < ?`,
        [now, now, now, now],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_outbox SET lease_token = NULL, leased_until = NULL,
         last_error = 'Dispatch lease expired.' WHERE dispatched_at IS NULL AND leased_until < ?`,
        [now],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_outbox SET dispatched_at = NULL, available_at = ?,
         lease_token = NULL, leased_until = NULL, last_error = 'Runnable job queue delivery reconciled.'
         WHERE job_id IN (SELECT id FROM taxonomy_jobs
                           WHERE status IN ('pending', 'retry_wait')
                           ORDER BY updated_at, id LIMIT 500)
           AND dispatched_at IS NOT NULL AND dispatched_at <= ?`,
        [now, now - 300],
      ),
      statement(
        this.db,
        `INSERT OR IGNORE INTO taxonomy_outbox
         (id, job_id, payload, available_at, created_at)
         SELECT 'outbox:' || id, id, json_object('jobId', id), available_at, ?
         FROM taxonomy_jobs
         WHERE status IN ('pending', 'retry_wait')
         ORDER BY updated_at, id LIMIT 500`,
        [now],
      ),
      statement(
        this.db,
        `UPDATE taxonomy_job_attempts SET raw_response = NULL, raw_response_expires_at = NULL
         WHERE raw_response IS NOT NULL AND raw_response_expires_at <= ?`,
        [now],
      ),
    ])
    return {
      staleJobs: results[0]?.meta.changes ?? 0,
      staleOutbox: results[1]?.meta.changes ?? 0,
      reconciledOutbox:
        (results[2]?.meta.changes ?? 0) + (results[3]?.meta.changes ?? 0),
      rawResponsesPurged: results[4]?.meta.changes ?? 0,
    }
  }

  async setMode(
    mode: TaxonomyMode,
    now: number,
    releaseSha = 'unknown',
    actorId = 'system',
  ): Promise<void> {
    const state = await this.loadState()
    await this.auditControlPlane(
      'mode_changed',
      'taxonomy_state',
      '1',
      { mode: state.mode },
      { mode },
      now,
      releaseSha,
      actorId,
      statement(
        this.db,
        `UPDATE taxonomy_state SET mode = ?, mode_changed_at = ?, updated_at = ? WHERE id = 1 AND mode = ?`,
        [mode, now, now, state.mode],
      ),
    )
  }

  async openCircuit(
    reason: string,
    now: number,
    releaseSha = 'unknown',
  ): Promise<void> {
    const state = await this.loadState()
    if (state.circuitState === 'open') return
    await this.auditControlPlane(
      'circuit_opened',
      'taxonomy_state',
      '1',
      { circuitState: state.circuitState, mode: state.mode },
      { circuitState: 'open', mode: 'degraded', reason: reason.slice(0, 500) },
      now,
      releaseSha,
      'taxonomy-runtime',
      statement(
        this.db,
        `UPDATE taxonomy_state SET circuit_state = 'open', circuit_reason = ?,
         circuit_opened_at = coalesce(circuit_opened_at, ?), mode = 'degraded', updated_at = ?
         WHERE id = 1 AND circuit_state <> 'open'`,
        [reason.slice(0, 500), now, now],
      ),
    )
  }

  async closeCircuit(
    now: number,
    releaseSha = 'unknown',
    actorId = 'system',
  ): Promise<void> {
    const state = await this.loadState()
    if (state.circuitState === 'closed') return
    await this.auditControlPlane(
      'circuit_closed',
      'taxonomy_state',
      '1',
      { circuitState: state.circuitState, reason: state.circuitReason },
      { circuitState: 'closed' },
      now,
      releaseSha,
      actorId,
      statement(
        this.db,
        `UPDATE taxonomy_state SET circuit_state = 'closed', circuit_reason = NULL,
         circuit_opened_at = NULL, updated_at = ? WHERE id = 1 AND circuit_state <> 'closed'`,
        [now],
      ),
    )
  }

  async auditControlPlane(
    eventType: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    now: number,
    releaseSha: string,
    actorId: string,
    mutation?: D1PreparedStatement | D1PreparedStatement[],
  ): Promise<void> {
    const state = await this.loadState()
    const suffix = crypto.randomUUID()
    const batchId = `control:${suffix}`
    const statements = mutation
      ? Array.isArray(mutation)
        ? [...mutation]
        : [mutation]
      : []
    statements.push(
      statement(
        this.db,
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at, created_at)
         VALUES (?, 'ontology', 'applied', 'admin', ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          actorId,
          state.publishedVersion,
          state.publishedVersion,
          eventType,
          now,
          now,
          now,
        ],
      ),
      statement(
        this.db,
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?, '{}', '', ?, ?, ?, ?)`,
        [
          `control-event:${suffix}`,
          batchId,
          eventType,
          entityType,
          entityId,
          actorId,
          state.publishedVersion,
          state.publishedVersion,
          stableJson(before),
          stableJson(after),
          releaseSha,
          now,
        ],
      ),
    )
    await this.db.batch(statements)
  }

  async circuitMetrics(now: number): Promise<{
    attempts: number
    schemaFailures: number
    disagreements: number
    rollbacks: number
    mutations: number
  }> {
    const since = now - 86_400
    const row = await first(
      this.db,
      `SELECT
       (SELECT count(*) FROM taxonomy_job_attempts WHERE started_at >= ?) AS attempts,
       (SELECT count(*) FROM taxonomy_job_attempts WHERE started_at >= ? AND status = 'invalid_response') AS schema_failures,
       (SELECT count(*) FROM taxonomy_jobs WHERE updated_at >= ? AND last_error_code = 'provider_disagreement') AS disagreements,
       (SELECT count(*) FROM taxonomy_change_batches WHERE created_at >= ? AND kind = 'rollback' AND status IN ('applied','partial')) AS rollbacks,
       (SELECT count(*) FROM taxonomy_audit_events WHERE created_at >= ? AND event_type IN ('assignment_add','assignment_remove','canonical_created','alias_created','tags_merged','parent_created')) AS mutations`,
      [since, since, since, since, since],
    )
    return row
      ? {
          attempts: integer(row, 'attempts'),
          schemaFailures: integer(row, 'schema_failures'),
          disagreements: integer(row, 'disagreements'),
          rollbacks: integer(row, 'rollbacks'),
          mutations: integer(row, 'mutations'),
        }
      : {
          attempts: 0,
          schemaFailures: 0,
          disagreements: 0,
          rollbacks: 0,
          mutations: 0,
        }
  }

  async shadowReadinessMetrics(
    since: number,
    requiredVoters = 1,
  ): Promise<{
    samples: number
    coverageBasisPoints: number
    schemaSuccessBasisPoints: number
    agreementBasisPoints: number
  }> {
    const row = await first(
      this.db,
      `SELECT
       (SELECT count(*) FROM taxonomy_jobs WHERE kind = 'classify_site' AND completed_at >= ? AND status = 'settled') AS samples,
       (SELECT count(*) FROM sites WHERE status = 'active') AS eligible,
       (SELECT count(DISTINCT site_id) FROM taxonomy_jobs WHERE kind = 'classify_site'
        AND completed_at >= ? AND status = 'settled') AS covered,
       (SELECT count(*) FROM taxonomy_job_attempts WHERE completed_at >= ?) AS attempts,
       (SELECT count(*) FROM taxonomy_job_attempts WHERE completed_at >= ? AND status = 'succeeded') AS succeeded,
       (SELECT count(*) FROM taxonomy_jobs job WHERE job.kind = 'classify_site'
        AND job.completed_at >= ? AND job.status = 'settled'
        AND (SELECT count(DISTINCT attempt.provider_config_id)
             FROM taxonomy_job_attempts attempt
             WHERE attempt.job_id = job.id AND attempt.status = 'succeeded') >= ?) AS voter_complete,
       (SELECT count(*) FROM taxonomy_jobs WHERE kind = 'classify_site' AND completed_at >= ? AND last_error_code = 'provider_disagreement') AS disagreements`,
      [since, since, since, since, since, requiredVoters, since],
    )
    if (!row) {
      return {
        samples: 0,
        coverageBasisPoints: 0,
        schemaSuccessBasisPoints: 0,
        agreementBasisPoints: 0,
      }
    }
    const samples = integer(row, 'samples')
    const eligible = integer(row, 'eligible')
    const covered = integer(row, 'covered')
    const attempts = integer(row, 'attempts')
    const succeeded = integer(row, 'succeeded')
    const voterComplete = integer(row, 'voter_complete')
    const disagreements = integer(row, 'disagreements')
    return {
      samples,
      coverageBasisPoints: eligible
        ? Math.min(10_000, Math.floor((covered * 10_000) / eligible))
        : 0,
      schemaSuccessBasisPoints: attempts
        ? Math.floor((succeeded * 10_000) / attempts)
        : 0,
      agreementBasisPoints: samples
        ? Math.max(
            0,
            Math.floor((voterComplete * 10_000) / samples) -
              Math.floor((disagreements * 10_000) / samples),
          )
        : 0,
    }
  }

  async backfillSites(cursor: number, limit: number) {
    return all(
      this.db,
      `SELECT id, name, url, description, content_version, classification_input_hash FROM sites
       WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?`,
      [cursor, limit],
    ).then((rows) =>
      rows.map((row) => ({
        id: integer(row, 'id'),
        name: text(row, 'name'),
        url: text(row, 'url'),
        description: text(row, 'description'),
        contentVersion: integer(row, 'content_version'),
        classificationInputHash: nullableText(row, 'classification_input_hash'),
      })),
    )
  }
}
