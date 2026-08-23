import { z } from 'zod'

import { mapSeries, mapSettledSeries } from '../lib/async'
import { graphAcceptsParent, normalizeProposedSlug } from './guards'
import {
  decryptStoredProviderCredential,
  encryptStoredProviderCredential,
} from './encryption'
import { validateProviderEndpoint } from './endpoint'
import {
  hashTaxonomyInput,
  normalizeTaxonomyTag,
  sha256Hex,
  stableJson,
  taxonomyJobKey,
} from './normalize'
import { shadowSampleRequirement, TaxonomyRepository } from './repository'
import { allowedProviderHosts } from './provider-security'
import {
  createGeminiProvider,
  createOpenAICompatibleProvider,
} from './providers'
import type {
  BackfillResult,
  OntologyMutation,
  RollbackResult,
  RuntimeOptions,
  RuntimePolicy,
  TaxonomyServiceEnv,
  TaxonomyMode,
  TaxonomyJob,
} from './runtime-types'

function nowSeconds(options: RuntimeOptions): number {
  return Math.floor((options.now?.() ?? Date.now()) / 1_000)
}

function releaseSha(env: TaxonomyServiceEnv): string {
  return env.RELEASE_SHA
}

type AssignmentProvenance = {
  rawName: string
  source: 'automation'
  decisionId: string | null
  revision: number
  createdAt: number
  updatedAt: number
}

type AssignmentTagProvenance = {
  id: number
  status: 'active'
  revision: number
}

function assignmentProvenance(
  value: Record<string, unknown>,
  label: string,
): AssignmentProvenance {
  const assignment = value.assignment
  if (!assignment || typeof assignment !== 'object') {
    throw new Error(`Assignment audit event lacks ${label} provenance metadata`)
  }
  const row = assignment as Record<string, unknown>
  if (
    typeof row.rawName !== 'string' ||
    !row.rawName.trim() ||
    row.source !== 'automation' ||
    !(row.decisionId === null || typeof row.decisionId === 'string') ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    !Number.isSafeInteger(row.createdAt) ||
    !Number.isSafeInteger(row.updatedAt)
  ) {
    throw new Error(
      `Assignment audit event has invalid ${label} provenance metadata`,
    )
  }
  return {
    rawName: row.rawName,
    source: 'automation',
    decisionId: row.decisionId,
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  }
}

function assignmentMatches(
  current: Record<string, unknown> | null,
  expected: AssignmentProvenance,
): boolean {
  return (
    current?.rawName === expected.rawName &&
    current.source === expected.source &&
    current.decisionId === expected.decisionId &&
    current.revision === expected.revision &&
    current.createdAt === expected.createdAt &&
    current.updatedAt === expected.updatedAt
  )
}

function assignmentTagProvenance(
  value: Record<string, unknown>,
  label: string,
  expectedTagId: number,
): AssignmentTagProvenance {
  const tag = value.tag
  if (!tag || typeof tag !== 'object') {
    throw new Error(
      `Assignment audit event lacks ${label} tag provenance metadata`,
    )
  }
  const row = tag as Record<string, unknown>
  if (
    row.id !== expectedTagId ||
    row.status !== 'active' ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1
  ) {
    throw new Error(
      `Assignment audit event has invalid ${label} tag provenance metadata`,
    )
  }
  return {
    id: expectedTagId,
    status: 'active',
    revision: Number(row.revision),
  }
}

export class TaxonomyService {
  readonly repository: TaxonomyRepository
  readonly env: TaxonomyServiceEnv
  readonly options: RuntimeOptions

  constructor(env: TaxonomyServiceEnv, options: RuntimeOptions = {}) {
    this.env = env
    this.options = options
    this.repository = new TaxonomyRepository(env.DB, env.TAXONOMY_QUEUE)
  }

  async setMode(mode: TaxonomyMode, actorId = 'admin'): Promise<void> {
    const now = nowSeconds(this.options)
    const state = await this.repository.loadState()
    if (mode === state.mode) return
    if (
      (mode === 'shadow' || mode === 'gradual' || mode === 'autonomous') &&
      state.circuitState !== 'closed'
    ) {
      throw new Error('Taxonomy circuit is not closed')
    }
    if (mode === 'gradual') {
      if (state.mode !== 'shadow') {
        throw new Error('Gradual mode requires a completed shadow-mode gate')
      }
      const policy = await this.repository.loadPolicy(
        state.activePolicyConfigId,
      )
      const providers = await this.repository.loadProviderRoute(
        state.activeProviderConfigId,
      )
      const requiredVoters =
        1 +
        providers.filter(({ routingRole }) => routingRole === 'consensus')
          .length
      const metrics = await this.repository.shadowReadinessMetrics({
        policyConfigId: state.activePolicyConfigId,
        providerConfigId: state.activeProviderConfigId,
        requiredVoters,
      })
      if (
        metrics.samples <
          shadowSampleRequirement(
            policy.shadowMinimumSamples,
            metrics.eligible,
          ) ||
        metrics.coverageBasisPoints <
          Math.max(1, policy.shadowMinimumCoverageBasisPoints) ||
        metrics.schemaSuccessBasisPoints <
          Math.max(1, policy.shadowSchemaSuccessBasisPoints) ||
        metrics.agreementBasisPoints <
          Math.max(1, policy.shadowProviderAgreementBasisPoints)
      ) {
        throw new Error('Shadow-mode readiness thresholds have not been met')
      }
    }
    if (mode === 'autonomous' && state.mode !== 'gradual') {
      throw new Error('Autonomous mode requires gradual mode first')
    }
    if (
      (mode === 'shadow' || mode === 'gradual' || mode === 'autonomous') &&
      state.activeProviderConfigId === null
    ) {
      throw new Error('An active taxonomy provider is required')
    }
    if (
      (mode === 'shadow' || mode === 'gradual' || mode === 'autonomous') &&
      state.activePolicyConfigId === null
    ) {
      throw new Error('An active taxonomy policy is required')
    }
    await this.repository.setMode(mode, now, releaseSha(this.env), actorId)
  }

  async resetCircuit(actorId = 'admin'): Promise<void> {
    const now = nowSeconds(this.options)
    await this.repository.closeCircuit(now, releaseSha(this.env), actorId)
    await this.setMode('shadow', actorId)
  }

  async createProviderConfig(input: {
    name: string
    providerKind: 'openai_compatible' | 'gemini'
    endpoint: string
    model: string
    dialect?: 'responses' | 'chat_completions'
    routingGroup?: string
    routingRole?: 'primary' | 'failover' | 'consensus'
    routingPriority?: number
    timeoutMs?: number
    keyVersion: number
    credential: string
    enabled?: boolean
    actorId: string
  }): Promise<number> {
    const endpoint = validateProviderEndpoint(input.endpoint, {
      allowedHosts: allowedProviderHosts(input.providerKind),
    }).href
    if (input.providerKind === 'openai_compatible' && !input.dialect) {
      throw new TypeError('OpenAI-compatible providers require a dialect')
    }
    if (input.providerKind === 'gemini' && input.dialect) {
      throw new TypeError('Gemini providers do not use an OpenAI dialect')
    }
    const now = nowSeconds(this.options)
    const inserted = await this.repository.db
      .prepare(
        `INSERT INTO taxonomy_provider_configs
         (name, revision, provider_kind, endpoint, model, dialect, routing_group,
          routing_role, routing_priority, timeout_ms, key_version, credential_nonce,
          credential_ciphertext, credential_fingerprint, enabled, supersedes_id,
          created_by, created_at)
         VALUES (?, (SELECT coalesce(max(revision), 0) + 1
                     FROM taxonomy_provider_configs WHERE name = ?),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, '0000000000000000',
                 '0000000000000000', ?, 0,
                 (SELECT id FROM taxonomy_provider_configs
                  WHERE name = ? ORDER BY revision DESC LIMIT 1), ?, ?)`,
      )
      .bind(
        input.name.trim(),
        input.name.trim(),
        input.providerKind,
        endpoint,
        input.model.trim(),
        input.dialect ?? null,
        input.routingGroup?.trim() || 'default',
        input.routingRole ?? 'primary',
        input.routingPriority ?? 0,
        input.timeoutMs ?? 30_000,
        input.keyVersion,
        (await sha256Hex(input.credential)).slice(0, 32),
        input.name.trim(),
        input.actorId,
        now,
      )
      .run()
    const id = inserted.meta.last_row_id
    if (!id) throw new Error('Provider configuration was not created')
    let encrypted: { nonce: string; ciphertext: string }
    try {
      encrypted = await encryptStoredProviderCredential(input.credential, {
        providerId: id,
        keyVersion: input.keyVersion,
        env: this.env,
      })
    } catch (error) {
      await this.repository.db
        .prepare('DELETE FROM taxonomy_provider_configs WHERE id = ?')
        .bind(id)
        .run()
      throw error
    }
    const updated = await this.repository.db
      .prepare(
        `UPDATE taxonomy_provider_configs SET credential_nonce = ?, credential_ciphertext = ?, enabled = ?
         WHERE id = ? AND enabled = 0`,
      )
      .bind(encrypted.nonce, encrypted.ciphertext, input.enabled ? 1 : 0, id)
      .run()
    if (!updated.meta.changes)
      throw new Error('Provider credential activation failed')
    try {
      await this.repository.auditControlPlane(
        'provider_config_created',
        'provider_config',
        String(id),
        {},
        {
          providerKind: input.providerKind,
          endpoint,
          model: input.model.trim(),
          enabled: Boolean(input.enabled),
        },
        now,
        releaseSha(this.env),
        input.actorId,
      )
    } catch (error) {
      await this.repository.db
        .prepare('DELETE FROM taxonomy_provider_configs WHERE id = ?')
        .bind(id)
        .run()
      throw error
    }
    return id
  }

