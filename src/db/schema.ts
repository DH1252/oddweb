import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const submissionsTable = sqliteTable(
  'submissions',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    url: text().notNull(),
    urlKey: text('url_key').notNull(),
    description: text().notNull(),
    tags: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    thumbnailKey: text('thumbnail_key'),
    thumbnailAlt: text('thumbnail_alt'),
    status: text()
      .$type<'pending' | 'approved' | 'rejected'>()
      .notNull()
      .default('pending'),
    submittedAt: integer('submitted_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('submissions_open_url_unique')
      .on(table.urlKey)
      .where(sql`${table.status} IN ('pending', 'approved')`),
    index('submissions_status_date_idx').on(table.status, table.submittedAt),
    index('submissions_thumbnail_key_idx')
      .on(table.thumbnailKey)
      .where(sql`${table.thumbnailKey} IS NOT NULL`),
    check(
      'submissions_status_check',
      sql`${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      'submissions_tags_json_check',
      sql`json_valid(${table.tags}) AND json_type(${table.tags}) = 'array'`,
    ),
    check(
      'submissions_reviewed_check',
      sql`(${table.status} = 'pending' AND ${table.reviewedAt} IS NULL) OR (${table.status} <> 'pending' AND ${table.reviewedAt} IS NOT NULL)`,
    ),
  ],
)

export const sitesTable = sqliteTable(
  'sites',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    slug: text().notNull(),
    name: text().notNull(),
    url: text().notNull(),
    urlKey: text('url_key').notNull(),
    description: text().notNull(),
    summary: text().notNull().default(''),
    categories: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    poster: text().notNull().default('NEW FIND'),
    notes: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
    facts: text({ mode: 'json' })
      .$type<Array<{ label: string; value: string }>>()
      .notNull()
      .default([]),
    accent: text().notNull().default('from-[#63396d] to-[#d27a3e]'),
    thumbnailKey: text('thumbnail_key'),
    thumbnailAlt: text('thumbnail_alt'),
    visits: integer().notNull().default(0),
    status: text().$type<'active' | 'archived'>().notNull().default('active'),
    source: text()
      .$type<'Directory' | 'Submission' | 'Manual'>()
      .notNull()
      .default('Manual'),
    submissionId: integer('submission_id').references(
      () => submissionsTable.id,
      { onDelete: 'set null' },
    ),
    addedAt: integer('added_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    contentVersion: integer('content_version').notNull().default(1),
    classificationInputHash: text('classification_input_hash'),
  },
  (table) => [
    uniqueIndex('sites_slug_unique').on(table.slug),
    uniqueIndex('sites_url_unique').on(table.url),
    uniqueIndex('sites_url_key_unique').on(table.urlKey),
    uniqueIndex('sites_submission_unique').on(table.submissionId),
    index('sites_status_added_idx').on(table.status, table.addedAt),
    index('sites_status_visits_idx').on(table.status, table.visits),
    index('sites_thumbnail_key_idx')
      .on(table.thumbnailKey)
      .where(sql`${table.thumbnailKey} IS NOT NULL`),
    check('sites_status_check', sql`${table.status} IN ('active', 'archived')`),
    check(
      'sites_source_check',
      sql`${table.source} IN ('Directory', 'Submission', 'Manual')`,
    ),
    check(
      'sites_submission_source_check',
      sql`(${table.source} = 'Submission') = (${table.submissionId} IS NOT NULL)`,
    ),
    check('sites_visits_nonnegative_check', sql`${table.visits} >= 0`),
    check('sites_content_version_check', sql`${table.contentVersion} >= 1`),
    check(
      'sites_classification_hash_check',
      sql`${table.classificationInputHash} IS NULL OR length(${table.classificationInputHash}) = 64`,
    ),
    index('sites_classification_input_idx').on(
      table.classificationInputHash,
      table.contentVersion,
    ),
    check(
      'sites_categories_json_check',
      sql`json_valid(${table.categories}) AND json_type(${table.categories}) = 'array'`,
    ),
    check(
      'sites_notes_json_check',
      sql`json_valid(${table.notes}) AND json_type(${table.notes}) = 'array'`,
    ),
    check(
      'sites_facts_json_check',
      sql`json_valid(${table.facts}) AND json_type(${table.facts}) = 'array'`,
    ),
  ],
)

export const tagsTable = sqliteTable(
  'tags',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    slug: text().notNull(),
    name: text().notNull(),
    canonical: integer({ mode: 'boolean' }).notNull().default(false),
    status: text()
      .$type<'active' | 'deprecated' | 'merged'>()
      .notNull()
      .default('active'),
    revision: integer().notNull().default(1),
    automationLocked: integer('automation_locked', { mode: 'boolean' })
      .notNull()
      .default(false),
    mergedIntoTagId: integer('merged_into_tag_id').references(
      (): AnySQLiteColumn => tagsTable.id,
      { onDelete: 'restrict' },
    ),
    deprecatedAt: integer('deprecated_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('tags_slug_unique').on(table.slug),
    index('tags_status_canonical_idx').on(table.status, table.canonical),
    index('tags_merged_into_idx')
      .on(table.mergedIntoTagId)
      .where(sql`${table.mergedIntoTagId} IS NOT NULL`),
    check('tags_slug_nonempty_check', sql`length(trim(${table.slug})) > 0`),
    check('tags_name_nonempty_check', sql`length(trim(${table.name})) > 0`),
    check('tags_canonical_check', sql`${table.canonical} IN (0, 1)`),
    check(
      'tags_automation_locked_check',
      sql`${table.automationLocked} IN (0, 1)`,
    ),
    check(
      'tags_status_check',
      sql`${table.status} IN ('active', 'deprecated', 'merged')`,
    ),
    check('tags_revision_check', sql`${table.revision} >= 1`),
    check(
      'tags_lifecycle_check',
      sql`(${table.status} = 'active' AND ${table.deprecatedAt} IS NULL AND ${table.mergedIntoTagId} IS NULL) OR (${table.status} = 'deprecated' AND ${table.deprecatedAt} IS NOT NULL AND ${table.mergedIntoTagId} IS NULL) OR (${table.status} = 'merged' AND ${table.deprecatedAt} IS NOT NULL AND ${table.mergedIntoTagId} IS NOT NULL AND ${table.mergedIntoTagId} <> ${table.id})`,
    ),
  ],
)

export const tagAliasesTable = sqliteTable(
  'tag_aliases',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    alias: text().notNull(),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('tag_aliases_alias_unique').on(table.alias)],
)

export const tagParentsTable = sqliteTable(
  'tag_parents',
  {
    parentTagId: integer('parent_tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
    childTagId: integer('child_tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.parentTagId, table.childTagId] })],
)

export const siteTagsTable = sqliteTable(
  'site_tags',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sitesTable.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
    rawName: text('raw_name').notNull(),
    source: text()
      .$type<'deterministic' | 'automation' | 'admin' | 'migration'>()
      .notNull()
      .default('deterministic'),
    decisionId: text('decision_id').references(
      (): AnySQLiteColumn => tagAssignmentDecisionsTable.id,
      { onDelete: 'set null' },
    ),
    revision: integer().notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('site_tags_site_tag_unique').on(table.siteId, table.tagId),
    index('site_tags_tag_idx').on(table.tagId),
    index('site_tags_effective_idx').on(table.siteId, table.updatedAt),
    index('site_tags_decision_idx')
      .on(table.decisionId)
      .where(sql`${table.decisionId} IS NOT NULL`),
    check('site_tags_raw_name_check', sql`length(trim(${table.rawName})) > 0`),
    check(
      'site_tags_source_check',
      sql`${table.source} IN ('deterministic', 'automation', 'admin', 'migration')`,
    ),
    check('site_tags_revision_check', sql`${table.revision} >= 1`),
  ],
)

export const taxonomyProviderConfigsTable = sqliteTable(
  'taxonomy_provider_configs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    revision: integer().notNull(),
    providerKind: text('provider_kind')
      .$type<'openai_compatible' | 'gemini'>()
      .notNull(),
    endpoint: text().notNull(),
    model: text().notNull(),
    dialect: text().$type<'responses' | 'chat_completions'>(),
    routingGroup: text('routing_group').notNull().default('default'),
    routingRole: text('routing_role')
      .$type<'primary' | 'failover' | 'consensus'>()
      .notNull()
      .default('primary'),
    routingPriority: integer('routing_priority').notNull().default(0),
    timeoutMs: integer('timeout_ms').notNull().default(30_000),
    keyVersion: integer('key_version').notNull(),
    credentialNonce: text('credential_nonce').notNull(),
    credentialCiphertext: text('credential_ciphertext').notNull(),
    credentialFingerprint: text('credential_fingerprint').notNull(),
    enabled: integer({ mode: 'boolean' }).notNull().default(false),
    supersedesId: integer('supersedes_id').references(
      (): AnySQLiteColumn => taxonomyProviderConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('taxonomy_provider_configs_name_revision_unique').on(
      table.name,
      table.revision,
    ),
    index('taxonomy_provider_configs_routing_idx').on(
      table.enabled,
      table.routingGroup,
      table.routingPriority,
    ),
    check(
      'taxonomy_provider_configs_name_check',
      sql`length(trim(${table.name})) > 0 AND length(trim(${table.routingGroup})) > 0`,
    ),
    check(
      'taxonomy_provider_configs_revision_check',
      sql`${table.revision} >= 1`,
    ),
    check(
      'taxonomy_provider_configs_kind_check',
      sql`${table.providerKind} IN ('openai_compatible', 'gemini')`,
    ),
    check(
      'taxonomy_provider_configs_endpoint_check',
      sql`lower(${table.endpoint}) LIKE 'https://%' AND instr(substr(${table.endpoint}, 9), '@') = 0`,
    ),
    check(
      'taxonomy_provider_configs_dialect_check',
      sql`(${table.providerKind} = 'openai_compatible' AND ${table.dialect} IN ('responses', 'chat_completions')) OR (${table.providerKind} = 'gemini' AND ${table.dialect} IS NULL)`,
    ),
    check(
      'taxonomy_provider_configs_routing_role_check',
      sql`${table.routingRole} IN ('primary', 'failover', 'consensus')`,
    ),
    check(
      'taxonomy_provider_configs_priority_check',
      sql`${table.routingPriority} >= 0`,
    ),
    check(
      'taxonomy_provider_configs_timeout_check',
      sql`${table.timeoutMs} BETWEEN 1000 AND 120000`,
    ),
    check(
      'taxonomy_provider_configs_encryption_check',
      sql`${table.keyVersion} >= 1 AND length(${table.credentialNonce}) >= 16 AND length(${table.credentialCiphertext}) >= 16 AND length(${table.credentialFingerprint}) >= 8`,
    ),
    check(
      'taxonomy_provider_configs_enabled_check',
      sql`${table.enabled} IN (0, 1)`,
    ),
    check(
      'taxonomy_provider_configs_supersedes_check',
      sql`${table.supersedesId} IS NULL OR ${table.supersedesId} <> ${table.id}`,
    ),
  ],
)

export const taxonomyPolicyConfigsTable = sqliteTable(
  'taxonomy_policy_configs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    revision: integer().notNull(),
    assignmentLimit: integer('assignment_limit').notNull(),
    novelEvidenceSiteThreshold: integer(
      'novel_evidence_site_threshold',
    ).notNull(),
    assignmentConfidenceMicros: integer(
      'assignment_confidence_micros',
    ).notNull(),
    ontologyConfidenceMicros: integer('ontology_confidence_micros').notNull(),
    minimumMarginMicros: integer('minimum_margin_micros').notNull(),
    hierarchyMaxDepth: integer('hierarchy_max_depth').notNull(),
    hierarchyMaxFanout: integer('hierarchy_max_fanout').notNull(),
    ontologyProviderAgreement: integer('ontology_provider_agreement').notNull(),
    retryBudget: integer('retry_budget').notNull(),
    retryBaseSeconds: integer('retry_base_seconds').notNull(),
    retryMaxSeconds: integer('retry_max_seconds').notNull(),
    rolloutBasisPoints: integer('rollout_basis_points').notNull(),
    dailyRequestBudget: integer('daily_request_budget').notNull(),
    dailyTokenBudget: integer('daily_token_budget').notNull(),
    schemaFailureTripBasisPoints: integer(
      'schema_failure_trip_basis_points',
    ).notNull(),
    disagreementTripBasisPoints: integer(
      'disagreement_trip_basis_points',
    ).notNull(),
    rollbackTripBasisPoints: integer('rollback_trip_basis_points').notNull(),
    mutationVolumeTripCount: integer('mutation_volume_trip_count').notNull(),
    rawResponseRetentionSeconds: integer(
      'raw_response_retention_seconds',
    ).notNull(),
    shadowMinimumSamples: integer('shadow_minimum_samples').notNull(),
    shadowMinimumCoverageBasisPoints: integer(
      'shadow_minimum_coverage_basis_points',
    ).notNull(),
    shadowSchemaSuccessBasisPoints: integer(
      'shadow_schema_success_basis_points',
    ).notNull(),
    shadowProviderAgreementBasisPoints: integer(
      'shadow_provider_agreement_basis_points',
    ).notNull(),
    promptHash: text('prompt_hash').notNull(),
    schemaHash: text('schema_hash').notNull(),
    supersedesId: integer('supersedes_id').references(
      (): AnySQLiteColumn => taxonomyPolicyConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('taxonomy_policy_configs_revision_unique').on(table.revision),
    check(
      'taxonomy_policy_configs_positive_limits_check',
      sql`${table.revision} >= 1 AND ${table.assignmentLimit} BETWEEN 1 AND 100 AND ${table.novelEvidenceSiteThreshold} >= 1 AND ${table.hierarchyMaxDepth} BETWEEN 1 AND 32 AND ${table.hierarchyMaxFanout} BETWEEN 1 AND 1000 AND ${table.ontologyProviderAgreement} >= 1 AND ${table.retryBudget} BETWEEN 0 AND 100`,
    ),
    check(
      'taxonomy_policy_configs_confidence_check',
      sql`${table.assignmentConfidenceMicros} BETWEEN 0 AND 1000000 AND ${table.ontologyConfidenceMicros} BETWEEN 0 AND 1000000 AND ${table.minimumMarginMicros} BETWEEN 0 AND 1000000`,
    ),
    check(
      'taxonomy_policy_configs_retry_check',
      sql`${table.retryBaseSeconds} >= 1 AND ${table.retryMaxSeconds} >= ${table.retryBaseSeconds}`,
    ),
    check(
      'taxonomy_policy_configs_budgets_check',
      sql`${table.dailyRequestBudget} >= 0 AND ${table.dailyTokenBudget} >= 0 AND ${table.mutationVolumeTripCount} >= 0 AND ${table.rawResponseRetentionSeconds} >= 0 AND ${table.shadowMinimumSamples} >= 0`,
    ),
    check(
      'taxonomy_policy_configs_basis_points_check',
      sql`${table.rolloutBasisPoints} BETWEEN 0 AND 10000 AND ${table.schemaFailureTripBasisPoints} BETWEEN 0 AND 10000 AND ${table.disagreementTripBasisPoints} BETWEEN 0 AND 10000 AND ${table.rollbackTripBasisPoints} BETWEEN 0 AND 10000 AND ${table.shadowMinimumCoverageBasisPoints} BETWEEN 0 AND 10000 AND ${table.shadowSchemaSuccessBasisPoints} BETWEEN 0 AND 10000 AND ${table.shadowProviderAgreementBasisPoints} BETWEEN 0 AND 10000`,
    ),
    check(
      'taxonomy_policy_configs_hashes_check',
      sql`length(${table.promptHash}) = 64 AND length(${table.schemaHash}) = 64`,
    ),
    check(
      'taxonomy_policy_configs_supersedes_check',
      sql`${table.supersedesId} IS NULL OR ${table.supersedesId} <> ${table.id}`,
    ),
  ],
)

export const taxonomyStateTable = sqliteTable(
  'taxonomy_state',
  {
    id: integer().primaryKey(),
    publishedVersion: integer('published_version').notNull().default(1),
    activeProviderConfigId: integer('active_provider_config_id').references(
      () => taxonomyProviderConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    activePolicyConfigId: integer('active_policy_config_id').references(
      () => taxonomyPolicyConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    mode: text()
      .$type<'disabled' | 'shadow' | 'gradual' | 'autonomous' | 'degraded'>()
      .notNull()
      .default('disabled'),
    siteClassificationEnabled: integer('site_classification_enabled', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    circuitState: text('circuit_state')
      .$type<'closed' | 'open' | 'half_open'>()
      .notNull()
      .default('closed'),
    circuitReason: text('circuit_reason'),
    circuitOpenedAt: integer('circuit_opened_at', { mode: 'timestamp' }),
    modeChangedAt: integer('mode_changed_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check('taxonomy_state_singleton_check', sql`${table.id} = 1`),
    check('taxonomy_state_version_check', sql`${table.publishedVersion} >= 1`),
    check(
      'taxonomy_state_mode_check',
      sql`${table.mode} IN ('disabled', 'shadow', 'gradual', 'autonomous', 'degraded')`,
    ),
    check(
      'taxonomy_state_circuit_check',
      sql`${table.circuitState} IN ('closed', 'open', 'half_open') AND ((${table.circuitState} = 'closed' AND ${table.circuitOpenedAt} IS NULL) OR (${table.circuitState} <> 'closed' AND ${table.circuitOpenedAt} IS NOT NULL))`,
    ),
  ],
)

export const taxonomyChangeBatchesTable = sqliteTable(
  'taxonomy_change_batches',
  {
    id: text().primaryKey(),
    kind: text()
      .$type<'migration' | 'classification' | 'ontology' | 'rollback'>()
      .notNull(),
    status: text()
      .$type<
        | 'planned'
        | 'applying'
        | 'applied'
        | 'failed'
        | 'rolling_back'
        | 'rolled_back'
        | 'partial'
      >()
      .notNull(),
    actorType: text('actor_type')
      .$type<'system' | 'admin' | 'migration'>()
      .notNull(),
    actorId: text('actor_id'),
    expectedTaxonomyVersion: integer('expected_taxonomy_version').notNull(),
    resultingTaxonomyVersion: integer('resulting_taxonomy_version'),
    parentBatchId: text('parent_batch_id').references(
      (): AnySQLiteColumn => taxonomyChangeBatchesTable.id,
      { onDelete: 'restrict' },
    ),
    rollbackOfBatchId: text('rollback_of_batch_id').references(
      (): AnySQLiteColumn => taxonomyChangeBatchesTable.id,
      { onDelete: 'restrict' },
    ),
    summary: text().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    appliedAt: integer('applied_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('taxonomy_change_batches_status_idx').on(
      table.status,
      table.createdAt,
    ),
    index('taxonomy_change_batches_rollback_idx').on(table.rollbackOfBatchId),
    check(
      'taxonomy_change_batches_id_check',
      sql`length(trim(${table.id})) > 0`,
    ),
    check(
      'taxonomy_change_batches_kind_check',
      sql`${table.kind} IN ('migration', 'classification', 'ontology', 'rollback')`,
    ),
    check(
      'taxonomy_change_batches_status_check',
      sql`${table.status} IN ('planned', 'applying', 'applied', 'failed', 'rolling_back', 'rolled_back', 'partial')`,
    ),
    check(
      'taxonomy_change_batches_actor_check',
      sql`${table.actorType} IN ('system', 'admin', 'migration')`,
    ),
    check(
      'taxonomy_change_batches_versions_check',
      sql`${table.expectedTaxonomyVersion} >= 1 AND (${table.resultingTaxonomyVersion} IS NULL OR ${table.resultingTaxonomyVersion} >= ${table.expectedTaxonomyVersion})`,
    ),
    check(
      'taxonomy_change_batches_links_check',
      sql`(${table.parentBatchId} IS NULL OR ${table.parentBatchId} <> ${table.id}) AND (${table.rollbackOfBatchId} IS NULL OR ${table.rollbackOfBatchId} <> ${table.id})`,
    ),
  ],
)

export const taxonomyJobsTable = sqliteTable(
  'taxonomy_jobs',
  {
    id: text().primaryKey(),
    jobKey: text('job_key').notNull(),
    kind: text()
      .$type<
        'classify_site' | 'reassess_concept' | 'apply_ontology' | 'rollback'
      >()
      .notNull(),
    siteId: integer('site_id').references(() => sitesTable.id, {
      onDelete: 'cascade',
    }),
    conceptKey: text('concept_key'),
    inputHash: text('input_hash').notNull(),
    siteContentVersion: integer('site_content_version'),
    taxonomyVersion: integer('taxonomy_version').notNull(),
    providerConfigId: integer('provider_config_id').references(
      () => taxonomyProviderConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    policyConfigId: integer('policy_config_id').references(
      () => taxonomyPolicyConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    batchId: text('batch_id').references(() => taxonomyChangeBatchesTable.id, {
      onDelete: 'set null',
    }),
    status: text()
      .$type<
        | 'pending'
        | 'leased'
        | 'retry_wait'
        | 'succeeded'
        | 'settled'
        | 'obsolete'
        | 'dead'
        | 'cancelled'
        | 'degraded'
      >()
      .notNull()
      .default('pending'),
    priority: integer().notNull().default(0),
    availableAt: integer('available_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leasedUntil: integer('leased_until', { mode: 'timestamp' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lastErrorCode: text('last_error_code'),
    lastErrorSummary: text('last_error_summary'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('taxonomy_jobs_job_key_unique').on(table.jobKey),
    index('taxonomy_jobs_pending_idx').on(
      table.status,
      table.availableAt,
      table.priority,
      table.id,
    ),
    index('taxonomy_jobs_lease_idx')
      .on(table.leasedUntil)
      .where(sql`${table.status} = 'leased'`),
    index('taxonomy_jobs_retry_idx')
      .on(table.availableAt)
      .where(sql`${table.status} = 'retry_wait'`),
    index('taxonomy_jobs_site_config_hash_idx').on(
      table.siteId,
      table.inputHash,
      table.taxonomyVersion,
      table.policyConfigId,
      table.providerConfigId,
    ),
    check('taxonomy_jobs_id_check', sql`length(trim(${table.id})) > 0`),
    check(
      'taxonomy_jobs_kind_check',
      sql`${table.kind} IN ('classify_site', 'reassess_concept', 'apply_ontology', 'rollback')`,
    ),
    check(
      'taxonomy_jobs_target_check',
      sql`(${table.kind} = 'classify_site' AND ${table.siteId} IS NOT NULL AND ${table.siteContentVersion} >= 1) OR (${table.kind} = 'reassess_concept' AND ${table.conceptKey} IS NOT NULL) OR (${table.kind} IN ('apply_ontology', 'rollback'))`,
    ),
    check('taxonomy_jobs_hash_check', sql`length(${table.inputHash}) = 64`),
    check(
      'taxonomy_jobs_status_check',
      sql`${table.status} IN ('pending', 'leased', 'retry_wait', 'succeeded', 'settled', 'obsolete', 'dead', 'cancelled', 'degraded')`,
    ),
    check(
      'taxonomy_jobs_attempts_check',
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} >= 1 AND ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check(
      'taxonomy_jobs_lease_check',
      sql`(${table.status} = 'leased' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leasedUntil} IS NOT NULL) OR (${table.status} <> 'leased' AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leasedUntil} IS NULL)`,
    ),
    check(
      'taxonomy_jobs_terminal_check',
      sql`(${table.status} IN ('succeeded', 'settled', 'obsolete', 'dead', 'cancelled', 'degraded')) = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
)

