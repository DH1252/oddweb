import { TaxonomyRepository } from '../taxonomy'
import type { RuntimePolicy, TaxonomyState } from '../taxonomy/runtime-types'

type BindValue = ArrayBuffer | ArrayBufferView | null | number | string
type JsonValue =
  boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue }
type Row = Record<string, boolean | null | number | string>

export type TaxonomyAdminPage<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type TaxonomyProviderAdminRecord = {
  id: number
  name: string
  revision: number
  providerKind: 'openai_compatible' | 'gemini'
  endpoint: string
  model: string
  dialect: 'responses' | 'chat_completions' | null
  routingGroup: string
  routingRole: 'primary' | 'failover' | 'consensus'
  routingPriority: number
  timeoutMs: number
  keyVersion: number
  credentialFingerprint: string
  enabled: boolean
  active: boolean
  supersedesId: number | null
  createdBy: string
  createdAt: number
}

export type TaxonomyPolicyAdminRecord = RuntimePolicy & {
  active: boolean
  supersedesId: number | null
  createdBy: string
  createdAt: number
}

export type TaxonomyCandidateStatus =
  'proposed' | 'accepted' | 'rejected' | 'deferred' | 'conflict'
export type TaxonomyCandidateKind =
  'existing_tag' | 'novel_concept' | 'alias' | 'merge' | 'parent_edge'

export type TaxonomyCandidateAdminRecord = {
  id: string
  jobId: string
  attemptId: string | null
  candidateKey: string
  kind: TaxonomyCandidateKind
  tagId: number | null
  relatedTagId: number | null
  normalizedConcept: string | null
  proposedName: string | null
  proposedSlug: string | null
  payload: JsonValue | null
  confidenceMicros: number
  marginMicros: number | null
  rank: number
  status: TaxonomyCandidateStatus
  decisionReason: string | null
  createdAt: number
  decidedAt: number | null
  evidence: Array<{
    siteId: number
    snippet: string
    confidenceMicros: number
    source: string
  }>
  evidenceTotal: number
}

export type TaxonomyAttemptAdminRecord = {
  id: string
  jobId: string
  attemptNumber: number
  providerConfigId: number | null
  status: string
  providerRequestId: string | null
  providerModel: string | null
  requestHash: string
  responseHash: string | null
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  errorCode: string | null
  errorSummary: string | null
  startedAt: number
  completedAt: number | null
}

export type TaxonomyAuditAdminRecord = {
  id: string
  batchId: string | null
  jobId: string | null
  decisionId: string | null
  eventType: string
  entityType: string
  entityId: string
  actorType: string
  actorId: string | null
  providerConfigId: number | null
  providerModel: string | null
  policyConfigId: number | null
  taxonomyVersionBefore: number | null
  taxonomyVersionAfter: number | null
  scores: JsonValue | null
  before: JsonValue | null
  after: JsonValue | null
  releaseSha: string
  rollbackOfEventId: string | null
  compensatesEventId: string | null
  createdAt: number
}

export type TaxonomyDashboard = {
  state: TaxonomyState
  health: {
    healthy: boolean
    circuit: Awaited<ReturnType<TaxonomyRepository['circuitMetrics']>>
    budget: {
      requests: number
      tokens: number
      requestLimit: number | null
      tokenLimit: number | null
    }
  }
  counts: {
    enabledProviders: number
    queuedJobs: number
    deadJobs: number
    activeLocks: number
    proposedCandidates: number
    unclassifiedSites: number
    jobsByStatus: Record<string, number>
  }
  readiness: {
    readyForGradual: boolean
    metrics: Awaited<ReturnType<TaxonomyRepository['shadowReadinessMetrics']>>
    thresholds: {
      samples: number | null
      coverageBasisPoints: number | null
      schemaSuccessBasisPoints: number | null
      agreementBasisPoints: number | null
    }
    checks: Record<string, boolean>
  }
}

async function rows(sql: string, values: readonly BindValue[], db: D1Database) {
  const result = await db
    .prepare(sql)
    .bind(...values)
    .all<Row>()
  return result.results
}

async function count(
  sql: string,
  values: readonly BindValue[],
  db: D1Database,
) {
  const row = await db
    .prepare(sql)
    .bind(...values)
    .first<{ total: number }>()
  return row?.total ?? 0
}