  async updateProviderConfig(input: {
    providerConfigId: number
    name?: string
    endpoint?: string
    model?: string
    dialect?: 'responses' | 'chat_completions' | null
    routingGroup?: string
    routingRole?: 'primary' | 'failover' | 'consensus'
    routingPriority?: number
    timeoutMs?: number
    credential?: string
    actorId: string
  }): Promise<boolean> {
    const config = await this.repository.loadProvider(input.providerConfigId)
    if (!config) return false
    const fingerprint =
      (await this.repository.db
        .prepare(
          'SELECT credential_fingerprint FROM taxonomy_provider_configs WHERE id = ?',
        )
        .bind(input.providerConfigId)
        .first<string>('credential_fingerprint')) ?? ''
    const endpoint = input.endpoint
      ? validateProviderEndpoint(input.endpoint, {
          allowedHosts: allowedProviderHosts(config.providerKind),
        }).href
      : config.endpoint
    const dialect = input.dialect !== undefined ? input.dialect : config.dialect
    const model = input.model?.trim() || config.model
    if (config.providerKind === 'openai_compatible' && !dialect) {
      throw new TypeError('OpenAI-compatible providers require a dialect')
    }
    if (config.providerKind === 'gemini' && dialect) {
      throw new TypeError('Gemini providers do not use an OpenAI dialect')
    }
    const name = input.name?.trim() || config.name
    const routingGroup = input.routingGroup?.trim() || config.routingGroup
    const routingRole = input.routingRole ?? config.routingRole
    const routingPriority = input.routingPriority ?? config.routingPriority
    const timeoutMs = input.timeoutMs ?? config.timeoutMs
    const structural =
      endpoint !== config.endpoint ||
      model !== config.model ||
      dialect !== config.dialect ||
      Boolean(input.credential)
    let credential: {
      nonce: string
      ciphertext: string
      fingerprint: string
      keyVersion: number
    } | null = null
    if (input.credential) {
      const encrypted = await encryptStoredProviderCredential(
        input.credential,
        {
          providerId: input.providerConfigId,
          keyVersion: config.keyVersion,
          env: this.env,
        },
      )
      credential = {
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        fingerprint: (await sha256Hex(input.credential)).slice(0, 32),
        keyVersion: config.keyVersion,
      }
    }
    const now = nowSeconds(this.options)
    const sanitize = (value: {
      name?: string
      endpoint?: string
      model?: string
      dialect?: string | null
      routingGroup?: string
      routingRole?: string
      routingPriority?: number
      timeoutMs?: number
      keyVersion?: number
    }) => value
    await this.repository.auditControlPlane(
      'provider_config_updated',
      'provider_config',
      String(input.providerConfigId),
      sanitize({
        name: config.name,
        endpoint: config.endpoint,
        model: config.model,
        dialect: config.dialect,
        routingGroup: config.routingGroup,
        routingRole: config.routingRole,
        routingPriority: config.routingPriority,
        timeoutMs: config.timeoutMs,
        keyVersion: config.keyVersion,
      }),
      sanitize({
        name,
        endpoint,
        model,
        dialect,
        routingGroup,
        routingRole,
        routingPriority,
        timeoutMs,
        keyVersion: credential?.keyVersion ?? config.keyVersion,
      }),
      now,
      releaseSha(this.env),
      input.actorId,
      [
        this.repository.db
          .prepare(
            `SELECT CASE WHEN EXISTS (
               SELECT 1 FROM taxonomy_provider_configs WHERE id = ?
             ) THEN 1 ELSE json_extract('provider update guard failed', '$') END`,
          )
          .bind(input.providerConfigId),
        this.repository.db
          .prepare(
            `UPDATE taxonomy_provider_configs SET
               name = ?, endpoint = ?, model = ?, dialect = ?,
               routing_group = ?, routing_role = ?, routing_priority = ?,
               timeout_ms = ?,
               key_version = ?, credential_nonce = ?, credential_ciphertext = ?,
               credential_fingerprint = ?,
               enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END
             WHERE id = ?`,
          )
          .bind(
            name,
            endpoint,
            model,
            dialect,
            routingGroup,
            routingRole,
            routingPriority,
            timeoutMs,
            credential?.keyVersion ?? config.keyVersion,
            credential?.nonce ?? config.credentialNonce,
            credential?.ciphertext ?? config.credentialCiphertext,
            credential?.fingerprint ?? fingerprint,
            structural ? 1 : 0,
            input.providerConfigId,
          ),
        ...(structural
          ? [
              this.repository.db
                .prepare(
                  `UPDATE taxonomy_state SET active_provider_config_id = NULL,
                   mode = CASE WHEN mode IN ('gradual', 'autonomous') THEN 'shadow' ELSE mode END,
                   mode_changed_at = CASE WHEN mode IN ('gradual', 'autonomous') THEN ? ELSE mode_changed_at END,
                   updated_at = ? WHERE id = 1 AND active_provider_config_id = ?`,
                )
                .bind(now, now, input.providerConfigId),
            ]
          : []),
      ],
    )
    return true
  }

