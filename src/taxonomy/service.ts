import { z } from 'zod'

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
import { TaxonomyRepository } from './repository'
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

export class TaxonomyService {
  readonly repository: TaxonomyRepository
  readonly env: TaxonomyServiceEnv
  readonly options: RuntimeOptions

  constructor(env: TaxonomyServiceEnv, options: RuntimeOptions = {}) {
    this.env = env
    this.options = options
    this.repository = new TaxonomyRepository(env.DB)
  }

  async setMode(mode: TaxonomyMode): Promise<void> {
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
      const requiredVoters = Math.max(
        1,
        providers.filter(({ routingRole }) => routingRole !== 'failover')
          .length,
      )
      const metrics = await this.repository.shadowReadinessMetrics(
        state.modeChangedAt,
        requiredVoters,
      )
      if (
        metrics.samples < Math.max(1, policy.shadowMinimumSamples) ||
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
    await this.repository.setMode(mode, now, releaseSha(this.env), 'admin')
  }

  async resetCircuit(): Promise<void> {
    const now = nowSeconds(this.options)
    await this.repository.closeCircuit(now, releaseSha(this.env), 'admin')
    await this.setMode('shadow')
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

  async disableProvider(providerConfigId: number): Promise<boolean> {
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
      'admin',
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
      timeoutMs: Math.min(config.timeoutMs, 15_000),
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
      actorId,
      nowSeconds(this.options),
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
                (SELECT active_policy_config_id FROM taxonomy_state WHERE id = 1), ?, ?
         FROM taxonomy_policy_configs`,
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

  async activatePolicy(policyConfigId: number): Promise<boolean> {
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
      'admin',
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
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
    const sites = await this.repository.backfillSites(siteId - 1, 1)
    const site = sites.find((value) => value.id === siteId)
    if (!site) return null
    const inputHash = await hashTaxonomyInput({
      siteId: site.id,
      name: site.name,
      url: site.url,
      description: site.description,
      tags: [],
    })
    const classifierVersion = state.activeProviderConfigId ?? 'none'
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

  async backfill(cursor = 0, requestedLimit = 25): Promise<BackfillResult> {
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    const sites = await this.repository.backfillSites(cursor, limit)
    let enqueued = 0
    for (const site of sites) {
      if (await this.enqueueSite(site.id)) enqueued += 1
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
    let retried = 0
    for (const id of ids) {
      const updated = await this.repository.db
        .prepare(
          `UPDATE taxonomy_jobs SET status = 'pending', attempt_count = 0,
           available_at = ?, lease_owner = NULL, lease_token = NULL,
           leased_until = NULL, completed_at = NULL, updated_at = ?,
           last_error_code = NULL, last_error_summary = NULL
           WHERE id = ? AND status IN ('dead', 'settled')`,
        )
        .bind(now, now, id)
        .run()
      if (!updated.meta.changes) continue
      await this.repository.db
        .prepare(
          `UPDATE taxonomy_outbox SET dispatched_at = NULL, available_at = ?,
           lease_token = NULL, leased_until = NULL, last_error = NULL
           WHERE job_id = ?`,
        )
        .bind(now, id)
        .run()
      retried += 1
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
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
    const inputHash = await sha256Hex(stableJson({ concept }))
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
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
    const inputHash = await sha256Hex(
      stableJson({ candidateId, payload: candidate.payload }),
    )
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
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
    const inputHash = await sha256Hex(
      stableJson({
        candidateId: input.candidateId,
        payload: candidate.payload,
      }),
    )
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
      const edges = (await this.repository.hierarchyEdges())
        .map(({ parentId, childId }) => ({
          parentId:
            parentId === mutation.sourceTagId ? mutation.targetTagId : parentId,
          childId:
            childId === mutation.sourceTagId ? mutation.targetTagId : childId,
        }))
        .filter(({ parentId, childId }) => parentId !== childId)
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
    const state = await this.repository.loadState()
    const current = await this.repository.tagRecord(input.id)
    if (!current || current.status !== 'active')
      throw new Error('Tag not found.')
    const aliases = [
      ...new Set(input.aliases.map(normalizeTaxonomyTag).filter(Boolean)),
    ]
    if (aliases.some((alias) => alias.length > 80))
      throw new TypeError('Invalid alias.')
    const parentSlugs = [
      ...new Set(input.parents.map(normalizeTaxonomyTag).filter(Boolean)),
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
    const proposedEdges = (await this.repository.hierarchyEdges()).filter(
      (edge) => edge.childId !== input.id,
    )
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
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
    for (const resourceKey of lockResourceKeys) {
      if (await this.repository.hasActiveLock(resourceKey))
        throw new Error(
          `Taxonomy correction is blocked by active lock: ${resourceKey}`,
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
    const state = await this.repository.loadState()
    const [source, target, aliases, sourceEdges, affectedRows] =
      await Promise.all([
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
    const policy = await this.repository.loadPolicy(state.activePolicyConfigId)
    const remapped = (await this.repository.hierarchyEdges())
      .map(({ parentId, childId }) => ({
        parentId: parentId === input.sourceId ? input.targetId : parentId,
        childId: childId === input.sourceId ? input.targetId : childId,
      }))
      .filter(({ parentId, childId }) => parentId !== childId)
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
    const alias = normalizeTaxonomyTag(source.name)
    const lockResourceKeys = [
      `merge:${input.sourceId}:${input.targetId}`,
      `tag:${input.sourceId}`,
      `tag:${input.targetId}`,
      `alias:${alias}`,
      ...aliases.results.map((row) => `alias:${row.alias}`),
      ...sourceEdges.results
        .map((edge) => ({
          parentId:
            edge.parentId === input.sourceId ? input.targetId : edge.parentId,
          childId:
            edge.childId === input.sourceId ? input.targetId : edge.childId,
        }))
        .filter((edge) => edge.parentId !== edge.childId)
        .map((edge) => `parent:${edge.parentId}:${edge.childId}`),
    ]
    for (const resourceKey of lockResourceKeys) {
      if (await this.repository.hasActiveLock(resourceKey))
        throw new Error(
          `Taxonomy merge is blocked by active lock: ${resourceKey}`,
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
      this.repository.db
        .prepare(
          `UPDATE taxonomy_locks SET released_by = ?, released_at = ?, release_reason = ?
         WHERE id = ? AND released_at IS NULL`,
        )
        .bind(actorId, now, reason, id),
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
          ? `SELECT * FROM taxonomy_audit_events WHERE batch_id = ? ORDER BY created_at DESC, id DESC LIMIT 501`
          : `SELECT * FROM taxonomy_audit_events WHERE entity_type = 'site_assignment' AND entity_id LIKE ? ORDER BY created_at DESC, id DESC LIMIT 501`
    const parameter = scope === 'site' ? `${value}:%` : value
    const result = await this.repository.db
      .prepare(query)
      .bind(parameter)
      .all<Row>()
    const events = result.results
    if (!events.length) throw new Error('No rollback events found')
    if (events.length > 500) {
      throw new Error(
        'Rollback scope exceeds 500 events; split it into smaller scopes',
      )
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
    for (const event of events) {
      const eventId = String(event.id)
      const entityType = String(event.entity_type)
      const entityId = String(event.entity_id)
      const eventType = String(event.event_type)
      const before = JSON.parse(String(event.before)) as Record<string, unknown>
      const after = JSON.parse(String(event.after)) as Record<string, unknown>
      const later = await this.repository.db
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
      if (later)
        throw new Error(
          `Rollback has a later dependent event: ${String(later)}`,
        )
      if (eventType === 'assignment_add' || eventType === 'assignment_remove') {
        const [siteId, tagId] = entityId.split(':').map(Number)
        if (!siteId || !tagId)
          throw new Error('Invalid assignment audit entity')
        const locked = await this.repository.db
          .prepare(
            `SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
             AND resource_key IN (?, ?) LIMIT 1`,
          )
          .bind(`site:${siteId}:tag:${tagId}`, `tag:${tagId}`)
          .first('1')
        if (locked) throw new Error('Rollback target is locked')
        const assigned = Boolean(
          await this.repository.db
            .prepare('SELECT 1 FROM site_tags WHERE site_id = ? AND tag_id = ?')
            .bind(siteId, tagId)
            .first('1'),
        )
        if (assigned !== Boolean(after.assigned)) {
          throw new Error('Rollback target no longer matches audited state')
        }
        statements.push(
          before.assigned === true
            ? this.repository.db
                .prepare(
                  `INSERT INTO site_tags
                   (site_id, tag_id, raw_name, source, revision, created_at, updated_at)
                   SELECT ?, id, name, 'automation', 1, ?, ? FROM tags
                   WHERE id = ? AND status = 'active'`,
                )
                .bind(siteId, now, now, tagId)
            : this.repository.db
                .prepare(
                  'DELETE FROM site_tags WHERE site_id = ? AND tag_id = ?',
                )
                .bind(siteId, tagId),
        )
      } else if (eventType === 'alias_created') {
        const targetTagId = Number(after.targetTagId)
        const targetTagRevision = Number(after.targetTagRevision)
        if (!Number.isSafeInteger(targetTagRevision) || targetTagRevision < 1) {
          throw new Error('Alias audit event lacks rollback revision metadata')
        }
        const locked = await this.repository.db
          .prepare(
            `SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
             AND resource_key IN (?, ?) LIMIT 1`,
          )
          .bind(`alias:${entityId}`, `tag:${targetTagId}`)
          .first('1')
        if (locked) throw new Error('Rollback target is locked')
        const aliasTarget = await this.repository.db
          .prepare('SELECT tag_id FROM tag_aliases WHERE alias = ?')
          .bind(entityId)
          .first<number>('tag_id')
        if (aliasTarget !== targetTagId)
          throw new Error('Alias no longer matches audited state')
        const currentRevision = await this.repository.db
          .prepare('SELECT revision FROM tags WHERE id = ?')
          .bind(targetTagId)
          .first<number>('revision')
        if (currentRevision !== targetTagRevision) {
          throw new Error(
            'Alias target revision changed after the audited event',
          )
        }
        statements.push(
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
          throw new Error('Parent audit event lacks rollback revision metadata')
        }
        const locked = await this.repository.db
          .prepare(
            `SELECT 1 FROM taxonomy_locks WHERE released_at IS NULL
             AND resource_key IN (?, ?, ?) LIMIT 1`,
          )
          .bind(
            `parent:${parentTagId}:${childTagId}`,
            `tag:${parentTagId}`,
            `tag:${childTagId}`,
          )
          .first('1')
        if (locked) throw new Error('Rollback target is locked')
        const exists = await this.repository.db
          .prepare(
            'SELECT 1 FROM tag_parents WHERE parent_tag_id = ? AND child_tag_id = ?',
          )
          .bind(parentTagId, childTagId)
          .first('1')
        if (!exists)
          throw new Error('Parent edge no longer matches audited state')
        const currentRevision = await this.repository.db
          .prepare('SELECT revision FROM tags WHERE id = ?')
          .bind(childTagId)
          .first<number>('revision')
        if (currentRevision !== childTagRevision) {
          throw new Error(
            'Parent child revision changed after the audited event',
          )
        }
        statements.push(
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
      statements.push(
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
}

type Row = Record<string, unknown>

export function createTaxonomyService(
  env: TaxonomyServiceEnv,
  options: RuntimeOptions = {},
): TaxonomyService {
  return new TaxonomyService(env, options)
}