function pageResult<T>(
  items: T[],
  input: { page: number; pageSize: number },
  total: number,
): TaxonomyAdminPage<T> {
  return { items, page: input.page, pageSize: input.pageSize, total }
}

function maskFingerprint(value: unknown) {
  const fingerprint = String(value ?? '')
  return `****${fingerprint.slice(-8)}`
}

function parseJson(value: boolean | null | number | string): JsonValue | null {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return null
  }
}

function numberValue(row: Row, key: string) {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`Invalid numeric ${key}`)
  return value
}

function nullableNumber(row: Row, key: string) {
  const value = row[key]
  return value === null ? null : numberValue(row, key)
}

function stringValue(row: Row, key: string) {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Invalid text ${key}`)
  return value
}

function nullableString(row: Row, key: string) {
  const value = row[key]
  return value === null ? null : stringValue(row, key)
}

function providerKind(
  value: string,
): TaxonomyProviderAdminRecord['providerKind'] {
  if (value === 'openai_compatible' || value === 'gemini') return value
  throw new Error('Invalid provider kind')
}

function providerDialect(
  value: string | null,
): TaxonomyProviderAdminRecord['dialect'] {
  if (value === null || value === 'responses' || value === 'chat_completions')
    return value
  throw new Error('Invalid provider dialect')
}

function providerRole(
  value: string,
): TaxonomyProviderAdminRecord['routingRole'] {
  if (value === 'primary' || value === 'failover' || value === 'consensus')
    return value
  throw new Error('Invalid provider routing role')
}

function candidateKind(value: string): TaxonomyCandidateKind {
  if (value === 'existing_tag') return value
  if (value === 'novel_concept') return value
  if (value === 'alias') return value
  if (value === 'merge') return value
  if (value === 'parent_edge') return value
  throw new Error('Invalid taxonomy candidate kind')
}

function candidateStatus(value: string): TaxonomyCandidateStatus {
  if (value === 'proposed') return value
  if (value === 'accepted') return value
  if (value === 'rejected') return value
  if (value === 'deferred') return value
  if (value === 'conflict') return value
  throw new Error('Invalid taxonomy candidate status')
}

function candidateEvidence(value: JsonValue | null) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') return []
    const { siteId, snippet, confidenceMicros, source } = item
    return typeof siteId === 'number' &&
      typeof snippet === 'string' &&
      typeof confidenceMicros === 'number' &&
      typeof source === 'string'
      ? [{ siteId, snippet, confidenceMicros, source }]
      : []
  })
}

export async function readTaxonomyDashboard(
  db: D1Database,
): Promise<TaxonomyDashboard> {
  const repository = new TaxonomyRepository(db)
  const state = await repository.loadState()
  const policy =
    state.activePolicyConfigId === null
      ? null
      : await repository.loadPolicy(state.activePolicyConfigId)
  const [readiness, circuit, usage, totals, statuses] = await Promise.all([
    repository.shadowReadinessMetrics({
      policyConfigId: state.activePolicyConfigId,
      providerConfigId: state.activeProviderConfigId,
    }),
    repository.circuitMetrics(Math.floor(Date.now() / 1_000)),
    repository.budgetUsage(Math.floor(Date.now() / 1_000)),
    db
      .prepare(
        `SELECT
       (SELECT count(*) FROM taxonomy_provider_configs WHERE enabled = 1) AS enabledProviders,
       (SELECT count(*) FROM taxonomy_jobs WHERE status IN ('pending','leased','retry_wait')) AS queuedJobs,
       (SELECT count(*) FROM taxonomy_jobs WHERE status = 'dead') AS deadJobs,
       (SELECT count(*) FROM taxonomy_locks WHERE released_at IS NULL) AS activeLocks,
       (SELECT count(*) FROM taxonomy_candidates WHERE status = 'proposed') AS proposedCandidates,
       (SELECT count(*) FROM sites WHERE status = 'active' AND classification_input_hash IS NULL) AS unclassifiedSites`,
      )
      .first<Row>(),
    rows(
      `SELECT status, count(*) AS count FROM taxonomy_jobs
       GROUP BY status ORDER BY status LIMIT 16`,
      [],
      db,
    ),
  ])
  if (!totals) throw new Error('Taxonomy dashboard totals are unavailable')
  const checks = {
    inShadowMode: state.mode === 'shadow',
    circuitClosed: state.circuitState === 'closed',
    providerConfigured: state.activeProviderConfigId !== null,
    policyConfigured: state.activePolicyConfigId !== null,
    minimumSamples:
      policy !== null && readiness.samples >= policy.shadowMinimumSamples,
    minimumCoverage:
      policy !== null &&
      readiness.coverageBasisPoints >= policy.shadowMinimumCoverageBasisPoints,
    schemaSuccess:
      policy !== null &&
      readiness.schemaSuccessBasisPoints >=
        policy.shadowSchemaSuccessBasisPoints,
    providerAgreement:
      policy !== null &&
      readiness.agreementBasisPoints >=
        policy.shadowProviderAgreementBasisPoints,
  }
  return {
    state,
    health: {
      healthy:
        state.circuitState === 'closed' &&
        state.mode !== 'degraded' &&
        state.activeProviderConfigId !== null &&
        policy !== null,
      circuit,
      budget: {
        ...usage,
        requestLimit: policy?.dailyRequestBudget ?? null,
        tokenLimit: policy?.dailyTokenBudget ?? null,
      },
    },
    counts: {
      enabledProviders: Number(totals.enabledProviders),
      queuedJobs: Number(totals.queuedJobs),
      deadJobs: Number(totals.deadJobs),
      activeLocks: Number(totals.activeLocks),
      proposedCandidates: Number(totals.proposedCandidates),
      unclassifiedSites: Number(totals.unclassifiedSites),
      jobsByStatus: Object.fromEntries(
        statuses.map((row) => [String(row.status), Number(row.count)]),
      ),
    },
    readiness: {
      readyForGradual: Object.values(checks).every(Boolean),
      metrics: readiness,
      thresholds: {
        samples: policy?.shadowMinimumSamples ?? null,
        coverageBasisPoints: policy?.shadowMinimumCoverageBasisPoints ?? null,
        schemaSuccessBasisPoints:
          policy?.shadowSchemaSuccessBasisPoints ?? null,
        agreementBasisPoints:
          policy?.shadowProviderAgreementBasisPoints ?? null,
      },
      checks,
    },
  }
}

export async function listTaxonomyProviders(
  input: { page: number; pageSize: number },
  db: D1Database,
): Promise<TaxonomyAdminPage<TaxonomyProviderAdminRecord>> {
  const state = await new TaxonomyRepository(db).loadState()
  const total = await count(
    'SELECT count(*) AS total FROM taxonomy_provider_configs',
    [],
    db,
  )
  const result = await rows(
    `SELECT id, name, revision, provider_kind AS providerKind, endpoint, model,
            dialect, routing_group AS routingGroup, routing_role AS routingRole,
            routing_priority AS routingPriority, timeout_ms AS timeoutMs,
            key_version AS keyVersion, credential_fingerprint AS credentialFingerprint,
            enabled, supersedes_id AS supersedesId, created_by AS createdBy,
            created_at AS createdAt
     FROM taxonomy_provider_configs ORDER BY name, revision DESC, id DESC
     LIMIT ?1 OFFSET ?2`,
    [input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(
    result.map((row) => ({
      id: numberValue(row, 'id'),
      name: stringValue(row, 'name'),
      revision: numberValue(row, 'revision'),
      providerKind: providerKind(stringValue(row, 'providerKind')),
      endpoint: stringValue(row, 'endpoint'),
      model: stringValue(row, 'model'),
      dialect: providerDialect(nullableString(row, 'dialect')),
      routingGroup: stringValue(row, 'routingGroup'),
      routingRole: providerRole(stringValue(row, 'routingRole')),
      routingPriority: numberValue(row, 'routingPriority'),
      timeoutMs: numberValue(row, 'timeoutMs'),
      keyVersion: numberValue(row, 'keyVersion'),
      credentialFingerprint: maskFingerprint(row.credentialFingerprint),
      enabled: Boolean(row.enabled),
      active: row.id === state.activeProviderConfigId,
      supersedesId: nullableNumber(row, 'supersedesId'),
      createdBy: stringValue(row, 'createdBy'),
      createdAt: numberValue(row, 'createdAt'),
    })),
    input,
    total,
  )
}

export async function listTaxonomyPolicies(
  input: { page: number; pageSize: number },
  db: D1Database,
): Promise<TaxonomyAdminPage<TaxonomyPolicyAdminRecord>> {
  const state = await new TaxonomyRepository(db).loadState()
  const total = await count(
    'SELECT count(*) AS total FROM taxonomy_policy_configs',
    [],
    db,
  )
  const result = await rows(
    `SELECT id, revision, assignment_limit AS assignmentLimit,
            novel_evidence_site_threshold AS novelEvidenceSiteThreshold,
            assignment_confidence_micros AS assignmentConfidenceMicros,
            ontology_confidence_micros AS ontologyConfidenceMicros,
            minimum_margin_micros AS minimumMarginMicros,
            hierarchy_max_depth AS hierarchyMaxDepth,
            hierarchy_max_fanout AS hierarchyMaxFanout,
            ontology_provider_agreement AS ontologyProviderAgreement,
            retry_budget AS retryBudget, retry_base_seconds AS retryBaseSeconds,
            retry_max_seconds AS retryMaxSeconds, rollout_basis_points AS rolloutBasisPoints,
            daily_request_budget AS dailyRequestBudget, daily_token_budget AS dailyTokenBudget,
            schema_failure_trip_basis_points AS schemaFailureTripBasisPoints,
            disagreement_trip_basis_points AS disagreementTripBasisPoints,
            rollback_trip_basis_points AS rollbackTripBasisPoints,
            mutation_volume_trip_count AS mutationVolumeTripCount,
            raw_response_retention_seconds AS rawResponseRetentionSeconds,
            shadow_minimum_samples AS shadowMinimumSamples,
            shadow_minimum_coverage_basis_points AS shadowMinimumCoverageBasisPoints,
            shadow_schema_success_basis_points AS shadowSchemaSuccessBasisPoints,
            shadow_provider_agreement_basis_points AS shadowProviderAgreementBasisPoints,
            prompt_hash AS promptHash, schema_hash AS schemaHash,
            supersedes_id AS supersedesId, created_by AS createdBy, created_at AS createdAt
     FROM taxonomy_policy_configs
     ORDER BY id = (SELECT active_policy_config_id FROM taxonomy_state WHERE id = 1) DESC,
              revision DESC
     LIMIT ?1 OFFSET ?2`,
    [input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(
    result.map((row) => ({
      id: numberValue(row, 'id'),
      revision: numberValue(row, 'revision'),
      assignmentLimit: numberValue(row, 'assignmentLimit'),
      novelEvidenceSiteThreshold: numberValue(
        row,
        'novelEvidenceSiteThreshold',
      ),
      assignmentConfidenceMicros: numberValue(
        row,
        'assignmentConfidenceMicros',
      ),
      ontologyConfidenceMicros: numberValue(row, 'ontologyConfidenceMicros'),
      minimumMarginMicros: numberValue(row, 'minimumMarginMicros'),
      hierarchyMaxDepth: numberValue(row, 'hierarchyMaxDepth'),
      hierarchyMaxFanout: numberValue(row, 'hierarchyMaxFanout'),
      ontologyProviderAgreement: numberValue(row, 'ontologyProviderAgreement'),
      retryBudget: numberValue(row, 'retryBudget'),
      retryBaseSeconds: numberValue(row, 'retryBaseSeconds'),
      retryMaxSeconds: numberValue(row, 'retryMaxSeconds'),
      rolloutBasisPoints: numberValue(row, 'rolloutBasisPoints'),
      dailyRequestBudget: numberValue(row, 'dailyRequestBudget'),
      dailyTokenBudget: numberValue(row, 'dailyTokenBudget'),
      schemaFailureTripBasisPoints: numberValue(
        row,
        'schemaFailureTripBasisPoints',
      ),
      disagreementTripBasisPoints: numberValue(
        row,
        'disagreementTripBasisPoints',
      ),
      rollbackTripBasisPoints: numberValue(row, 'rollbackTripBasisPoints'),
      mutationVolumeTripCount: numberValue(row, 'mutationVolumeTripCount'),
      rawResponseRetentionSeconds: numberValue(
        row,
        'rawResponseRetentionSeconds',
      ),
      shadowMinimumSamples: numberValue(row, 'shadowMinimumSamples'),
      shadowMinimumCoverageBasisPoints: numberValue(
        row,
        'shadowMinimumCoverageBasisPoints',
      ),
      shadowSchemaSuccessBasisPoints: numberValue(
        row,
        'shadowSchemaSuccessBasisPoints',
      ),
      shadowProviderAgreementBasisPoints: numberValue(
        row,
        'shadowProviderAgreementBasisPoints',
      ),
      promptHash: stringValue(row, 'promptHash'),
      schemaHash: stringValue(row, 'schemaHash'),
      active: row.id === state.activePolicyConfigId,
      supersedesId: nullableNumber(row, 'supersedesId'),
      createdBy: stringValue(row, 'createdBy'),
      createdAt: numberValue(row, 'createdAt'),
    })),
    input,
    total,
  )
}

export async function listTaxonomyJobs(
  input: {
    page: number
    pageSize: number
    status: string | null
    kind: string | null
  },
  db: D1Database,
) {
  const clauses: string[] = []
  const values: BindValue[] = []
  if (input.status) {
    values.push(input.status)
    clauses.push(`j.status = ?${values.length}`)
  }
  if (input.kind) {
    values.push(input.kind)
    clauses.push(`j.kind = ?${values.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = await count(
    `SELECT count(*) AS total FROM taxonomy_jobs j ${where}`,
    values,
    db,
  )
  const items = await rows(
    `SELECT j.id, j.kind, j.site_id AS siteId, j.concept_key AS conceptKey,
            j.taxonomy_version AS taxonomyVersion, j.provider_config_id AS providerConfigId,
            j.policy_config_id AS policyConfigId, j.batch_id AS batchId, j.status,
            j.priority, j.available_at AS availableAt, j.attempt_count AS attemptCount,
            j.max_attempts AS maxAttempts, j.last_error_code AS lastErrorCode,
            j.last_error_summary AS lastErrorSummary, j.created_at AS createdAt,
            j.updated_at AS updatedAt, j.completed_at AS completedAt,
            (SELECT count(*) FROM taxonomy_job_attempts a WHERE a.job_id = j.id) AS recordedAttempts,
            (SELECT max(a.started_at) FROM taxonomy_job_attempts a WHERE a.job_id = j.id) AS lastAttemptAt
     FROM taxonomy_jobs j ${where}
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
    [...values, input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(items, input, total)
}

export async function listTaxonomyCandidates(
  input: {
    page: number
    pageSize: number
    status: TaxonomyCandidateStatus | null
    kind: TaxonomyCandidateKind | null
  },
  db: D1Database,
): Promise<TaxonomyAdminPage<TaxonomyCandidateAdminRecord>> {
  const clauses: string[] = []
  const values: BindValue[] = []
  if (input.status) {
    values.push(input.status)
    clauses.push(`c.status = ?${values.length}`)
  }
  if (input.kind) {
    values.push(input.kind)
    clauses.push(`c.kind = ?${values.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = await count(
    `SELECT count(*) AS total FROM taxonomy_candidates c ${where}`,
    values,
    db,
  )
  const result = await rows(
    `SELECT c.id, c.job_id AS jobId, c.attempt_id AS attemptId,
            c.candidate_key AS candidateKey, c.kind, c.tag_id AS tagId,
            c.related_tag_id AS relatedTagId,
            c.normalized_concept AS normalizedConcept,
            c.proposed_name AS proposedName, c.proposed_slug AS proposedSlug,
            c.payload, c.confidence_micros AS confidenceMicros,
            c.margin_micros AS marginMicros, c.rank, c.status,
            c.decision_reason AS decisionReason, c.created_at AS createdAt,
            c.decided_at AS decidedAt,
             coalesce((SELECT json_group_array(json_object(
              'siteId', e.site_id,
              'snippet', e.evidence_snippet,
              'confidenceMicros', e.confidence_micros,
              'source', e.source
             )) FROM (
               SELECT site_id, evidence_snippet, confidence_micros, source
               FROM taxonomy_concept_evidence
               WHERE normalized_concept = c.normalized_concept
               ORDER BY observed_at DESC, id DESC LIMIT 8
             ) e), '[]') AS evidence,
             (SELECT count(*) FROM taxonomy_concept_evidence e
              WHERE e.normalized_concept = c.normalized_concept) AS evidenceTotal
     FROM taxonomy_candidates c ${where}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
    [...values, input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(
    result.map((row) => ({
      id: stringValue(row, 'id'),
      jobId: stringValue(row, 'jobId'),
      attemptId: nullableString(row, 'attemptId'),
      candidateKey: stringValue(row, 'candidateKey'),
      kind: candidateKind(stringValue(row, 'kind')),
      tagId: nullableNumber(row, 'tagId'),
      relatedTagId: nullableNumber(row, 'relatedTagId'),
      normalizedConcept: nullableString(row, 'normalizedConcept'),
      proposedName: nullableString(row, 'proposedName'),
      proposedSlug: nullableString(row, 'proposedSlug'),
      payload: parseJson(row.payload),
      confidenceMicros: numberValue(row, 'confidenceMicros'),
      marginMicros: nullableNumber(row, 'marginMicros'),
      rank: numberValue(row, 'rank'),
      status: candidateStatus(stringValue(row, 'status')),
      decisionReason: nullableString(row, 'decisionReason'),
      createdAt: numberValue(row, 'createdAt'),
      decidedAt: nullableNumber(row, 'decidedAt'),
      evidence: candidateEvidence(parseJson(row.evidence)),
      evidenceTotal: numberValue(row, 'evidenceTotal'),
    })),
    input,
    total,
  )
}

export async function listTaxonomyAttempts(
  input: {
    page: number
    pageSize: number
    jobId: string | null
  },
  db: D1Database,
): Promise<TaxonomyAdminPage<TaxonomyAttemptAdminRecord>> {
  const where = input.jobId ? 'WHERE a.job_id = ?1' : ''
  const values: BindValue[] = input.jobId ? [input.jobId] : []
  const total = await count(
    `SELECT count(*) AS total FROM taxonomy_job_attempts a ${where}`,
    values,
    db,
  )
  const result = await rows(
    `SELECT a.id, a.job_id AS jobId, a.attempt_number AS attemptNumber,
            a.provider_config_id AS providerConfigId, a.status,
            a.provider_request_id AS providerRequestId, a.provider_model AS providerModel,
            a.request_hash AS requestHash, a.response_hash AS responseHash,
            a.input_tokens AS inputTokens, a.output_tokens AS outputTokens,
            a.latency_ms AS latencyMs, a.error_code AS errorCode,
            a.error_summary AS errorSummary, a.started_at AS startedAt,
            a.completed_at AS completedAt
     FROM taxonomy_job_attempts a ${where}
     ORDER BY a.started_at DESC, a.id DESC
     LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
    [...values, input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(
    result.map((row) => ({
      id: stringValue(row, 'id'),
      jobId: stringValue(row, 'jobId'),
      attemptNumber: numberValue(row, 'attemptNumber'),
      providerConfigId: nullableNumber(row, 'providerConfigId'),
      status: stringValue(row, 'status'),
      providerRequestId: nullableString(row, 'providerRequestId'),
      providerModel: nullableString(row, 'providerModel'),
      requestHash: stringValue(row, 'requestHash'),
      responseHash: nullableString(row, 'responseHash'),
      inputTokens: nullableNumber(row, 'inputTokens'),
      outputTokens: nullableNumber(row, 'outputTokens'),
      latencyMs: nullableNumber(row, 'latencyMs'),
      errorCode: nullableString(row, 'errorCode'),
      errorSummary: nullableString(row, 'errorSummary'),
      startedAt: numberValue(row, 'startedAt'),
      completedAt: nullableNumber(row, 'completedAt'),
    })),
    input,
    total,
  )
}

export async function listTaxonomyAuditEvents(
  input: {
    page: number
    pageSize: number
    batchId: string | null
    entityType: string | null
  },
  db: D1Database,
): Promise<TaxonomyAdminPage<TaxonomyAuditAdminRecord>> {
  const clauses: string[] = []
  const values: BindValue[] = []
  if (input.batchId) {
    values.push(input.batchId)
    clauses.push(`e.batch_id = ?${values.length}`)
  }
  if (input.entityType) {
    values.push(input.entityType)
    clauses.push(`e.entity_type = ?${values.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = await count(
    `SELECT count(*) AS total FROM taxonomy_audit_events e ${where}`,
    values,
    db,
  )
  const items = await rows(
    `SELECT e.id, e.batch_id AS batchId, e.job_id AS jobId,
            e.decision_id AS decisionId, e.event_type AS eventType,
            e.entity_type AS entityType, e.entity_id AS entityId,
            e.actor_type AS actorType, e.actor_id AS actorId,
            e.provider_config_id AS providerConfigId, e.provider_model AS providerModel,
            e.policy_config_id AS policyConfigId, e.taxonomy_version_before AS taxonomyVersionBefore,
            e.taxonomy_version_after AS taxonomyVersionAfter, e.scores, e.evidence,
            e.before, e.after, e.release_sha AS releaseSha,
            e.rollback_of_event_id AS rollbackOfEventId,
            e.compensates_event_id AS compensatesEventId, e.created_at AS createdAt
     FROM taxonomy_audit_events e ${where}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
    [...values, input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(
    items.map((row) => ({
      id: stringValue(row, 'id'),
      batchId: nullableString(row, 'batchId'),
      jobId: nullableString(row, 'jobId'),
      decisionId: nullableString(row, 'decisionId'),
      eventType: stringValue(row, 'eventType'),
      entityType: stringValue(row, 'entityType'),
      entityId: stringValue(row, 'entityId'),
      actorType: stringValue(row, 'actorType'),
      actorId: nullableString(row, 'actorId'),
      providerConfigId: nullableNumber(row, 'providerConfigId'),
      providerModel: nullableString(row, 'providerModel'),
      policyConfigId: nullableNumber(row, 'policyConfigId'),
      taxonomyVersionBefore: nullableNumber(row, 'taxonomyVersionBefore'),
      taxonomyVersionAfter: nullableNumber(row, 'taxonomyVersionAfter'),
      scores: parseJson(row.scores),
      before: parseJson(row.before),
      after: parseJson(row.after),
      releaseSha: stringValue(row, 'releaseSha'),
      rollbackOfEventId: nullableString(row, 'rollbackOfEventId'),
      compensatesEventId: nullableString(row, 'compensatesEventId'),
      createdAt: numberValue(row, 'createdAt'),
    })),
    input,
    total,
  )
}

export async function listTaxonomyBatches(
  input: {
    page: number
    pageSize: number
    status: string | null
  },
  db: D1Database,
) {
  const where = input.status ? 'WHERE status = ?1' : ''
  const values: BindValue[] = input.status ? [input.status] : []
  const total = await count(
    `SELECT count(*) AS total FROM taxonomy_change_batches ${where}`,
    values,
    db,
  )
  const items = await rows(
    `SELECT id, kind, status, actor_type AS actorType, actor_id AS actorId,
            expected_taxonomy_version AS expectedTaxonomyVersion,
            resulting_taxonomy_version AS resultingTaxonomyVersion,
            parent_batch_id AS parentBatchId, rollback_of_batch_id AS rollbackOfBatchId,
            summary, created_at AS createdAt, applied_at AS appliedAt,
            completed_at AS completedAt,
            (SELECT count(*) FROM taxonomy_audit_events e WHERE e.batch_id = taxonomy_change_batches.id) AS eventCount
     FROM taxonomy_change_batches ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
    [...values, input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(items, input, total)
}

export async function listTaxonomyLocks(
  input: {
    page: number
    pageSize: number
    state: 'active' | 'released' | 'all'
  },
  db: D1Database,
) {
  const where =
    input.state === 'active'
      ? 'WHERE released_at IS NULL'
      : input.state === 'released'
        ? 'WHERE released_at IS NOT NULL'
        : ''
  const total = await count(
    `SELECT count(*) AS total FROM taxonomy_locks ${where}`,
    [],
    db,
  )
  const items = await rows(
    `SELECT id, scope, resource_key AS resourceKey, site_id AS siteId,
            tag_id AS tagId, related_tag_id AS relatedTagId, alias, reason,
            revision, created_by AS createdBy, created_at AS createdAt,
            released_by AS releasedBy, released_at AS releasedAt,
            release_reason AS releaseReason
     FROM taxonomy_locks ${where}
     ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2`,
    [input.pageSize, input.page * input.pageSize],
    db,
  )
  return pageResult(items, input, total)
}