  async deleteProviderConfig(
    providerConfigId: number,
    actorId: string,
  ): Promise<boolean> {
    const config = await this.repository.loadProvider(providerConfigId)
    if (!config) return false
    const state = await this.repository.loadState()
    if (state.activeProviderConfigId === providerConfigId) {
      throw new Error('Disable the active provider before deleting it')
    }
    const enabled = await this.repository.db
      .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
      .bind(providerConfigId)
      .first<number>('enabled')
    if (enabled === 1) {
      throw new Error('Disable the provider before deleting it')
    }
    const referenced = await this.repository.db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM taxonomy_jobs WHERE provider_config_id = ?
           UNION ALL SELECT 1 FROM taxonomy_job_attempts
             WHERE provider_config_id = ?
           UNION ALL SELECT 1 FROM taxonomy_audit_events
             WHERE provider_config_id = ?
           UNION ALL SELECT 1 FROM taxonomy_concept_evidence
             WHERE provider_config_id = ?
           UNION ALL SELECT 1 FROM taxonomy_provider_configs
             WHERE supersedes_id = ? AND id <> ?
         ) THEN 1 ELSE 0 END AS referenced`,
      )
      .bind(
        providerConfigId,
        providerConfigId,
        providerConfigId,
        providerConfigId,
        providerConfigId,
        providerConfigId,
      )
      .first<number>('referenced')
    if (referenced) {
      throw new Error(
        'Provider has recorded history; keep it disabled instead of deleting it',
      )
    }
    const now = nowSeconds(this.options)
    await this.repository.auditControlPlane(
      'provider_config_deleted',
      'provider_config',
      String(providerConfigId),
      {
        name: config.name,
        endpoint: config.endpoint,
        model: config.model,
        providerKind: config.providerKind,
      },
      { deleted: true },
      now,
      releaseSha(this.env),
      actorId,
      [
        this.repository.db
          .prepare(
            `DELETE FROM taxonomy_provider_configs
             WHERE id = ? AND enabled = 0`,
          )
          .bind(providerConfigId),
        this.repository.db
          .prepare(
            `SELECT CASE WHEN NOT EXISTS (
               SELECT 1 FROM taxonomy_provider_configs WHERE id = ?
             ) THEN 1
             ELSE json_extract('provider delete postcondition failed', '$') END`,
          )
          .bind(providerConfigId),
      ],
    )
    return true
  }

  async enableProvider(
    providerConfigId: number,
    actorId = 'admin',
  ): Promise<boolean> {
    const now = nowSeconds(this.options)
    const config = await this.repository.loadProvider(providerConfigId)
    if (!config) return false
    const enabled = await this.repository.db
      .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
      .bind(providerConfigId)
      .first<number>('enabled')
    if (enabled === 1) return true
    await this.testProvider(providerConfigId)
    await this.repository.auditControlPlane(
      'provider_enabled',
      'provider_config',
      String(providerConfigId),
      { enabled: false },
      { enabled: true },
      now,
      releaseSha(this.env),
      actorId,
      [
        this.repository.db
          .prepare(
            `SELECT CASE WHEN enabled = 0 THEN 1
             ELSE json_extract('provider enable guard failed', '$') END
             FROM taxonomy_provider_configs WHERE id = ?`,
          )
          .bind(providerConfigId),
        this.repository.db
          .prepare(
            'UPDATE taxonomy_provider_configs SET enabled = 1 WHERE id = ? AND enabled = 0',
          )
          .bind(providerConfigId),
        this.repository.db
          .prepare(
            `SELECT CASE WHEN enabled = 1 THEN 1
             ELSE json_extract('provider enable postcondition failed', '$') END
             FROM taxonomy_provider_configs WHERE id = ?`,
          )
          .bind(providerConfigId),
      ],
    )
    return (
      (await this.repository.db
        .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
        .bind(providerConfigId)
        .first<number>('enabled')) === 1
    )
  }

  async activateProvider(
    providerConfigId: number,
    actorId = 'admin',
  ): Promise<boolean> {
    const now = nowSeconds(this.options)
    const config = await this.repository.loadProvider(providerConfigId)
    if (!config) return false
    if (
      !(await this.repository.db
        .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
        .bind(providerConfigId)
        .first<number>('enabled'))
    ) {
      throw new Error('Provider must pass a test before activation')
    }
    await this.repository.auditControlPlane(
      'provider_activated',
      'provider_config',
      String(providerConfigId),
      {},
      { enabled: true, active: true },
      now,
      releaseSha(this.env),
      actorId,
      [
        this.repository.db
          .prepare(
            `SELECT CASE WHEN EXISTS (
               SELECT 1 FROM taxonomy_provider_configs WHERE id = ?
             ) THEN 1 ELSE json_extract('provider activation guard failed', '$') END`,
          )
          .bind(providerConfigId),
        this.repository.db
          .prepare(
            'UPDATE taxonomy_provider_configs SET enabled = 1 WHERE id = ?',
          )
          .bind(providerConfigId),
        this.repository.db
          .prepare(
            `UPDATE taxonomy_state SET active_provider_config_id = ?,
             mode = CASE WHEN mode IN ('gradual', 'autonomous') THEN 'shadow' ELSE mode END,
             mode_changed_at = CASE WHEN mode IN ('gradual', 'autonomous') THEN ? ELSE mode_changed_at END,
             updated_at = ? WHERE id = 1`,
          )
          .bind(providerConfigId, now, now),
        this.repository.db
          .prepare(
            `SELECT CASE WHEN active_provider_config_id = ? THEN 1
             ELSE json_extract('provider activation postcondition failed', '$') END
             FROM taxonomy_state WHERE id = 1`,
          )
          .bind(providerConfigId),
      ],
    )
    const state = await this.repository.loadState()
    if (state.activeProviderConfigId !== providerConfigId)
      throw new Error('Provider activation did not update taxonomy state')
    return true
  }

  async disableProvider(
    providerConfigId: number,
    actorId = 'admin',
  ): Promise<boolean> {
    const now = nowSeconds(this.options)
    const config = await this.repository.loadProvider(providerConfigId)
    if (!config) return false
    const enabled = await this.repository.db
      .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
      .bind(providerConfigId)
      .first<number>('enabled')
    if (enabled !== 1) return false
    await this.repository.auditControlPlane(
      'provider_disabled',
      'provider_config',
      String(providerConfigId),
      { enabled: true },
      { enabled: false },
      now,
      releaseSha(this.env),
      actorId,
      [
        this.repository.db
          .prepare(
            'UPDATE taxonomy_provider_configs SET enabled = 0 WHERE id = ? AND enabled = 1',
          )
          .bind(providerConfigId),
        this.repository.db
          .prepare(
            `UPDATE taxonomy_state SET active_provider_config_id = NULL, mode = 'disabled',
             mode_changed_at = ?, updated_at = ?
             WHERE id = 1 AND active_provider_config_id = ?`,
          )
          .bind(now, now, providerConfigId),
        this.repository.db
          .prepare(
            `SELECT CASE WHEN enabled = 0 AND
             ((SELECT active_provider_config_id FROM taxonomy_state WHERE id = 1) IS NULL OR
              (SELECT active_provider_config_id FROM taxonomy_state WHERE id = 1) <> ?)
             THEN 1 ELSE json_extract('provider disable postcondition failed', '$') END
             FROM taxonomy_provider_configs WHERE id = ?`,
          )
          .bind(providerConfigId, providerConfigId),
      ],
    )
    const after = await this.repository.db
      .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
      .bind(providerConfigId)
      .first<number>('enabled')
    if (after !== 0) throw new Error('Provider disable did not update state')
    return true
  }

  async testProvider(
    providerConfigId: number,
    _ignoredAllowedHosts?: readonly string[],
  ): Promise<{
    ok: true
    latencyMs: number
    providerRequestId: string | null
  }> {
    const config = await this.repository.loadProvider(providerConfigId)
    if (!config) throw new Error('Provider configuration not found')
    const allowedHosts = allowedProviderHosts(config.providerKind)
    validateProviderEndpoint(config.endpoint, { allowedHosts })
    const apiKey = await decryptStoredProviderCredential(
      {
        providerId: config.id,
        keyVersion: config.keyVersion,
        nonce: config.credentialNonce,
        ciphertext: config.credentialCiphertext,
      },
      this.env,
    )
    const shared = {
      apiKey,
      model: config.model,
      endpoint: config.endpoint,
      allowedHosts,
      timeoutMs: Math.min(config.timeoutMs, 60_000),
      maxResponseBytes: 16_384,
      maxRetries: 0,
    }
    const provider =
      config.providerKind === 'gemini'
        ? createGeminiProvider(shared, { fetch: this.options.fetch })
        : createOpenAICompatibleProvider(
            { ...shared, dialect: config.dialect ?? 'responses' },
            { fetch: this.options.fetch },
          )
    const result = await provider.generateStructured({
      schema: z.strictObject({ ok: z.literal(true) }),
      schemaName: 'taxonomy_provider_test',
      systemPrompt: 'Return exactly the requested JSON object.',
      userPrompt: 'Return {"ok":true}.',
    })
    return {
      ok: true,
      latencyMs: result.latencyMs,
      providerRequestId: result.providerRequestId,
    }
  }

  async createPolicyRevision(
    input: Omit<RuntimePolicy, 'id' | 'revision'>,
    actorId: string,
    supersedesPolicyConfigId?: number,
  ): Promise<number> {
    const values = [
      input.assignmentLimit,
      input.novelEvidenceSiteThreshold,
      input.assignmentConfidenceMicros,
      input.ontologyConfidenceMicros,
      input.minimumMarginMicros,
      input.hierarchyMaxDepth,
      input.hierarchyMaxFanout,
      input.ontologyProviderAgreement,
      input.retryBudget,
      input.retryBaseSeconds,
      input.retryMaxSeconds,
      input.rolloutBasisPoints,
      input.dailyRequestBudget,
      input.dailyTokenBudget,
      input.schemaFailureTripBasisPoints,
      input.disagreementTripBasisPoints,
      input.rollbackTripBasisPoints,
      input.mutationVolumeTripCount,
      input.rawResponseRetentionSeconds,
      input.shadowMinimumSamples,
      input.shadowMinimumCoverageBasisPoints,
      input.shadowSchemaSuccessBasisPoints,
      input.shadowProviderAgreementBasisPoints,
      input.promptHash,
      input.schemaHash,
      supersedesPolicyConfigId ?? null,
      actorId,
      nowSeconds(this.options),
      supersedesPolicyConfigId ?? null,
      supersedesPolicyConfigId ?? null,
    ] as const
    const result = await this.repository.db
      .prepare(
        `INSERT INTO taxonomy_policy_configs
         (revision, assignment_limit, novel_evidence_site_threshold,
          assignment_confidence_micros, ontology_confidence_micros,
          minimum_margin_micros, hierarchy_max_depth, hierarchy_max_fanout,
          ontology_provider_agreement, retry_budget, retry_base_seconds,
          retry_max_seconds, rollout_basis_points, daily_request_budget,
          daily_token_budget, schema_failure_trip_basis_points,
          disagreement_trip_basis_points, rollback_trip_basis_points,
          mutation_volume_trip_count, raw_response_retention_seconds,
          shadow_minimum_samples, shadow_minimum_coverage_basis_points,
          shadow_schema_success_basis_points, shadow_provider_agreement_basis_points,
          prompt_hash, schema_hash, supersedes_id, created_by, created_at)
         SELECT coalesce(max(revision), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 coalesce(?26, (SELECT active_policy_config_id FROM taxonomy_state WHERE id = 1)), ?, ?
          FROM taxonomy_policy_configs
          WHERE ?29 IS NULL OR EXISTS (SELECT 1 FROM taxonomy_policy_configs WHERE id = ?30)`,
      )
      .bind(...values)
      .run()
    if (!result.meta.last_row_id)
      throw new Error('Policy revision was not created')
    try {
      await this.repository.auditControlPlane(
        'policy_config_created',
        'policy_config',
        String(result.meta.last_row_id),
        {},
        { promptHash: input.promptHash, schemaHash: input.schemaHash },
        nowSeconds(this.options),
        releaseSha(this.env),
        actorId,
      )
    } catch (error) {
      await this.repository.db
        .prepare('DELETE FROM taxonomy_policy_configs WHERE id = ?')
        .bind(result.meta.last_row_id)
        .run()
      throw error
    }
    return result.meta.last_row_id
  }

  async activatePolicy(
    policyConfigId: number,
    actorId = 'admin',
  ): Promise<boolean> {
    const now = nowSeconds(this.options)
    await this.repository.loadPolicy(policyConfigId)
    await this.repository.auditControlPlane(
      'policy_activated',
      'policy_config',
      String(policyConfigId),
      {},
      { active: true },
      now,
      releaseSha(this.env),
      actorId,
      [
        this.repository.db
          .prepare(
            `UPDATE taxonomy_state SET active_policy_config_id = ?,
          mode = CASE WHEN mode IN ('gradual', 'autonomous') THEN 'shadow' ELSE mode END,
          mode_changed_at = CASE WHEN mode IN ('gradual', 'autonomous') THEN ? ELSE mode_changed_at END,
         updated_at = ?
         WHERE id = 1 AND EXISTS (SELECT 1 FROM taxonomy_policy_configs WHERE id = ?)`,
          )
          .bind(policyConfigId, now, now, policyConfigId),
        this.repository.db
          .prepare(
            `SELECT CASE WHEN active_policy_config_id = ? THEN 1
             ELSE json_extract('policy activation postcondition failed', '$') END
             FROM taxonomy_state WHERE id = 1`,
          )
          .bind(policyConfigId),
      ],
    )
    return true
  }

  async enqueueSite(siteId: number, priority = 0): Promise<string | null> {
    if (!Number.isSafeInteger(siteId) || siteId < 1)
      throw new TypeError('Invalid site id')
    const state = await this.repository.loadState()
    if (!state.siteClassificationEnabled) return null
    const [policy, sites] = await Promise.all([
      this.repository.loadPolicy(state.activePolicyConfigId),
      this.repository.backfillSites(siteId - 1, 1),
    ])
    const site = sites.find((value) => value.id === siteId)
    if (!site) return null
    const inputHash =
      site.classificationInputHash ??
      (await hashTaxonomyInput({
        siteId: site.id,
        name: site.name,
        url: site.url,
        description: site.description,
        tags: [],
      }))
    if (!site.classificationInputHash) {
      const initialized = await this.repository.db
        .prepare(
          `UPDATE sites SET classification_input_hash = ?
           WHERE id = ? AND content_version = ? AND classification_input_hash IS NULL`,
        )
        .bind(inputHash, site.id, site.contentVersion)
        .run()
      if (!initialized.meta.changes) return null
    }
    const classifierVersion = `${policy.id}-${state.activeProviderConfigId ?? 0}`
    const jobKey = taxonomyJobKey({
      siteId,
      inputHash,
      taxonomyVersion: state.publishedVersion,
      classifierVersion,
    })
    const id = `tax:${(await sha256Hex(jobKey)).slice(0, 40)}`
    const inserted = await this.repository.enqueueJob(
      {
        id,
        jobKey,
        kind: 'classify_site',
        siteId,
        inputHash,
        siteContentVersion: site.contentVersion,
        taxonomyVersion: state.publishedVersion,
        providerConfigId: state.activeProviderConfigId,
        policyConfigId: policy.id,
        priority,
        maxAttempts: Math.max(1, policy.retryBudget + 1),
      },
      nowSeconds(this.options),
    )
    return inserted ? id : null
  }

  async setSiteClassificationEnabled(
    enabled: boolean,
    actorId = 'admin',
  ): Promise<void> {
    await this.repository.setSiteClassificationEnabled(
      enabled,
      nowSeconds(this.options),
      releaseSha(this.env),
      actorId,
    )
  }

  async backfill(cursor = 0, requestedLimit = 25): Promise<BackfillResult> {
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    const sites = await this.repository.backfillSites(cursor, limit)
    const results = await mapSeries(sites, (site) => this.enqueueSite(site.id))
    let enqueued = 0
    for (const jobId of results) {
      if (jobId) enqueued += 1
    }
    return {
      scanned: sites.length,
      enqueued,
      nextCursor: sites.length === limit ? (sites.at(-1)?.id ?? null) : null,
    }
  }

  async retryJobs(jobIds: readonly string[]): Promise<number> {
    const ids = [...new Set(jobIds)]
    if (!ids.length || ids.length > 100) throw new TypeError('Invalid job list')
    const now = nowSeconds(this.options)
    const results = await mapSeries(ids, async (id) => {
      const job = await this.repository.loadJob(id)
      if (!job) return false
      if (job.kind === 'classify_site' && job.siteId !== null) {
        const [state, sites] = await Promise.all([
          this.repository.loadState(),
          this.repository.backfillSites(job.siteId - 1, 1),
        ])
        const site = sites.find((candidate) => candidate.id === job.siteId)
        const current =
          site !== undefined &&
          site.contentVersion === job.siteContentVersion &&
          site.classificationInputHash === job.inputHash &&
          state.publishedVersion === job.taxonomyVersion &&
          state.activeProviderConfigId === job.providerConfigId &&
          state.activePolicyConfigId === job.policyConfigId
        if (!current) {
          return Boolean(await this.enqueueSite(job.siteId))
        }
      }
      const batchResults = await this.repository.db.batch([
        this.repository.db
          .prepare(
            `UPDATE taxonomy_jobs SET status = 'pending', attempt_count = 0,
             available_at = ?, lease_owner = NULL, lease_token = NULL,
             leased_until = NULL, completed_at = NULL, updated_at = ?,
             last_error_code = NULL, last_error_summary = NULL
             WHERE id = ? AND status IN (
               'pending', 'retry_wait', 'leased', 'dead', 'settled', 'degraded'
             )`,
          )
          .bind(now, now, id),
        this.repository.db
          .prepare(
            `INSERT OR IGNORE INTO taxonomy_outbox
             (id, job_id, payload, available_at, created_at)
             SELECT 'outbox:' || id, id, json_object('jobId', id), ?, ?
             FROM taxonomy_jobs WHERE id = ? AND status = 'pending'`,
          )
          .bind(now, now, id),
        this.repository.db
          .prepare(
            `UPDATE taxonomy_outbox SET dispatched_at = NULL, available_at = ?,
             lease_token = NULL, leased_until = NULL, last_error = NULL
             WHERE job_id = ? AND EXISTS (SELECT 1 FROM taxonomy_jobs
                                          WHERE id = ? AND status = 'pending')`,
          )
          .bind(now, id, id),
      ])
      return Boolean(batchResults[0]?.meta.changes)
    })
    let retried = 0
    for (const didRetry of results) {
      if (didRetry) retried += 1
    }
    return retried
  }

  async enqueueConcept(
    conceptInput: string,
    priority = 0,
  ): Promise<string | null> {
    const concept = normalizeTaxonomyTag(conceptInput)
    if (!concept) throw new TypeError('Concept cannot be empty')
    const state = await this.repository.loadState()
    const [policy, inputHash] = await Promise.all([
      this.repository.loadPolicy(state.activePolicyConfigId),
      sha256Hex(stableJson({ concept })),
    ])
    const jobKey = `concept:${encodeURIComponent(concept)}:input:${inputHash}:taxonomy:${state.publishedVersion}:provider:${state.activeProviderConfigId ?? 0}`
    const id = `tax:${(await sha256Hex(jobKey)).slice(0, 40)}`
    const inserted = await this.repository.enqueueJob(
      {
        id,
        jobKey,
        kind: 'reassess_concept',
        conceptKey: concept,
        inputHash,
        taxonomyVersion: state.publishedVersion,
        providerConfigId: state.activeProviderConfigId,
        policyConfigId: policy.id,
        priority,
        maxAttempts: Math.max(1, policy.retryBudget + 1),
      },
      nowSeconds(this.options),
    )
    return inserted ? id : null
  }

  async forceConceptReassessment(
    conceptInput: string,
    priority = 0,
  ): Promise<string | null> {
    const concept = normalizeTaxonomyTag(conceptInput)
    if (!concept) throw new TypeError('Concept cannot be empty')
    const state = await this.repository.loadState()
    const active = await this.repository.db
      .prepare(
        `SELECT id FROM taxonomy_jobs
         WHERE kind = 'reassess_concept' AND concept_key = ?
           AND taxonomy_version = ?
           AND coalesce(provider_config_id, 0) = ?
           AND status IN ('pending', 'leased', 'retry_wait')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(concept, state.publishedVersion, state.activeProviderConfigId ?? 0)
      .first<{ id: string }>()
    if (active) return active.id
    const [policy, inputHash] = await Promise.all([
      this.repository.loadPolicy(state.activePolicyConfigId),
      sha256Hex(
        stableJson({ concept, forced: true, nonce: crypto.randomUUID() }),
      ),
    ])
    const jobKey = `concept:${encodeURIComponent(concept)}:input:${inputHash}:taxonomy:${state.publishedVersion}:provider:${state.activeProviderConfigId ?? 0}`
    const id = `tax:${(await sha256Hex(jobKey)).slice(0, 40)}`
    const inserted = await this.repository.enqueueJob(
      {
        id,
        jobKey,
        kind: 'reassess_concept',
        conceptKey: concept,
        inputHash,
        taxonomyVersion: state.publishedVersion,
        providerConfigId: state.activeProviderConfigId,
        policyConfigId: policy.id,
        priority,
        maxAttempts: Math.max(1, policy.retryBudget + 1),
      },
      nowSeconds(this.options),
    )
    return inserted ? id : null
  }