export const taxonomyJobAttemptsTable = sqliteTable(
  'taxonomy_job_attempts',
  {
    id: text().primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => taxonomyJobsTable.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    providerConfigId: integer('provider_config_id')
      .notNull()
      .references(() => taxonomyProviderConfigsTable.id, {
        onDelete: 'restrict',
      }),
    status: text()
      .$type<
        | 'started'
        | 'succeeded'
        | 'retryable_failure'
        | 'permanent_failure'
        | 'invalid_response'
        | 'cancelled'
      >()
      .notNull(),
    providerRequestId: text('provider_request_id'),
    providerModel: text('provider_model').notNull(),
    requestHash: text('request_hash').notNull(),
    responseHash: text('response_hash'),
    rawResponse: text('raw_response'),
    rawResponseExpiresAt: integer('raw_response_expires_at', {
      mode: 'timestamp',
    }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
    startedAt: integer('started_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('taxonomy_job_attempts_job_number_unique').on(
      table.jobId,
      table.attemptNumber,
    ),
    index('taxonomy_job_attempts_provider_idx').on(
      table.providerConfigId,
      table.startedAt,
    ),
    index('taxonomy_job_attempts_raw_expiry_idx')
      .on(table.rawResponseExpiresAt)
      .where(sql`${table.rawResponse} IS NOT NULL`),
    check(
      'taxonomy_job_attempts_number_check',
      sql`${table.attemptNumber} >= 1`,
    ),
    check(
      'taxonomy_job_attempts_status_check',
      sql`${table.status} IN ('started', 'succeeded', 'retryable_failure', 'permanent_failure', 'invalid_response', 'cancelled')`,
    ),
    check(
      'taxonomy_job_attempts_hash_check',
      sql`length(${table.requestHash}) = 64 AND (${table.responseHash} IS NULL OR length(${table.responseHash}) = 64)`,
    ),
    check(
      'taxonomy_job_attempts_usage_check',
      sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0) AND (${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0)`,
    ),
    check(
      'taxonomy_job_attempts_completion_check',
      sql`(${table.status} = 'started') = (${table.completedAt} IS NULL)`,
    ),
    check(
      'taxonomy_job_attempts_raw_retention_check',
      sql`(${table.rawResponse} IS NULL AND ${table.rawResponseExpiresAt} IS NULL) OR (${table.rawResponse} IS NOT NULL AND ${table.rawResponseExpiresAt} IS NOT NULL)`,
    ),
  ],
)

export const taxonomyOutboxTable = sqliteTable(
  'taxonomy_outbox',
  {
    id: text().primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => taxonomyJobsTable.id, { onDelete: 'cascade' }),
    topic: text().notNull().default('taxonomy_jobs'),
    payload: text({ mode: 'json' }).$type<{ jobId: string }>().notNull(),
    availableAt: integer('available_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    leaseToken: text('lease_token'),
    leasedUntil: integer('leased_until', { mode: 'timestamp' }),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    dispatchedAt: integer('dispatched_at', { mode: 'timestamp' }),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('taxonomy_outbox_job_unique').on(table.jobId),
    index('taxonomy_outbox_undispatched_idx')
      .on(table.availableAt, table.id)
      .where(sql`${table.dispatchedAt} IS NULL`),
    index('taxonomy_outbox_lease_idx')
      .on(table.leasedUntil)
      .where(
        sql`${table.dispatchedAt} IS NULL AND ${table.leasedUntil} IS NOT NULL`,
      ),
    check(
      'taxonomy_outbox_payload_check',
      sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object' AND json_type(${table.payload}, '$.jobId') = 'text'`,
    ),
    check(
      'taxonomy_outbox_attempts_check',
      sql`${table.dispatchAttempts} >= 0`,
    ),
    check(
      'taxonomy_outbox_lease_check',
      sql`(${table.leaseToken} IS NULL) = (${table.leasedUntil} IS NULL)`,
    ),
  ],
)

export const taxonomyCandidatesTable = sqliteTable(
  'taxonomy_candidates',
  {
    id: text().primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => taxonomyJobsTable.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id').references(
      () => taxonomyJobAttemptsTable.id,
      {
        onDelete: 'set null',
      },
    ),
    candidateKey: text('candidate_key').notNull(),
    kind: text()
      .$type<
        'existing_tag' | 'novel_concept' | 'alias' | 'merge' | 'parent_edge'
      >()
      .notNull(),
    tagId: integer('tag_id').references(() => tagsTable.id, {
      onDelete: 'restrict',
    }),
    relatedTagId: integer('related_tag_id').references(() => tagsTable.id, {
      onDelete: 'restrict',
    }),
    normalizedConcept: text('normalized_concept'),
    proposedName: text('proposed_name'),
    proposedSlug: text('proposed_slug'),
    payload: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    confidenceMicros: integer('confidence_micros').notNull(),
    marginMicros: integer('margin_micros'),
    rank: integer().notNull(),
    status: text()
      .$type<'proposed' | 'accepted' | 'rejected' | 'deferred' | 'conflict'>()
      .notNull()
      .default('proposed'),
    decisionReason: text('decision_reason'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    decidedAt: integer('decided_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('taxonomy_candidates_job_key_unique').on(
      table.jobId,
      table.candidateKey,
    ),
    index('taxonomy_candidates_concept_idx').on(
      table.normalizedConcept,
      table.status,
    ),
    index('taxonomy_candidates_tag_idx').on(table.tagId, table.status),
    check(
      'taxonomy_candidates_kind_check',
      sql`${table.kind} IN ('existing_tag', 'novel_concept', 'alias', 'merge', 'parent_edge')`,
    ),
    check(
      'taxonomy_candidates_target_check',
      sql`(${table.kind} = 'existing_tag' AND ${table.tagId} IS NOT NULL) OR (${table.kind} = 'novel_concept' AND ${table.normalizedConcept} IS NOT NULL AND ${table.proposedName} IS NOT NULL AND ${table.proposedSlug} IS NOT NULL) OR (${table.kind} = 'alias' AND ${table.tagId} IS NOT NULL AND ${table.normalizedConcept} IS NOT NULL) OR (${table.kind} IN ('merge', 'parent_edge') AND ${table.tagId} IS NOT NULL AND ${table.relatedTagId} IS NOT NULL AND ${table.tagId} <> ${table.relatedTagId})`,
    ),
    check(
      'taxonomy_candidates_payload_check',
      sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`,
    ),
    check(
      'taxonomy_candidates_score_check',
      sql`${table.confidenceMicros} BETWEEN 0 AND 1000000 AND (${table.marginMicros} IS NULL OR ${table.marginMicros} BETWEEN 0 AND 1000000) AND ${table.rank} >= 0`,
    ),
    check(
      'taxonomy_candidates_status_check',
      sql`${table.status} IN ('proposed', 'accepted', 'rejected', 'deferred', 'conflict') AND ((${table.status} = 'proposed' AND ${table.decidedAt} IS NULL) OR (${table.status} <> 'proposed' AND ${table.decidedAt} IS NOT NULL))`,
    ),
  ],
)

export const taxonomyConceptEvidenceTable = sqliteTable(
  'taxonomy_concept_evidence',
  {
    id: text().primaryKey(),
    normalizedConcept: text('normalized_concept').notNull(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sitesTable.id, { onDelete: 'cascade' }),
    inputHash: text('input_hash').notNull(),
    sourceKey: text('source_key').notNull(),
    source: text()
      .$type<'submitted_hint' | 'deterministic' | 'provider'>()
      .notNull(),
    providerConfigId: integer('provider_config_id').references(
      () => taxonomyProviderConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    policyConfigId: integer('policy_config_id').references(
      () => taxonomyPolicyConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    jobId: text('job_id').references(() => taxonomyJobsTable.id, {
      onDelete: 'set null',
    }),
    attemptId: text('attempt_id').references(
      () => taxonomyJobAttemptsTable.id,
      {
        onDelete: 'set null',
      },
    ),
    evidenceHash: text('evidence_hash').notNull(),
    evidenceSnippet: text('evidence_snippet').notNull(),
    confidenceMicros: integer('confidence_micros').notNull(),
    accepted: integer({ mode: 'boolean' }).notNull().default(false),
    observedAt: integer('observed_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('taxonomy_concept_evidence_distinct_unique').on(
      table.normalizedConcept,
      table.siteId,
      table.inputHash,
      table.sourceKey,
    ),
    index('taxonomy_concept_evidence_lookup_idx').on(
      table.normalizedConcept,
      table.accepted,
      table.observedAt,
      table.siteId,
    ),
    index('taxonomy_concept_evidence_config_idx').on(
      table.providerConfigId,
      table.policyConfigId,
    ),
    check(
      'taxonomy_concept_evidence_concept_check',
      sql`length(trim(${table.normalizedConcept})) > 0`,
    ),
    check(
      'taxonomy_concept_evidence_source_check',
      sql`${table.source} IN ('submitted_hint', 'deterministic', 'provider') AND ((${table.source} = 'provider' AND ${table.providerConfigId} IS NOT NULL) OR (${table.source} <> 'provider' AND ${table.providerConfigId} IS NULL))`,
    ),
    check(
      'taxonomy_concept_evidence_hash_check',
      sql`length(${table.inputHash}) = 64 AND length(${table.evidenceHash}) = 64`,
    ),
    check(
      'taxonomy_concept_evidence_score_check',
      sql`${table.confidenceMicros} BETWEEN 0 AND 1000000 AND ${table.accepted} IN (0, 1)`,
    ),
  ],
)

export const tagAssignmentDecisionsTable = sqliteTable(
  'tag_assignment_decisions',
  {
    id: text().primaryKey(),
    siteId: integer('site_id')
      .notNull()
      .references(() => sitesTable.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id').references(() => tagsTable.id, {
      onDelete: 'restrict',
    }),
    replacementTagId: integer('replacement_tag_id').references(
      () => tagsTable.id,
      { onDelete: 'restrict' },
    ),
    jobId: text('job_id').references(() => taxonomyJobsTable.id, {
      onDelete: 'set null',
    }),
    candidateId: text('candidate_id').references(
      () => taxonomyCandidatesTable.id,
      {
        onDelete: 'set null',
      },
    ),
    action: text().$type<'add' | 'remove' | 'retain' | 'replace'>().notNull(),
    outcome: text()
      .$type<
        | 'applied'
        | 'rejected'
        | 'shadow'
        | 'locked'
        | 'obsolete'
        | 'conservative'
      >()
      .notNull(),
    source: text()
      .$type<'deterministic' | 'provider' | 'admin' | 'migration'>()
      .notNull(),
    confidenceMicros: integer('confidence_micros'),
    wasAssigned: integer('was_assigned', { mode: 'boolean' }).notNull(),
    isAssigned: integer('is_assigned', { mode: 'boolean' }).notNull(),
    reason: text().notNull(),
    inputHash: text('input_hash').notNull(),
    taxonomyVersion: integer('taxonomy_version').notNull(),
    siteContentVersion: integer('site_content_version').notNull(),
    providerConfigId: integer('provider_config_id').references(
      () => taxonomyProviderConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    policyConfigId: integer('policy_config_id').references(
      () => taxonomyPolicyConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    supersedesDecisionId: text('supersedes_decision_id').references(
      (): AnySQLiteColumn => tagAssignmentDecisionsTable.id,
      { onDelete: 'restrict' },
    ),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('tag_assignment_decisions_site_idx').on(
      table.siteId,
      table.createdAt,
    ),
    index('tag_assignment_decisions_effective_idx').on(
      table.siteId,
      table.tagId,
      table.outcome,
      table.createdAt,
    ),
    index('tag_assignment_decisions_job_idx').on(table.jobId),
    check(
      'tag_assignment_decisions_action_check',
      sql`${table.action} IN ('add', 'remove', 'retain', 'replace') AND ((${table.action} = 'replace' AND ${table.tagId} IS NOT NULL AND ${table.replacementTagId} IS NOT NULL AND ${table.tagId} <> ${table.replacementTagId}) OR (${table.action} <> 'replace' AND ${table.tagId} IS NOT NULL AND ${table.replacementTagId} IS NULL))`,
    ),
    check(
      'tag_assignment_decisions_outcome_check',
      sql`${table.outcome} IN ('applied', 'rejected', 'shadow', 'locked', 'obsolete', 'conservative')`,
    ),
    check(
      'tag_assignment_decisions_source_check',
      sql`${table.source} IN ('deterministic', 'provider', 'admin', 'migration')`,
    ),
    check(
      'tag_assignment_decisions_score_check',
      sql`${table.confidenceMicros} IS NULL OR ${table.confidenceMicros} BETWEEN 0 AND 1000000`,
    ),
    check(
      'tag_assignment_decisions_assignment_check',
      sql`${table.wasAssigned} IN (0, 1) AND ${table.isAssigned} IN (0, 1)`,
    ),
    check(
      'tag_assignment_decisions_hash_version_check',
      sql`length(${table.inputHash}) = 64 AND ${table.taxonomyVersion} >= 1 AND ${table.siteContentVersion} >= 1`,
    ),
    check(
      'tag_assignment_decisions_supersedes_check',
      sql`${table.supersedesDecisionId} IS NULL OR ${table.supersedesDecisionId} <> ${table.id}`,
    ),
  ],
)

export const taxonomyAuditEventsTable = sqliteTable(
  'taxonomy_audit_events',
  {
    id: text().primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => taxonomyChangeBatchesTable.id, {
        onDelete: 'restrict',
      }),
    jobId: text('job_id').references(() => taxonomyJobsTable.id, {
      onDelete: 'set null',
    }),
    decisionId: text('decision_id').references(
      () => tagAssignmentDecisionsTable.id,
      {
        onDelete: 'set null',
      },
    ),
    eventType: text('event_type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    actorType: text('actor_type')
      .$type<'system' | 'provider' | 'admin' | 'migration'>()
      .notNull(),
    actorId: text('actor_id'),
    providerConfigId: integer('provider_config_id').references(
      () => taxonomyProviderConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    providerModel: text('provider_model'),
    policyConfigId: integer('policy_config_id').references(
      () => taxonomyPolicyConfigsTable.id,
      { onDelete: 'restrict' },
    ),
    promptHash: text('prompt_hash'),
    schemaHash: text('schema_hash'),
    inputHash: text('input_hash'),
    taxonomyVersionBefore: integer('taxonomy_version_before').notNull(),
    taxonomyVersionAfter: integer('taxonomy_version_after').notNull(),
    scores: text({ mode: 'json' })
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    evidence: text().notNull().default(''),
    before: text({ mode: 'json' }).$type<unknown>().notNull(),
    after: text({ mode: 'json' }).$type<unknown>().notNull(),
    releaseSha: text('release_sha').notNull(),
    rollbackOfEventId: text('rollback_of_event_id').references(
      (): AnySQLiteColumn => taxonomyAuditEventsTable.id,
      { onDelete: 'restrict' },
    ),
    compensatesEventId: text('compensates_event_id').references(
      (): AnySQLiteColumn => taxonomyAuditEventsTable.id,
      { onDelete: 'restrict' },
    ),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('taxonomy_audit_events_batch_idx').on(table.batchId, table.createdAt),
    index('taxonomy_audit_events_entity_idx').on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index('taxonomy_audit_events_job_idx').on(table.jobId, table.createdAt),
    index('taxonomy_audit_events_rollback_idx').on(table.rollbackOfEventId),
    check(
      'taxonomy_audit_events_actor_check',
      sql`${table.actorType} IN ('system', 'provider', 'admin', 'migration')`,
    ),
    check(
      'taxonomy_audit_events_versions_check',
      sql`${table.taxonomyVersionBefore} >= 1 AND ${table.taxonomyVersionAfter} >= 1`,
    ),
    check(
      'taxonomy_audit_events_hashes_check',
      sql`(${table.promptHash} IS NULL OR length(${table.promptHash}) = 64) AND (${table.schemaHash} IS NULL OR length(${table.schemaHash}) = 64) AND (${table.inputHash} IS NULL OR length(${table.inputHash}) = 64)`,
    ),
    check(
      'taxonomy_audit_events_json_check',
      sql`json_valid(${table.scores}) AND json_type(${table.scores}) = 'object' AND json_valid(${table.before}) AND json_valid(${table.after})`,
    ),
    check(
      'taxonomy_audit_events_links_check',
      sql`(${table.rollbackOfEventId} IS NULL OR ${table.rollbackOfEventId} <> ${table.id}) AND (${table.compensatesEventId} IS NULL OR ${table.compensatesEventId} <> ${table.id})`,
    ),
  ],
)

export const taxonomyLocksTable = sqliteTable(
  'taxonomy_locks',
  {
    id: text().primaryKey(),
    scope: text()
      .$type<'site_assignment' | 'tag' | 'alias' | 'merge' | 'parent_edge'>()
      .notNull(),
    resourceKey: text('resource_key').notNull(),
    siteId: integer('site_id').references(() => sitesTable.id, {
      onDelete: 'cascade',
    }),
    tagId: integer('tag_id').references(() => tagsTable.id, {
      onDelete: 'cascade',
    }),
    relatedTagId: integer('related_tag_id').references(() => tagsTable.id, {
      onDelete: 'cascade',
    }),
    alias: text(),
    reason: text().notNull(),
    revision: integer().notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    releasedBy: text('released_by'),
    releasedAt: integer('released_at', { mode: 'timestamp' }),
    releaseReason: text('release_reason'),
  },
  (table) => [
    uniqueIndex('taxonomy_locks_active_resource_unique')
      .on(table.resourceKey)
      .where(sql`${table.releasedAt} IS NULL`),
    index('taxonomy_locks_site_idx').on(table.siteId, table.releasedAt),
    index('taxonomy_locks_tag_idx').on(table.tagId, table.releasedAt),
    check(
      'taxonomy_locks_scope_check',
      sql`${table.scope} IN ('site_assignment', 'tag', 'alias', 'merge', 'parent_edge')`,
    ),
    check(
      'taxonomy_locks_target_check',
      sql`(${table.scope} = 'site_assignment' AND ${table.siteId} IS NOT NULL AND ${table.tagId} IS NOT NULL AND ${table.relatedTagId} IS NULL AND ${table.alias} IS NULL) OR (${table.scope} = 'tag' AND ${table.siteId} IS NULL AND ${table.tagId} IS NOT NULL AND ${table.relatedTagId} IS NULL AND ${table.alias} IS NULL) OR (${table.scope} = 'alias' AND ${table.siteId} IS NULL AND ${table.tagId} IS NOT NULL AND ${table.relatedTagId} IS NULL AND ${table.alias} IS NOT NULL) OR (${table.scope} IN ('merge', 'parent_edge') AND ${table.siteId} IS NULL AND ${table.tagId} IS NOT NULL AND ${table.relatedTagId} IS NOT NULL AND ${table.tagId} <> ${table.relatedTagId} AND ${table.alias} IS NULL)`,
    ),
    check('taxonomy_locks_revision_check', sql`${table.revision} >= 1`),
    check(
      'taxonomy_locks_release_check',
      sql`(${table.releasedAt} IS NULL AND ${table.releasedBy} IS NULL AND ${table.releaseReason} IS NULL) OR (${table.releasedAt} IS NOT NULL AND ${table.releasedBy} IS NOT NULL AND ${table.releaseReason} IS NOT NULL)`,
    ),
  ],
)

export const guestbookTable = sqliteTable(
  'guestbook',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    message: text().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    hiddenAt: integer('hidden_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('guestbook_created_idx').on(table.createdAt),
    uniqueIndex('guestbook_entry_unique').on(table.name, table.message),
  ],
)

export const adminLoginAttemptsTable = sqliteTable('admin_login_attempts', {
  key: text().primaryKey(),
  failures: integer().notNull().default(0),
  windowStarted: integer('window_started', { mode: 'timestamp' }).notNull(),
  blockedUntil: integer('blocked_until', { mode: 'timestamp' }),
})

export const publicRateLimitsTable = sqliteTable(
  'public_rate_limits',
  {
    key: text().primaryKey(),
    count: integer().notNull().default(0),
    windowStarted: integer('window_started', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('public_rate_limits_window_started_idx').on(table.windowStarted),
  ],
)

export const publicSubmissionAttemptsTable = sqliteTable(
  'public_submission_attempts',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    key: text().notNull(),
    attemptedAt: integer('attempted_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('public_submission_attempts_key_time_idx').on(
      table.key,
      table.attemptedAt,
    ),
    index('public_submission_attempts_time_idx').on(table.attemptedAt),
  ],
)

export const publicAttemptsTable = sqliteTable(
  'public_attempts',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    action: text().notNull(),
    scope: text().notNull(),
    key: text().notNull(),
    reservationId: text('reservation_id').notNull(),
    attemptedAt: integer('attempted_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('public_attempts_scope_key_time_idx').on(
      table.action,
      table.scope,
      table.key,
      table.attemptedAt,
    ),
    index('public_attempts_reservation_idx').on(table.reservationId),
    index('public_attempts_time_idx').on(table.attemptedAt),
  ],
)

export const turnstileFailuresTable = sqliteTable(
  'turnstile_failures',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    action: text().notNull(),
    errorCode: text('error_code').notNull(),
    attemptedAt: integer('attempted_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('turnstile_failures_time_idx').on(table.attemptedAt)],
)

export const publicIdentityActivityTable = sqliteTable(
  'public_identity_activity',
  {
    identityKey: text('identity_key').primaryKey(),
    firstSeen: integer('first_seen', { mode: 'timestamp' }).notNull(),
    lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull(),
    voteChanges: integer('vote_changes').notNull().default(0),
  },
  (table) => [
    index('public_identity_activity_last_seen_idx').on(table.lastSeen),
  ],
)

export const siteVotesTable = sqliteTable(
  'site_votes',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sitesTable.id),
    visitorKey: text('visitor_key').notNull(),
    identityScheme: text('identity_scheme').notNull().default('ip-v0'),
    voted: integer().notNull().default(1),
    quarantined: integer().notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('site_votes_visitor_unique').on(table.siteId, table.visitorKey),
    index('site_votes_site_idx').on(table.siteId),
  ],
)

export const voteToggleActionsTable = sqliteTable(
  'vote_toggle_actions',
  {
    requestId: text('request_id').primaryKey(),
    siteId: integer('site_id').notNull(),
    visitorKey: text('visitor_key').notNull(),
    status: text().notNull().default('pending'),
    voted: integer(),
    votes: integer(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('vote_toggle_actions_identity_idx').on(
      table.visitorKey,
      table.createdAt,
    ),
    index('vote_toggle_actions_time_idx').on(table.createdAt),
  ],
)

export const appStateTable = sqliteTable('app_state', {
  key: text().primaryKey(),
  value: text().notNull(),
})

export const adminSessionsTable = sqliteTable(
  'admin_sessions',
  {
    id: text().primaryKey(),
    username: text().notNull(),
    credentialVersion: text('credential_version').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('admin_sessions_expires_idx').on(table.expiresAt),
    index('admin_sessions_username_idx').on(table.username),
    uniqueIndex('admin_sessions_one_live_username_unique')
      .on(table.username)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
)

export type SiteRow = typeof sitesTable.$inferSelect
export type SubmissionRow = typeof submissionsTable.$inferSelect