  async enqueueOntologyCandidate(
    candidateId: string,
    priority = 10,
  ): Promise<string | null> {
    const candidate = await this.repository.candidate(candidateId)
    if (!candidate) return null
    const state = await this.repository.loadState()
    const [policy, inputHash] = await Promise.all([
      this.repository.loadPolicy(state.activePolicyConfigId),
      sha256Hex(stableJson({ candidateId, payload: candidate.payload })),
    ])
    const jobKey = `ontology:${encodeURIComponent(candidateId)}:input:${inputHash}:taxonomy:${state.publishedVersion}`
    const id = `tax:${(await sha256Hex(jobKey)).slice(0, 40)}`
    const inserted = await this.repository.enqueueJob(
      {
        id,
        jobKey,
        kind: 'apply_ontology',
        conceptKey: candidateId,
        inputHash,
        taxonomyVersion: state.publishedVersion,
        providerConfigId: state.activeProviderConfigId,
        policyConfigId: policy.id,
        priority,
        maxAttempts: 1,
      },
      nowSeconds(this.options),
    )
    return inserted ? id : null
  }

  async decideCandidate(input: {
    candidateId: string
    decision: 'accepted' | 'rejected' | 'deferred' | 'conflict'
    reason: string
    actorId: string
  }): Promise<{ decided: boolean; jobId: string | null }> {
    const candidate = await this.repository.candidate(input.candidateId)
    if (!candidate || String(candidate.status) !== 'proposed')
      return { decided: false, jobId: null }
    const now = nowSeconds(this.options)
    if (input.decision !== 'accepted') {
      return {
        decided: await this.repository.decideCandidate(
          input.candidateId,
          input.decision,
          input.reason,
          now,
        ),
        jobId: null,
      }
    }
    if (String(candidate.kind) === 'existing_tag') {
      throw new Error(
        'Existing-tag assignment candidates cannot be applied as ontology changes',
      )
    }
    const state = await this.repository.loadState()
    const [policy, inputHash] = await Promise.all([
      this.repository.loadPolicy(state.activePolicyConfigId),
      sha256Hex(
        stableJson({
          candidateId: input.candidateId,
          payload: candidate.payload,
        }),
      ),
    ])
    const jobKey = `ontology:${encodeURIComponent(input.candidateId)}:input:${inputHash}:taxonomy:${state.publishedVersion}`
    const jobId = `tax:${(await sha256Hex(jobKey)).slice(0, 40)}`
    const decided = await this.repository.acceptAndEnqueueCandidate({
      candidateId: input.candidateId,
      reason: `${input.reason} (approved by ${input.actorId})`,
      job: {
        id: jobId,
        jobKey,
        kind: 'apply_ontology',
        conceptKey: input.candidateId,
        inputHash,
        taxonomyVersion: state.publishedVersion,
        providerConfigId: state.activeProviderConfigId,
        policyConfigId: policy.id,
        priority: 10,
        maxAttempts: 1,
      },
      now,
    })
    if (!decided) throw new Error('Candidate acceptance was not queued')
    return { decided: true, jobId }
  }

  async publishOntology(
    mutation: OntologyMutation,
    actorId = 'taxonomy-service',
    application?: { candidateId: string; job: TaxonomyJob },
  ): Promise<{
    batchId: string
    version: number
    tagId?: number
    applied: boolean
  }> {
    const now = nowSeconds(this.options)
    const state = await this.repository.loadState()
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
    if (
      state.circuitState !== 'closed' ||
      !['gradual', 'autonomous'].includes(state.mode)
    ) {
      throw new Error('Autonomous ontology publication is not enabled')
    }
    if (state.publishedVersion !== mutation.expectedVersion) {
      throw new Error('Taxonomy version changed before publication')
    }
    const suffix = crypto.randomUUID()
    const batchId = `taxonomy:${suffix}`
    const eventId = `taxonomy-event:${suffix}`
    const common = {
      batchId,
      eventId,
      expectedVersion: mutation.expectedVersion,
      policy,
      releaseSha: releaseSha(this.env),
      actorId,
      now,
      application,
    }
    if (mutation.kind === 'canonical') {
      const normalizedConcept = normalizeTaxonomyTag(mutation.normalizedConcept)
      const slug = normalizeProposedSlug(mutation.proposedSlug)
      const evidenceCount =
        await this.repository.evidenceSiteCount(normalizedConcept)
      if (evidenceCount < policy.novelEvidenceSiteThreshold) {
        throw new Error('Novel concept has insufficient distinct-site evidence')
      }
      const tagId = await this.repository.publishCanonical({
        ...common,
        name: mutation.proposedName.trim(),
        slug,
        normalizedConcept,
        evidenceThreshold: policy.novelEvidenceSiteThreshold,
      })
      return {
        batchId,
        version: mutation.expectedVersion + 1,
        tagId,
        applied: true,
      }
    }
    if (mutation.kind === 'alias') {
      const alias = normalizeTaxonomyTag(mutation.alias)
      if (!alias || alias.length > 80) throw new TypeError('Invalid alias')
      await this.repository.publishAlias({ ...common, ...mutation, alias })
    } else if (mutation.kind === 'parent') {
      const edges = await this.repository.hierarchyEdges()
      if (
        !graphAcceptsParent(
          edges,
          mutation.parentTagId,
          mutation.childTagId,
          policy.hierarchyMaxDepth,
          policy.hierarchyMaxFanout,
        )
      ) {
        throw new Error('Parent edge violates cycle, depth, or fanout policy')
      }
      await this.repository.publishParent({ ...common, ...mutation })
    } else {
      if (mutation.sourceTagId === mutation.targetTagId) {
        throw new Error('Cannot merge a tag into itself')
      }
      const target = await this.repository.tagRecord(mutation.targetTagId)
      if (!target) throw new Error('Merge target tag not found')
      const edges = (await this.repository.hierarchyEdges()).flatMap(
        ({ parentId, childId }) => {
          const edge = {
            parentId:
              parentId === mutation.sourceTagId
                ? mutation.targetTagId
                : parentId,
            childId:
              childId === mutation.sourceTagId ? mutation.targetTagId : childId,
          }
          return edge.parentId === edge.childId ? [] : [edge]
        },
      )
      let accepted: Array<{ parentId: number; childId: number }> = []
      for (const edge of edges) {
        if (
          !graphAcceptsParent(
            accepted,
            edge.parentId,
            edge.childId,
            policy.hierarchyMaxDepth,
            policy.hierarchyMaxFanout,
          )
        ) {
          throw new Error(
            'Merge would violate hierarchy cycle, depth, or fanout policy',
          )
        }
        accepted = [...accepted, edge]
      }
      await this.repository.publishMerge({
        ...common,
        ...mutation,
        expectedTargetRevision: target.revision,
      })
    }
    return { batchId, version: mutation.expectedVersion + 1, applied: true }
  }

  async correctTag(input: {
    id: number
    name: string
    aliases: string[]
    parents: string[]
    actorId: string
  }): Promise<{ version: number; batchId: string }> {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new TypeError('Invalid tag name.')
    const now = nowSeconds(this.options)
    const [state, current] = await Promise.all([
      this.repository.loadState(),
      this.repository.tagRecord(input.id),
    ])
    if (!current || current.status !== 'active')
      throw new Error('Tag not found.')
    const aliases = [
      ...new Set(
        input.aliases.flatMap((alias) => {
          const normalized = normalizeTaxonomyTag(alias)
          return normalized ? [normalized] : []
        }),
      ),
    ]
    if (aliases.some((alias) => alias.length > 80))
      throw new TypeError('Invalid alias.')
    const parentSlugs = [
      ...new Set(
        input.parents.flatMap((parent) => {
          const normalized = normalizeTaxonomyTag(parent)
          return normalized ? [normalized] : []
        }),
      ),
    ]
    const [parentRows, oldAliases, oldParents] = await Promise.all([
      parentSlugs.length
        ? this.repository.db
            .prepare(
              `SELECT id, slug FROM tags WHERE canonical = 1 AND status = 'active'
             AND slug IN (${parentSlugs.map(() => '?').join(',')})`,
            )
            .bind(...parentSlugs)
            .all<{ id: number; slug: string }>()
        : Promise.resolve({
            results: [] as Array<{ id: number; slug: string }>,
          }),
      this.repository.db
        .prepare(
          'SELECT alias FROM tag_aliases WHERE tag_id = ? ORDER BY alias',
        )
        .bind(input.id)
        .all<{ alias: string }>(),
      this.repository.db
        .prepare(
          `SELECT parent_tag_id AS parentId FROM tag_parents
           WHERE child_tag_id = ? ORDER BY parent_tag_id`,
        )
        .bind(input.id)
        .all<{ parentId: number }>(),
    ])
    if (parentRows.results.length !== parentSlugs.length)
      throw new Error('Every parent must be an active canonical tag.')
    if (parentRows.results.some((parent) => parent.id === input.id))
      throw new Error('A tag cannot parent itself.')
    const [hierarchyEdges, policy] = await Promise.all([
      this.repository.hierarchyEdges(),
      this.repository.loadPolicy(state.activePolicyConfigId),
    ])
    const proposedEdges = hierarchyEdges.filter(
      (edge) => edge.childId !== input.id,
    )
    let edges = proposedEdges
    for (const parent of parentRows.results) {
      if (
        !graphAcceptsParent(
          edges,
          parent.id,
          input.id,
          policy.hierarchyMaxDepth,
          policy.hierarchyMaxFanout,
        )
      ) {
        throw new Error(
          'Parent relationship violates cycle, depth, or fanout policy',
        )
      }
      edges = [...edges, { parentId: parent.id, childId: input.id }]
    }
    const lockResourceKeys = [
      `tag:${input.id}`,
      ...[
        ...new Set([...aliases, ...oldAliases.results.map((row) => row.alias)]),
      ].map((alias) => `alias:${alias}`),
      ...[
        ...new Set([
          ...parentRows.results.map((parent) => parent.id),
          ...oldParents.results.map((parent) => parent.parentId),
        ]),
      ].map((parentId) => `parent:${parentId}:${input.id}`),
    ]
    const activeLocks = await mapSeries(lockResourceKeys, (resourceKey) =>
      this.repository.hasActiveLock(resourceKey),
    )
    const blockedIndex = activeLocks.findIndex(Boolean)
    if (blockedIndex >= 0) {
      throw new Error(
        `Taxonomy correction is blocked by active lock: ${lockResourceKeys[blockedIndex]}`,
      )
    }
    const batchId = `taxonomy:${crypto.randomUUID()}`
    await this.repository.applyAdminTagCorrection({
      tagId: input.id,
      expectedTagRevision: current.revision,
      expectedVersion: state.publishedVersion,
      name,
      aliases,
      parentTagIds: parentRows.results.map((parent) => parent.id),
      lockResourceKeys,
      batchId,
      eventId: `taxonomy-event:${crypto.randomUUID()}`,
      actorId: input.actorId,
      releaseSha: releaseSha(this.env),
      now,
      before: {
        ...current,
        aliases: oldAliases.results.map((row) => row.alias),
        parentTagIds: oldParents.results.map((row) => row.parentId),
      },
    })
    return { version: state.publishedVersion + 1, batchId }
  }

  async correctMerge(input: {
    sourceId: number
    targetId: number
    actorId: string
  }): Promise<{ version: number; batchId: string }> {
    if (input.sourceId === input.targetId)
      throw new Error('Cannot merge a tag into itself.')
    const now = nowSeconds(this.options)
    const [
      state,
      source,
      target,
      aliases,
      sourceEdges,
      sourceEdgeLocks,
      affectedRows,
    ] = await Promise.all([
      this.repository.loadState(),
      this.repository.tagRecord(input.sourceId),
      this.repository.tagRecord(input.targetId),
      this.repository.db
        .prepare(
          'SELECT alias FROM tag_aliases WHERE tag_id = ? ORDER BY alias LIMIT 501',
        )
        .bind(input.sourceId)
        .all<{ alias: string }>(),
      this.repository.db
        .prepare(
          `SELECT parent_tag_id AS parentId, child_tag_id AS childId
           FROM tag_parents WHERE parent_tag_id = ? OR child_tag_id = ?
           ORDER BY parent_tag_id, child_tag_id LIMIT 501`,
        )
        .bind(input.sourceId, input.sourceId)
        .all<{ parentId: number; childId: number }>(),
      this.repository.db
        .prepare(
          `SELECT resource_key AS resourceKey, tag_id AS tagId,
                    related_tag_id AS relatedTagId FROM taxonomy_locks
             WHERE released_at IS NULL AND scope = 'parent_edge'
               AND (tag_id = ? OR related_tag_id = ?)
             ORDER BY resource_key LIMIT 501`,
        )
        .bind(input.sourceId, input.sourceId)
        .all<{ resourceKey: string; tagId: number; relatedTagId: number }>(),
      this.repository.db
        .prepare(
          `SELECT (SELECT count(*) FROM site_tags WHERE tag_id = ?)
                + (SELECT count(*) FROM tag_aliases WHERE tag_id = ?)
                + (SELECT count(*) FROM tag_parents WHERE parent_tag_id = ? OR child_tag_id = ?)
             AS count`,
        )
        .bind(input.sourceId, input.sourceId, input.sourceId, input.sourceId)
        .first<{ count: number }>(),
    ])
    if (
      !source ||
      source.status !== 'active' ||
      !target ||
      target.status !== 'active'
    )
      throw new Error('Valid source and target tags are required.')
    if (!target.canonical) throw new Error('Merge target must be canonical.')
    if (!affectedRows || affectedRows.count > 500)
      throw new Error('Admin merge exceeds the maximum of 500 affected rows.')
    const [policy, hierarchyEdges] = await Promise.all([
      this.repository.loadPolicy(state.activePolicyConfigId),
      this.repository.hierarchyEdges(),
    ])
    const remapped = hierarchyEdges.flatMap(({ parentId, childId }) => {
      const edge = {
        parentId: parentId === input.sourceId ? input.targetId : parentId,
        childId: childId === input.sourceId ? input.targetId : childId,
      }
      return edge.parentId === edge.childId ? [] : [edge]
    })
    let accepted: Array<{ parentId: number; childId: number }> = []
    for (const edge of remapped) {
      if (
        !graphAcceptsParent(
          accepted,
          edge.parentId,
          edge.childId,
          policy.hierarchyMaxDepth,
          policy.hierarchyMaxFanout,
        )
      )
        throw new Error(
          'Merge would violate hierarchy cycle, depth, or fanout policy',
        )
      accepted = [...accepted, edge]
    }
    const normalizedSourceName = normalizeTaxonomyTag(source.name)
    const alias =
      normalizedSourceName === source.slug ||
      normalizedSourceName === target.slug
        ? null
        : normalizedSourceName
    const lockResourceKeys = [
      `merge:${input.sourceId}:${input.targetId}`,
      `tag:${input.sourceId}`,
      `tag:${input.targetId}`,
      ...(alias ? [`alias:${alias}`] : []),
      ...aliases.results.map((row) => `alias:${row.alias}`),
      ...sourceEdges.results.flatMap((edge) => {
        const parentId =
          edge.parentId === input.sourceId ? input.targetId : edge.parentId
        const childId =
          edge.childId === input.sourceId ? input.targetId : edge.childId
        return parentId === childId ? [] : [`parent:${parentId}:${childId}`]
      }),
    ]
    const originalSourceEdgeKeys = new Set(
      sourceEdgeLocks.results.map((lock) => lock.resourceKey),
    )
    const uncheckedResourceKeys = lockResourceKeys.filter(
      (resourceKey) =>
        !originalSourceEdgeKeys.has(resourceKey) &&
        !sourceEdgeLocks.results.some(
          ({ tagId, relatedTagId }) =>
            resourceKey ===
            `parent:${tagId === input.sourceId ? input.targetId : tagId}:${
              relatedTagId === input.sourceId ? input.targetId : relatedTagId
            }`,
        ),
    )
    const activeLocks = await mapSeries(uncheckedResourceKeys, (resourceKey) =>
      this.repository.hasActiveLock(resourceKey),
    )
    const blockedIndex = activeLocks.findIndex(Boolean)
    if (blockedIndex >= 0) {
      throw new Error(
        `Taxonomy merge is blocked by active lock: ${uncheckedResourceKeys[blockedIndex]}`,
      )
    }
    const batchId = `taxonomy:${crypto.randomUUID()}`
    await this.repository.applyAdminMerge({
      sourceTagId: input.sourceId,
      targetTagId: input.targetId,
      expectedSourceRevision: source.revision,
      expectedTargetRevision: target.revision,
      expectedVersion: state.publishedVersion,
      alias,
      lockResourceKeys: [...new Set(lockResourceKeys)],
      batchId,
      eventId: `taxonomy-event:${crypto.randomUUID()}`,
      actorId: input.actorId,
      releaseSha: releaseSha(this.env),
      now,
      before: {
        source,
        target,
        aliases: aliases.results,
        edges: sourceEdges.results,
      },
    })
    return { version: state.publishedVersion + 1, batchId }
  }

  async createLock(input: {
    scope: 'site_assignment' | 'tag' | 'alias' | 'merge' | 'parent_edge'
    siteId?: number
    tagId: number
    relatedTagId?: number
    alias?: string
    reason: string
    actorId: string
  }): Promise<string> {
    const normalizedAlias = input.alias
      ? normalizeTaxonomyTag(input.alias)
      : null
    const resourceKey =
      input.scope === 'site_assignment'
        ? `site:${input.siteId}:tag:${input.tagId}`
        : input.scope === 'tag'
          ? `tag:${input.tagId}`
          : input.scope === 'alias'
            ? `alias:${normalizedAlias}`
            : `${input.scope === 'parent_edge' ? 'parent' : 'merge'}:${input.tagId}:${input.relatedTagId}`
    const id = `taxonomy-lock:${crypto.randomUUID()}`
    const now = nowSeconds(this.options)
    await this.repository.auditControlPlane(
      'lock_created',
      'taxonomy_lock',
      id,
      {},
      { scope: input.scope, resourceKey, reason: input.reason },
      now,
      releaseSha(this.env),
      input.actorId,
      this.repository.db
        .prepare(
          `INSERT INTO taxonomy_locks
         (id, scope, resource_key, site_id, tag_id, related_tag_id, alias, reason,
          revision, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          id,
          input.scope,
          resourceKey,
          input.siteId ?? null,
          input.tagId,
          input.relatedTagId ?? null,
          normalizedAlias,
          input.reason,
          input.actorId,
          now,
        ),
    )
    return id
  }

  async releaseLock(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<boolean> {
    const existing = await this.repository.db
      .prepare(
        'SELECT id FROM taxonomy_locks WHERE id = ? AND released_at IS NULL',
      )
      .bind(id)
      .first('id')
    if (!existing) return false
    const now = nowSeconds(this.options)
    await this.repository.auditControlPlane(
      'lock_released',
      'taxonomy_lock',
      id,
      { active: true },
      { active: false, reason },
      now,
      releaseSha(this.env),
      actorId,
      [
        this.repository.db
          .prepare(
            `SELECT CASE WHEN EXISTS (SELECT 1 FROM taxonomy_locks
                                     WHERE id = ? AND released_at IS NULL)
             THEN 1 ELSE json_extract('lock release guard failed', '$') END`,
          )
          .bind(id),
        this.repository.db
          .prepare(
            `UPDATE taxonomy_locks SET released_by = ?, released_at = ?, release_reason = ?
             WHERE id = ? AND released_at IS NULL`,
          )
          .bind(actorId, now, reason, id),
        this.repository.db
          .prepare(
            `UPDATE tags SET automation_locked = 0, revision = revision + 1,
             updated_at = ?
             WHERE automation_locked = 1
               AND id IN (
                 SELECT tag_id FROM taxonomy_locks WHERE id = ? AND tag_id IS NOT NULL
                 UNION
                 SELECT related_tag_id FROM taxonomy_locks
                 WHERE id = ? AND related_tag_id IS NOT NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM taxonomy_locks active
                 WHERE active.released_at IS NULL
                   AND active.scope <> 'site_assignment'
                   AND (active.tag_id = tags.id OR active.related_tag_id = tags.id)
               )`,
          )
          .bind(now, id, id),
      ],
    )
    return true
  }

  async rollbackEvent(
    eventId: string,
    actorId: string,
  ): Promise<RollbackResult> {
    return this.rollback('event', eventId, actorId)
  }

  async rollbackSite(siteId: number, actorId: string): Promise<RollbackResult> {
    return this.rollback('site', String(siteId), actorId)
  }

  async rollbackBatch(
    batchId: string,
    actorId: string,
  ): Promise<RollbackResult> {
    return this.rollback('batch', batchId, actorId)
  }

  private async rollback(
    scope: 'event' | 'site' | 'batch',
    value: string,
    actorId: string,
  ): Promise<RollbackResult> {
    const now = nowSeconds(this.options)
    const state = await this.repository.loadState()
    const batchId = `taxonomy-rollback:${crypto.randomUUID()}`
    const query =
      scope === 'event'
        ? `SELECT * FROM taxonomy_audit_events WHERE id = ?`
        : scope === 'batch'
          ? `SELECT * FROM taxonomy_audit_events WHERE batch_id = ?
             AND event_type IN ('assignment_add','assignment_remove','alias_created','parent_created')
             ORDER BY created_at DESC, id DESC`
          : `SELECT * FROM taxonomy_audit_events WHERE entity_type = 'site_assignment'
             AND event_type IN ('assignment_add','assignment_remove') AND entity_id LIKE ?
             ORDER BY created_at DESC, id DESC`
    const parameter = scope === 'site' ? `${value}:%` : value
    const result = await this.repository.db
      .prepare(query)
      .bind(parameter)
      .all<Row>()
    const events = result.results
    if (!events.length) throw new Error('No rollback events found')
    if (
      events.every((event) =>
        ['assignment_add', 'assignment_remove'].includes(
          String(event.event_type),
        ),
      )
    ) {
      return this.rollbackAssignments({
        scope,
        value,
        actorId,
        batchId,
        now,
        stateVersion: state.publishedVersion,
        events,
      })
    }
    const statements: D1PreparedStatement[] = [
      this.repository.db
        .prepare(
          `SELECT CASE WHEN (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?
           THEN 1 ELSE json_extract('rollback taxonomy version changed', '$') END`,
        )
        .bind(state.publishedVersion),
      this.repository.db
        .prepare(
          `INSERT INTO taxonomy_change_batches
           (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
            resulting_taxonomy_version, summary, applied_at, created_at)
           VALUES (?, 'rollback', 'rolling_back', 'admin', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          batchId,
          actorId,
          state.publishedVersion,
          state.publishedVersion + 1,
          `Compensating rollback for ${scope}:${value}`,
          now,
          now,
        ),
    ]
    const preparedEvents = await mapSettledSeries(events, async (event) => {
      const eventId = String(event.id)
      const entityType = String(event.entity_type)
      const entityId = String(event.entity_id)
      const eventType = String(event.event_type)
      const before = JSON.parse(String(event.before)) as Record<string, unknown>
      const after = JSON.parse(String(event.after)) as Record<string, unknown>
      const laterPromise = this.repository.db
        .prepare(
          `SELECT id FROM taxonomy_audit_events
             WHERE entity_type = ? AND entity_id = ?
             AND (created_at > ? OR (created_at = ? AND id > ?))
             AND rollback_of_event_id IS NULL LIMIT 1`,
        )
        .bind(
          entityType,
          entityId,
          Number(event.created_at),
          Number(event.created_at),
          eventId,
        )
        .first('id')
      const statementsPromise = (async () => {
        const eventStatements: D1PreparedStatement[] = []
        if (
          eventType === 'assignment_add' ||
          eventType === 'assignment_remove'
        ) {
          const [siteId, tagId] = entityId.split(':').map(Number)
          if (!siteId || !tagId) {
            throw new Error('Invalid assignment audit entity')
          }
          const [lockedResult, currentTagResult, currentResult] =
            await Promise.allSettled([
              this.repository.db
                .prepare(
                  `SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
                     AND resource_key IN (?, ?) LIMIT 1`,
                )
                .bind(`site:${siteId}:tag:${tagId}`, `tag:${tagId}`)
                .first('1'),
              this.repository.db
                .prepare('SELECT status, revision FROM tags WHERE id = ?')
                .bind(tagId)
                .first<Row>(),
              this.repository.db
                .prepare(
                  `SELECT raw_name AS rawName, source, decision_id AS decisionId,
                            revision, created_at AS createdAt, updated_at AS updatedAt
                     FROM site_tags WHERE site_id = ? AND tag_id = ?`,
                )
                .bind(siteId, tagId)
                .first<Row>(),
            ])
          if (lockedResult.status === 'rejected') throw lockedResult.reason
          if (lockedResult.value) throw new Error('Rollback target is locked')
          const beforeTag = assignmentTagProvenance(before, 'before', tagId)
          const afterTag = assignmentTagProvenance(after, 'after', tagId)
          if (beforeTag.revision !== afterTag.revision) {
            throw new Error('Assignment audit tag provenance is inconsistent')
          }
          if (currentTagResult.status === 'rejected') {
            throw currentTagResult.reason
          }
          const currentTag = currentTagResult.value
          if (
            !currentTag ||
            currentTag.status !== afterTag.status ||
            currentTag.revision !== afterTag.revision
          ) {
            throw new Error(
              'Rollback tag status or revision no longer matches audited state',
            )
          }
          if (currentResult.status === 'rejected') throw currentResult.reason
          const current = currentResult.value
          eventStatements.push(
            this.repository.db
              .prepare(
                `SELECT CASE WHEN EXISTS (
                     SELECT 1 FROM tags WHERE id = ? AND status = ? AND revision = ?
                   ) THEN 1 ELSE json_extract('assignment rollback tag changed', '$') END`,
              )
              .bind(tagId, afterTag.status, afterTag.revision),
          )
          if (eventType === 'assignment_add') {
            if (before.assigned !== false || after.assigned !== true) {
              throw new Error('Assignment add audit state is inconsistent')
            }
            const expected = assignmentProvenance(after, 'applied')
            if (!assignmentMatches(current, expected)) {
              throw new Error(
                'Rollback target provenance or revision no longer matches audited state',
              )
            }
            eventStatements.push(
              this.repository.db
                .prepare(
                  `SELECT CASE WHEN EXISTS (
                       SELECT 1 FROM site_tags WHERE site_id = ? AND tag_id = ?
                         AND raw_name = ? AND source = 'automation'
                         AND decision_id IS ? AND revision = ?
                         AND created_at = ? AND updated_at = ?
                     ) THEN 1 ELSE json_extract('assignment rollback provenance changed', '$') END`,
                )
                .bind(
                  siteId,
                  tagId,
                  expected.rawName,
                  expected.decisionId,
                  expected.revision,
                  expected.createdAt,
                  expected.updatedAt,
                ),
              this.repository.db
                .prepare(
                  `DELETE FROM site_tags WHERE site_id = ? AND tag_id = ?
                     AND raw_name = ? AND source = 'automation'
                     AND decision_id IS ? AND revision = ?
                     AND created_at = ? AND updated_at = ?`,
                )
                .bind(
                  siteId,
                  tagId,
                  expected.rawName,
                  expected.decisionId,
                  expected.revision,
                  expected.createdAt,
                  expected.updatedAt,
                ),
            )
          } else {
            if (before.assigned !== true || after.assigned !== false) {
              throw new Error('Assignment removal audit state is inconsistent')
            }
            const removed = assignmentProvenance(before, 'removed')
            if (current) {
              throw new Error(
                'Rollback target no longer matches audited removal',
              )
            }
            eventStatements.push(
              this.repository.db
                .prepare(
                  `SELECT CASE WHEN NOT EXISTS (
                       SELECT 1 FROM site_tags WHERE site_id = ? AND tag_id = ?
                     ) THEN 1 ELSE json_extract('assignment rollback target was reassigned', '$') END`,
                )
                .bind(siteId, tagId),
              this.repository.db
                .prepare(
                  `INSERT INTO site_tags
                     (site_id, tag_id, raw_name, source, decision_id, revision,
                      created_at, updated_at)
                     VALUES (?, ?, ?, 'automation', ?, ?, ?, ?)`,
                )
                .bind(
                  siteId,
                  tagId,
                  removed.rawName,
                  removed.decisionId,
                  removed.revision,
                  removed.createdAt,
                  removed.updatedAt,
                ),
            )
          }
        } else if (eventType === 'alias_created') {
          const targetTagId = Number(after.targetTagId)
          const targetTagRevision = Number(after.targetTagRevision)
          if (
            !Number.isSafeInteger(targetTagRevision) ||
            targetTagRevision < 1
          ) {
            throw new Error(
              'Alias audit event lacks rollback revision metadata',
            )
          }
          const [locked, aliasTarget, currentRevision] = await Promise.all([
            this.repository.db
              .prepare(
                `SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
                   AND resource_key IN (?, ?) LIMIT 1`,
              )
              .bind(`alias:${entityId}`, `tag:${targetTagId}`)
              .first('1'),
            this.repository.db
              .prepare('SELECT tag_id FROM tag_aliases WHERE alias = ?')
              .bind(entityId)
              .first<number>('tag_id'),
            this.repository.db
              .prepare('SELECT revision FROM tags WHERE id = ?')
              .bind(targetTagId)
              .first<number>('revision'),
          ])
          if (locked) throw new Error('Rollback target is locked')
          if (aliasTarget !== targetTagId) {
            throw new Error('Alias no longer matches audited state')
          }
          if (currentRevision !== targetTagRevision) {
            throw new Error(
              'Alias target revision changed after the audited event',
            )
          }
          eventStatements.push(
            this.repository.db
              .prepare('DELETE FROM tag_aliases WHERE alias = ?')
              .bind(entityId),
            this.repository.db
              .prepare(
                'UPDATE tags SET revision = revision + 1, updated_at = ? WHERE id = ?',
              )
              .bind(now, targetTagId),
          )
        } else if (eventType === 'parent_created') {
          const parentTagId = Number(after.parentTagId)
          const childTagId = Number(after.childTagId)
          const childTagRevision = Number(after.childTagRevision)
          if (!Number.isSafeInteger(childTagRevision) || childTagRevision < 1) {
            throw new Error(
              'Parent audit event lacks rollback revision metadata',
            )
          }
          const [locked, exists, currentRevision] = await Promise.all([
            this.repository.db
              .prepare(
                `SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
                   AND resource_key IN (?, ?, ?) LIMIT 1`,
              )
              .bind(
                `parent:${parentTagId}:${childTagId}`,
                `tag:${parentTagId}`,
                `tag:${childTagId}`,
              )
              .first('1'),
            this.repository.db
              .prepare(
                'SELECT 1 FROM tag_parents WHERE parent_tag_id = ? AND child_tag_id = ?',
              )
              .bind(parentTagId, childTagId)
              .first('1'),
            this.repository.db
              .prepare('SELECT revision FROM tags WHERE id = ?')
              .bind(childTagId)
              .first<number>('revision'),
          ])
          if (locked) throw new Error('Rollback target is locked')
          if (!exists) {
            throw new Error('Parent edge no longer matches audited state')
          }
          if (currentRevision !== childTagRevision) {
            throw new Error(
              'Parent child revision changed after the audited event',
            )
          }
          eventStatements.push(
            this.repository.db
              .prepare(
                'DELETE FROM tag_parents WHERE parent_tag_id = ? AND child_tag_id = ?',
              )
              .bind(parentTagId, childTagId),
            this.repository.db
              .prepare(
                'UPDATE tags SET revision = revision + 1, updated_at = ? WHERE id = ?',
              )
              .bind(now, childTagId),
          )
        } else {
          throw new Error(`Unsafe rollback event type: ${eventType}`)
        }
        return eventStatements
      })()
      const [laterResult, statementsResult] = await Promise.allSettled([
        laterPromise,
        statementsPromise,
      ])
      if (laterResult.status === 'rejected') throw laterResult.reason
      if (laterResult.value) {
        throw new Error(
          `Rollback has a later dependent event: ${String(laterResult.value)}`,
        )
      }
      if (statementsResult.status === 'rejected') throw statementsResult.reason
      statementsResult.value.push(
        this.repository.db
          .prepare(
            `INSERT INTO taxonomy_audit_events
               (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
                taxonomy_version_before, taxonomy_version_after, scores, evidence, before,
                after, release_sha, rollback_of_event_id, compensates_event_id, created_at)
               VALUES (?, ?, 'compensating_rollback', ?, ?, 'admin', ?, ?, ?, '{}', '', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `taxonomy-compensation:${crypto.randomUUID()}`,
            batchId,
            entityType,
            entityId,
            actorId,
            state.publishedVersion,
            state.publishedVersion + 1,
            stableJson(after),
            stableJson(before),
            releaseSha(this.env),
            eventId,
            eventId,
            now,
          ),
      )
      return statementsResult.value
    })
    for (const preparedEvent of preparedEvents) {
      if (preparedEvent.status === 'rejected') throw preparedEvent.reason
      statements.push(...preparedEvent.value)
    }
    statements.push(
      this.repository.db
        .prepare(
          `UPDATE taxonomy_state SET published_version = ?, updated_at = ?
           WHERE id = 1 AND published_version = ?`,
        )
        .bind(state.publishedVersion + 1, now, state.publishedVersion),
    )
    if (scope === 'batch') {
      statements.push(
        this.repository.db
          .prepare(
            `UPDATE taxonomy_change_batches SET status = 'rolled_back', completed_at = ?
             WHERE id = ? AND status = 'applied'`,
          )
          .bind(now, value),
      )
    }
    statements.push(
      this.repository.db
        .prepare(
          `UPDATE taxonomy_change_batches SET status = 'applied', completed_at = ?
           WHERE id = ? AND status = 'rolling_back'`,
        )
        .bind(now, batchId),
    )
    await this.repository.db.batch(statements)
    return {
      batchId,
      status: 'applied',
      compensatedEvents: events.length,
    }
  }

  private async rollbackAssignments(input: {
    scope: 'event' | 'site' | 'batch'
    value: string
    actorId: string
    batchId: string
    now: number
    stateVersion: number
    events: Row[]
  }): Promise<RollbackResult> {
    const seenEntities = new Set<string>()
    const targets = input.events.map((event) => {
      const entityId = String(event.entity_id)
      const [siteId, tagId] = entityId.split(':').map(Number)
      if (!siteId || !tagId) throw new Error('Invalid assignment audit entity')
      return {
        eventId: String(event.id),
        entityId,
        siteId,
        tagId,
        createdAt: Number(event.created_at),
      }
    })
    const targetIssue = await this.repository.db
      .prepare(
        `WITH targets AS (
           SELECT json_extract(value, '$.eventId') AS event_id,
                  json_extract(value, '$.entityId') AS entity_id,
                  json_extract(value, '$.siteId') AS site_id,
                  json_extract(value, '$.tagId') AS tag_id,
                  json_extract(value, '$.createdAt') AS created_at
           FROM json_each(?)
         )
         SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM targets target JOIN taxonomy_audit_events later
               ON later.entity_type = 'site_assignment'
              AND later.entity_id = target.entity_id
              AND (later.created_at > target.created_at OR
                   (later.created_at = target.created_at AND later.id > target.event_id))
              AND later.rollback_of_event_id IS NULL
              AND later.id NOT IN (SELECT event_id FROM targets)
           ) THEN 'Rollback has a later dependent event'
           WHEN EXISTS (
             SELECT 1 FROM targets target JOIN taxonomy_locks lock
               ON lock.released_at IS NULL AND lock.resource_key IN (
                    'site:' || target.site_id || ':tag:' || target.tag_id,
                    'tag:' || target.tag_id)
           ) THEN 'Rollback target is locked'
           ELSE NULL END AS issue`,
      )
      .bind(stableJson(targets))
      .first<string>('issue')
    if (targetIssue) throw new Error(targetIssue)
    const rows = input.events.map((event) => {
      const eventId = String(event.id)
      const entityId = String(event.entity_id)
      const eventType = String(event.event_type)
      const [siteId, tagId] = entityId.split(':').map(Number)
      if (!siteId || !tagId) throw new Error('Invalid assignment audit entity')
      if (seenEntities.has(entityId)) {
        throw new Error('Rollback scope has multiple events for one assignment')
      }
      seenEntities.add(entityId)
      const before = JSON.parse(String(event.before)) as Record<string, unknown>
      const after = JSON.parse(String(event.after)) as Record<string, unknown>
      const beforeTag = assignmentTagProvenance(before, 'before', tagId)
      const afterTag = assignmentTagProvenance(after, 'after', tagId)
      if (beforeTag.revision !== afterTag.revision) {
        throw new Error('Assignment audit tag provenance is inconsistent')
      }
      const assignment =
        eventType === 'assignment_add'
          ? assignmentProvenance(after, 'applied')
          : assignmentProvenance(before, 'removed')
      if (
        (eventType === 'assignment_add' &&
          (before.assigned !== false || after.assigned !== true)) ||
        (eventType === 'assignment_remove' &&
          (before.assigned !== true || after.assigned !== false))
      ) {
        throw new Error('Assignment audit state is inconsistent')
      }
      return {
        eventId,
        compensationId: `taxonomy-compensation:${crypto.randomUUID()}`,
        entityId,
        siteId,
        tagId,
        action: eventType === 'assignment_add' ? 'delete' : 'insert',
        createdAt: Number(event.created_at),
        tagRevision: afterTag.revision,
        assignment,
        before: stableJson(before),
        after: stableJson(after),
      }
    })
    const decisions = stableJson(rows)
    const preflight = await this.repository.db
      .prepare(
        `WITH decisions AS (
           SELECT json_extract(value, '$.eventId') AS event_id,
                  json_extract(value, '$.entityId') AS entity_id,
                  json_extract(value, '$.siteId') AS site_id,
                  json_extract(value, '$.tagId') AS tag_id,
                  json_extract(value, '$.action') AS action,
                  json_extract(value, '$.createdAt') AS created_at,
                  json_extract(value, '$.tagRevision') AS tag_revision,
                  json_extract(value, '$.assignment.rawName') AS raw_name,
                  json_extract(value, '$.assignment.decisionId') AS decision_id,
                  json_extract(value, '$.assignment.revision') AS revision,
                  json_extract(value, '$.assignment.createdAt') AS assignment_created_at,
                  json_extract(value, '$.assignment.updatedAt') AS assignment_updated_at
           FROM json_each(?)
         )
         SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM decisions decision JOIN taxonomy_audit_events later
               ON later.entity_type = 'site_assignment'
              AND later.entity_id = decision.entity_id
              AND (later.created_at > decision.created_at OR
                   (later.created_at = decision.created_at AND later.id > decision.event_id))
              AND later.rollback_of_event_id IS NULL
              AND later.id NOT IN (SELECT event_id FROM decisions)
           ) THEN 'Rollback has a later dependent event'
           WHEN EXISTS (
             SELECT 1 FROM decisions decision JOIN taxonomy_locks lock
               ON lock.released_at IS NULL AND lock.resource_key IN (
                    'site:' || decision.site_id || ':tag:' || decision.tag_id,
                    'tag:' || decision.tag_id)
           ) THEN 'Rollback target is locked'
           WHEN EXISTS (
             SELECT 1 FROM decisions decision LEFT JOIN tags tag ON tag.id = decision.tag_id
             WHERE tag.id IS NULL OR tag.status <> 'active'
                OR tag.revision <> decision.tag_revision
           ) THEN 'Rollback tag status or revision no longer matches audited state'
           WHEN EXISTS (
             SELECT 1 FROM decisions decision
             WHERE (decision.action = 'delete' AND NOT EXISTS (
                     SELECT 1 FROM site_tags assignment
                     WHERE assignment.site_id = decision.site_id
                       AND assignment.tag_id = decision.tag_id
                       AND assignment.raw_name = decision.raw_name
                       AND assignment.source = 'automation'
                       AND assignment.decision_id IS decision.decision_id
                       AND assignment.revision = decision.revision
                       AND assignment.created_at = decision.assignment_created_at
                       AND assignment.updated_at = decision.assignment_updated_at))
                OR (decision.action = 'insert' AND EXISTS (
                     SELECT 1 FROM site_tags assignment
                     WHERE assignment.site_id = decision.site_id
                       AND assignment.tag_id = decision.tag_id))
           ) THEN 'Rollback target provenance or revision no longer matches audited state'
           ELSE NULL END AS issue`,
      )
      .bind(decisions)
      .first<string>('issue')
    if (preflight) throw new Error(preflight)

    const guardSql = `SELECT CASE WHEN
      (SELECT published_version FROM taxonomy_state WHERE id = 1) = ?1
      AND NOT EXISTS (
        WITH decisions AS (
          SELECT json_extract(value, '$.eventId') AS event_id,
                 json_extract(value, '$.entityId') AS entity_id,
                 json_extract(value, '$.siteId') AS site_id,
                 json_extract(value, '$.tagId') AS tag_id,
                 json_extract(value, '$.action') AS action,
                 json_extract(value, '$.createdAt') AS created_at,
                 json_extract(value, '$.tagRevision') AS tag_revision,
                 json_extract(value, '$.assignment.rawName') AS raw_name,
                 json_extract(value, '$.assignment.decisionId') AS decision_id,
                 json_extract(value, '$.assignment.revision') AS revision,
                 json_extract(value, '$.assignment.createdAt') AS assignment_created_at,
                 json_extract(value, '$.assignment.updatedAt') AS assignment_updated_at
          FROM json_each(?2)
        )
        SELECT 1 FROM decisions decision
        WHERE EXISTS (
          SELECT 1 FROM taxonomy_audit_events later
          WHERE later.entity_type = 'site_assignment'
            AND later.entity_id = decision.entity_id
            AND (later.created_at > decision.created_at OR
                 (later.created_at = decision.created_at AND later.id > decision.event_id))
            AND later.rollback_of_event_id IS NULL
            AND later.id NOT IN (SELECT event_id FROM decisions)
        ) OR EXISTS (
          SELECT 1 FROM taxonomy_locks lock WHERE lock.released_at IS NULL
            AND lock.resource_key IN (
              'site:' || decision.site_id || ':tag:' || decision.tag_id,
              'tag:' || decision.tag_id)
        ) OR NOT EXISTS (
          SELECT 1 FROM tags tag WHERE tag.id = decision.tag_id
            AND tag.status = 'active' AND tag.revision = decision.tag_revision
        ) OR (decision.action = 'delete' AND NOT EXISTS (
          SELECT 1 FROM site_tags assignment
          WHERE assignment.site_id = decision.site_id
            AND assignment.tag_id = decision.tag_id
            AND assignment.raw_name = decision.raw_name
            AND assignment.source = 'automation'
            AND assignment.decision_id IS decision.decision_id
            AND assignment.revision = decision.revision
            AND assignment.created_at = decision.assignment_created_at
            AND assignment.updated_at = decision.assignment_updated_at
        )) OR (decision.action = 'insert' AND EXISTS (
          SELECT 1 FROM site_tags assignment WHERE assignment.site_id = decision.site_id
            AND assignment.tag_id = decision.tag_id
        ))
      )
      THEN 1 ELSE json_extract('assignment rollback guard failed', '$') END`
    const statements: D1PreparedStatement[] = [
      this.repository.db.prepare(guardSql).bind(input.stateVersion, decisions),
      this.repository.db
        .prepare(
          `INSERT INTO taxonomy_change_batches
           (id, kind, status, actor_type, actor_id, expected_taxonomy_version,
            resulting_taxonomy_version, summary, applied_at, created_at)
           VALUES (?, 'rollback', 'rolling_back', 'admin', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.batchId,
          input.actorId,
          input.stateVersion,
          input.stateVersion + 1,
          `Compensating rollback for ${input.scope}:${input.value}`,
          input.now,
          input.now,
        ),
      this.repository.db
        .prepare(
          `DELETE FROM site_tags WHERE EXISTS (
             SELECT 1 FROM json_each(?) decision
             WHERE json_extract(decision.value, '$.action') = 'delete'
               AND site_tags.site_id = json_extract(decision.value, '$.siteId')
               AND site_tags.tag_id = json_extract(decision.value, '$.tagId'))`,
        )
        .bind(decisions),
      this.repository.db
        .prepare(
          `INSERT INTO site_tags
           (site_id, tag_id, raw_name, source, decision_id, revision, created_at, updated_at)
           SELECT json_extract(value, '$.siteId'), json_extract(value, '$.tagId'),
                  json_extract(value, '$.assignment.rawName'), 'automation',
                  json_extract(value, '$.assignment.decisionId'),
                  json_extract(value, '$.assignment.revision'),
                  json_extract(value, '$.assignment.createdAt'),
                  json_extract(value, '$.assignment.updatedAt')
           FROM json_each(?) WHERE json_extract(value, '$.action') = 'insert'`,
        )
        .bind(decisions),
      this.repository.db
        .prepare(
          `INSERT INTO taxonomy_audit_events
           (id, batch_id, event_type, entity_type, entity_id, actor_type, actor_id,
            taxonomy_version_before, taxonomy_version_after, scores, evidence, before,
            after, release_sha, rollback_of_event_id, compensates_event_id, created_at)
           SELECT json_extract(value, '$.compensationId'), ?, 'compensating_rollback',
                  'site_assignment', json_extract(value, '$.entityId'), 'admin', ?, ?, ?,
                  '{}', '', json_extract(value, '$.after'), json_extract(value, '$.before'),
                  ?, json_extract(value, '$.eventId'), json_extract(value, '$.eventId'), ?
           FROM json_each(?)`,
        )
        .bind(
          input.batchId,
          input.actorId,
          input.stateVersion,
          input.stateVersion + 1,
          releaseSha(this.env),
          input.now,
          decisions,
        ),
      this.repository.db
        .prepare(
          `UPDATE taxonomy_state SET published_version = ?, updated_at = ?
           WHERE id = 1 AND published_version = ?`,
        )
        .bind(input.stateVersion + 1, input.now, input.stateVersion),
    ]
    if (input.scope === 'batch') {
      statements.push(
        this.repository.db
          .prepare(
            `UPDATE taxonomy_change_batches SET status = 'rolled_back', completed_at = ?
             WHERE id = ? AND status = 'applied'`,
          )
          .bind(input.now, input.value),
      )
    }
    statements.push(
      this.repository.db
        .prepare(
          `UPDATE taxonomy_change_batches SET status = 'applied', completed_at = ?
           WHERE id = ? AND status = 'rolling_back'`,
        )
        .bind(input.now, input.batchId),
    )
    await this.repository.db.batch(statements)
    return {
      batchId: input.batchId,
      status: 'applied',
      compensatedEvents: rows.length,
    }
  }
}

type Row = Record<string, unknown>

export function createTaxonomyService(
  env: TaxonomyServiceEnv,
  options: RuntimeOptions = {},
): TaxonomyService {
  return new TaxonomyService(env, options)
}
