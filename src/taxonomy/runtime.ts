import { siteDecisionSchema } from './contracts'
import type { SiteTagDecision } from './contracts'
import { decryptStoredProviderCredential } from './encryption'
import {
  boundedLimit,
  parseQueueMessage,
  permitsMutation,
  requiredConsensus,
  retryDelaySeconds,
} from './guards'
import { sha256Hex, stableJson } from './normalize'
import { processOntologyJob } from './ontology-runtime'
import { allowedProviderHosts, providerHostAllowed } from './provider-security'
import {
  createGeminiProvider,
  createOpenAICompatibleProvider,
  TaxonomyProviderError,
} from './providers'
import type { TaxonomyProvider } from './providers'
import { TaxonomyRepository } from './repository'
import type {
  CandidateSnapshot,
  MaintenanceResult,
  ProcessingResult,
  ProviderConfig,
  ProviderDecisionResult,
  ProviderRoutePlan,
  RuntimeOptions,
  RuntimePolicy,
  TaxonomyJob,
  TaxonomyRuntimeEnv,
} from './runtime-types'

const systemPrompt = `You classify one website against a bounded taxonomy catalog.
Use only supplied numeric tag IDs. Do not invent tags or categories.
Return assign only for directly supported tags, do_not_assign only for clearly incorrect current assignments, and review when uncertain.
Evidence must quote or closely identify supplied site content.`

const defaultLeaseSeconds = 900
const providerDeadlineMarginMs = 30_000

function unixSeconds(options: RuntimeOptions): number {
  return Math.floor((options.now?.() ?? Date.now()) / 1_000)
}

function runtimeNow(options: RuntimeOptions): () => number {
  return options.now ?? Date.now
}

function summary(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'Unknown taxonomy error'
}

function providerInstance(
  config: ProviderConfig,
  apiKey: string,
  options: RuntimeOptions,
): TaxonomyProvider {
  if (!providerHostAllowed(config)) {
    throw new TaxonomyProviderError('Provider endpoint host is not allowed', {
      code: 'configuration',
      retryable: false,
    })
  }
  const shared = {
    apiKey,
    model: config.model,
    endpoint: config.endpoint,
    allowedHosts: allowedProviderHosts(config.providerKind),
    timeoutMs: Math.min(config.timeoutMs, 60_000),
    maxRetries: 0,
  }
  const runtime = { fetch: options.fetch, now: runtimeNow(options) }
  return config.providerKind === 'gemini'
    ? createGeminiProvider(shared, runtime)
    : createOpenAICompatibleProvider(
        {
          ...shared,
          dialect: config.dialect ?? 'responses',
        },
        runtime,
      )
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).byteLength / 3))
}

export function providerRoutePlan(
  providers: readonly ProviderConfig[],
  _policy: RuntimePolicy,
): ProviderRoutePlan {
  const primary = providers.filter(
    ({ routingRole }) => routingRole !== 'consensus',
  )
  const consensus = providers.filter(
    ({ routingRole }) => routingRole === 'consensus',
  )
  const requiredVoters = 1 + consensus.length
  if (!primary.length) {
    throw new TaxonomyProviderError(
      'Provider route requires an enabled primary voter',
      { code: 'configuration', retryable: true },
    )
  }
  return { primary, voters: consensus, requiredVoters }
}

function promptFor(snapshot: CandidateSnapshot): string {
  return stableJson({
    site: {
      id: snapshot.site.id,
      name: snapshot.site.name,
      url: snapshot.site.url,
      description: snapshot.site.description,
      assignedTagIds: snapshot.site.assignedTagIds,
    },
    tags: snapshot.tags.map((tag) => ({
      id: String(tag.id),
      slug: tag.slug,
      name: tag.name,
      aliases: tag.aliases,
      parentIds: tag.parentIds.map(String),
    })),
  })
}

async function callProvider(input: {
  repository: TaxonomyRepository
  env: TaxonomyRuntimeEnv
  options: RuntimeOptions
  job: TaxonomyJob
  config: ProviderConfig
  policy: RuntimePolicy
  userPrompt: string
  now: number
  attemptNumber?: number
}): Promise<ProviderDecisionResult> {
  const attemptNumber =
    input.attemptNumber ??
    (await input.repository.nextAttemptNumber(input.job.id))
  const attemptId = `attempt:${input.job.id}:${attemptNumber}`
  const requestHash = await sha256Hex(
    stableJson({
      providerConfigId: input.config.id,
      model: input.config.model,
      promptHash: input.policy.promptHash,
      schemaHash: input.policy.schemaHash,
      systemPrompt,
      userPrompt: input.userPrompt,
    }),
  )
  const estimatedInputTokens = estimateTokens(
    `${systemPrompt}\n${input.userPrompt}`,
  )
  const estimatedOutputTokens = 1_024
  const reserved = await input.repository.reserveAttempt({
    id: attemptId,
    jobId: input.job.id,
    number: attemptNumber,
    provider: input.config,
    requestHash,
    now: input.now,
    estimatedInputTokens,
    estimatedOutputTokens,
    requestBudget: input.policy.dailyRequestBudget,
    tokenBudget: input.policy.dailyTokenBudget,
  })
  if (!reserved) {
    throw new TaxonomyProviderError(
      'Daily taxonomy provider budget exhausted',
      {
        code: 'rate_limit',
        retryable: true,
      },
    )
  }
  try {
    const apiKey = await decryptStoredProviderCredential(
      {
        providerId: input.config.id,
        keyVersion: input.config.keyVersion,
        nonce: input.config.credentialNonce,
        ciphertext: input.config.credentialCiphertext,
      },
      input.env,
    )
    const result = await providerInstance(
      input.config,
      apiKey,
      input.options,
    ).generateStructured({
      schema: siteDecisionSchema,
      schemaName: 'taxonomy_site_decision',
      systemPrompt,
      userPrompt: input.userPrompt,
      signal: input.options.signal,
    })
    const raw = stableJson(result.data)
    await input.repository.finishAttempt({
      id: attemptId,
      status: 'succeeded',
      now: input.now,
      providerRequestId: result.providerRequestId,
      responseHash: await sha256Hex(raw),
      rawResponse: input.policy.rawResponseRetentionSeconds > 0 ? raw : null,
      rawResponseExpiresAt:
        input.policy.rawResponseRetentionSeconds > 0
          ? input.now + input.policy.rawResponseRetentionSeconds
          : null,
      inputTokens: result.usage.inputTokens ?? estimatedInputTokens,
      outputTokens: result.usage.outputTokens ?? estimatedOutputTokens,
      latencyMs: result.latencyMs,
    })
    return {
      config: input.config,
      attemptId,
      decision: result.data,
      inputTokens: result.usage.inputTokens ?? estimatedInputTokens,
      outputTokens: result.usage.outputTokens ?? estimatedOutputTokens,
    }
  } catch (error) {
    const providerError =
      error instanceof TaxonomyProviderError
        ? error
        : new TaxonomyProviderError('Provider configuration failed', {
            code: 'configuration',
            retryable: false,
            cause: error,
          })
    await input.repository.finishAttempt({
      id: attemptId,
      status:
        providerError.code === 'invalid_response'
          ? 'invalid_response'
          : providerError.retryable
            ? 'retryable_failure'
            : 'permanent_failure',
      now: input.now,
      latencyMs: providerError.latencyMs,
      errorCode: providerError.code,
      errorSummary: providerError.message,
    })
    throw providerError
  }
}

async function routeProviders(input: {
  repository: TaxonomyRepository
  env: TaxonomyRuntimeEnv
  options: RuntimeOptions
  job: TaxonomyJob
  policy: RuntimePolicy
  providers: ProviderConfig[]
  userPrompt: string
  now: number
}): Promise<ProviderDecisionResult[]> {
  const plan = providerRoutePlan(input.providers, input.policy)
  let primary: ProviderDecisionResult | undefined
  let lastError: unknown
  for (const config of plan.primary) {
    try {
      primary = await callProvider({ ...input, config })
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!primary)
    throw lastError ?? new Error('No primary taxonomy provider is configured')
  const results = [primary]
  const firstVoterAttempt = await input.repository.nextAttemptNumber(
    input.job.id,
  )
  const voters = await Promise.allSettled(
    plan.voters.map((config, index) =>
      callProvider({
        ...input,
        config,
        attemptNumber: firstVoterAttempt + index,
      }),
    ),
  )
  const failedVoter = voters.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failedVoter) {
    throw new TaxonomyProviderError('Required consensus voter failed', {
      code: 'invalid_response',
      retryable: true,
      cause: failedVoter.reason,
    })
  }
  results.push(
    ...voters.map(
      (result) =>
        (result as PromiseFulfilledResult<ProviderDecisionResult>).value,
    ),
  )
  if (results.length !== plan.requiredVoters) {
    throw new TaxonomyProviderError('Required consensus voter is missing', {
      code: 'invalid_response',
      retryable: true,
    })
  }
  return results
}

function validatedDecisions(
  results: readonly ProviderDecisionResult[],
  snapshot: CandidateSnapshot,
  policy: RuntimePolicy,
  requiredVoters: number,
): {
  decisions: SiteTagDecision[]
  provider: ProviderDecisionResult
  agreement: boolean
} {
  const known = new Set(snapshot.tags.map((tag) => String(tag.id)))
  const groups = results.map((result) =>
    result.decision.decisions.filter(
      (decision) =>
        known.has(decision.tagId) &&
        decision.confidence * 1_000_000 >= policy.assignmentConfidenceMicros &&
        decision.margin * 1_000_000 >= policy.minimumMarginMicros &&
        (decision.decision === 'assign' ||
          decision.decision === 'do_not_assign'),
    ),
  )
  const decisions = requiredConsensus(
    groups,
    (decision) => `${decision.tagId}:${decision.decision}`,
    requiredVoters,
  ).slice(0, policy.assignmentLimit)
  const agreedKeys = new Set(
    groups[0]?.map((decision) => `${decision.tagId}:${decision.decision}`) ??
      [],
  )
  return {
    decisions,
    provider: results[0],
    agreement:
      results.length === requiredVoters &&
      groups.every((group) => {
        const keys = new Set(
          group.map((decision) => `${decision.tagId}:${decision.decision}`),
        )
        return (
          keys.size === agreedKeys.size &&
          [...keys].every((key) => agreedKeys.has(key))
        )
      }),
  }
}

async function settleDecisions(input: {
  repository: TaxonomyRepository
  env: TaxonomyRuntimeEnv
  job: TaxonomyJob
  snapshot: CandidateSnapshot
  policy: RuntimePolicy
  stateMode: 'disabled' | 'shadow' | 'gradual' | 'autonomous' | 'degraded'
  results: ProviderDecisionResult[]
  requiredVoters: number
  now: number
}): Promise<{ mutations: number; agreement: boolean; decisionCount: number }> {
  const validated = validatedDecisions(
    input.results,
    input.snapshot,
    input.policy,
    input.requiredVoters,
  )
  let mutations = 0
  const tagById = new Map(
    input.snapshot.tags.map((tag) => [String(tag.id), tag]),
  )
  const activeLocks = new Set(input.snapshot.activeLockKeys)
  const settlements: Array<
    Parameters<TaxonomyRepository['applyAssignments']>[0][number]
  > = []
  for (const [rank, decision] of validated.decisions.entries()) {
    const tag = tagById.get(decision.tagId)
    if (!tag) continue
    const action = decision.decision === 'assign' ? 'add' : 'remove'
    const locked =
      tag.automationLocked ||
      activeLocks.has(`site:${input.snapshot.site.id}:tag:${tag.id}`) ||
      activeLocks.has(`tag:${tag.id}`)
    const mayMutate =
      validated.agreement &&
      !locked &&
      (await permitsMutation(
        input.stateMode,
        `${input.snapshot.site.id}:${input.job.inputHash}:${tag.id}:${action}`,
        input.policy.rolloutBasisPoints,
      ))
    const outcome = locked
      ? 'locked'
      : !validated.agreement
        ? 'conservative'
        : mayMutate
          ? 'applied'
          : 'shadow'
    const candidateKey = `existing:${tag.id}:${decision.decision}:attempt:${validated.provider.attemptId}`
    const candidateId = `candidate:${(await sha256Hex(`${input.job.id}:${candidateKey}`)).slice(0, 40)}`
    const suffix = (
      await sha256Hex(`${input.job.id}:${candidateKey}:${outcome}:decision`)
    ).slice(0, 40)
    settlements.push({
      job: input.job,
      site: input.snapshot.site,
      tag,
      candidateId,
      attemptId: validated.provider.attemptId,
      candidateKey,
      payload: decision,
      marginMicros: Math.round(decision.margin * 1_000_000),
      rank,
      decisionId: `decision:${suffix}`,
      batchId: `classification:${input.job.id}`,
      eventId: `assignment-event:${suffix}`,
      action,
      outcome,
      confidenceMicros: Math.round(decision.confidence * 1_000_000),
      reason: decision.evidence,
      providerConfigId: validated.provider.config.id,
      providerModel: validated.provider.config.model,
      policy: input.policy,
      releaseSha: input.env.RELEASE_SHA,
      now: input.now,
    })
  }
  if (validated.agreement) {
    mutations = settlements.length
      ? await input.repository.applyAssignments(settlements, true)
      : 0
  } else if (settlements.length) {
    await input.repository.applyAssignments(settlements, false)
  }
  return {
    mutations,
    agreement: validated.agreement,
    decisionCount: settlements.length,
  }
}

async function evaluateCircuit(
  repository: TaxonomyRepository,
  policy: RuntimePolicy,
  now: number,
): Promise<void> {
  const metrics = await repository.circuitMetrics(now)
  if (metrics.attempts > 0) {
    const schemaRate = Math.floor(
      (metrics.schemaFailures * 10_000) / metrics.attempts,
    )
    const disagreementRate = Math.floor(
      (metrics.disagreements * 10_000) / metrics.attempts,
    )
    const rollbackRate = Math.floor(
      (metrics.rollbacks * 10_000) / metrics.attempts,
    )
    if (schemaRate >= policy.schemaFailureTripBasisPoints) {
      await repository.openCircuit('Schema failure threshold exceeded.', now)
    } else if (disagreementRate >= policy.disagreementTripBasisPoints) {
      await repository.openCircuit(
        'Provider disagreement threshold exceeded.',
        now,
      )
    } else if (rollbackRate >= policy.rollbackTripBasisPoints) {
      await repository.openCircuit('Rollback threshold exceeded.', now)
    }
  }
  if (
    policy.mutationVolumeTripCount > 0 &&
    metrics.mutations >= policy.mutationVolumeTripCount
  ) {
    await repository.openCircuit('Mutation volume threshold exceeded.', now)
  }
}

export async function processTaxonomyMessage(
  message: unknown,
  env: TaxonomyRuntimeEnv,
  options: RuntimeOptions = {},
): Promise<ProcessingResult> {
  const { jobId } = parseQueueMessage(message)
  const repository = new TaxonomyRepository(env.DB)
  const now = unixSeconds(options)
  const leaseSeconds = boundedLimit(
    options.leaseSeconds,
    defaultLeaseSeconds,
    defaultLeaseSeconds,
  )
  const leaseToken = crypto.randomUUID()
  const job = await repository.leaseJob(
    jobId,
    options.owner ?? 'taxonomy-worker',
    leaseToken,
    now,
    leaseSeconds,
  )
  if (!job) {
    await repository.rearmRunnableOutbox(jobId, now)
    return { jobId, status: 'ignored', attempts: 0, mutations: 0 }
  }
  const deadline = new AbortController()
  const parentAbort = () => deadline.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', parentAbort, { once: true })
  if (options.signal?.aborted) parentAbort()
  const deadlineTimer = setTimeout(
    () =>
      deadline.abort(
        new DOMException(
          'Taxonomy job provider deadline exceeded',
          'TimeoutError',
        ),
      ),
    Math.max(1, leaseSeconds * 1_000 - providerDeadlineMarginMs),
  )
  const runtimeOptions = { ...options, signal: deadline.signal }
  try {
    if (!(await repository.renewJobLease(job, now, leaseSeconds))) {
      await repository.retryJob(
        job,
        now,
        now,
        'lease_renew_failed',
        'Lease renewal failed before processing started.',
      )
      await repository.rearmRunnableOutbox(jobId, now)
      return {
        jobId,
        status: 'retry_wait',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    const state = await repository.loadState()
    const policy = await repository.loadPolicy(
      job.policyConfigId ?? state.activePolicyConfigId,
    )
    if (
      state.mode === 'disabled' ||
      state.mode === 'degraded' ||
      state.circuitState === 'open'
    ) {
      await repository.settleJob(
        job,
        'degraded',
        now,
        'automation_disabled',
        'Taxonomy automation is not active.',
      )
      return {
        jobId,
        status: 'degraded',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    if (job.kind === 'reassess_concept' || job.kind === 'apply_ontology') {
      return await processOntologyJob({
        repository,
        env,
        options: runtimeOptions,
        job,
        state,
        policy,
        now,
      })
    }
    if (job.kind === 'rollback') {
      await repository.settleJob(
        job,
        'degraded',
        now,
        'admin_required',
        'Rollback jobs require an explicit admin rollback scope.',
      )
      return {
        jobId,
        status: 'degraded',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    const snapshot = await repository.candidateSnapshot(
      job,
      boundedLimit(options.candidateLimit, 250, 500),
    )
    if (
      !snapshot ||
      snapshot.site.contentVersion !== job.siteContentVersion ||
      snapshot.site.classificationInputHash !== job.inputHash ||
      state.publishedVersion !== job.taxonomyVersion
    ) {
      await repository.settleJob(
        job,
        'obsolete',
        now,
        'stale_input',
        'Site or taxonomy version changed.',
      )
      return {
        jobId,
        status: 'obsolete',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    const providers = await repository.loadProviderRoute(
      job.providerConfigId ?? state.activeProviderConfigId,
    )
    if (!providers.length) throw new Error('No enabled taxonomy provider route')
    const routePlan = providerRoutePlan(providers, policy)
    const results = await routeProviders({
      repository,
      env,
      options: runtimeOptions,
      job,
      policy,
      providers,
      userPrompt: promptFor(snapshot),
      now,
    })
    if (!(await repository.classificationInputCurrent(job))) {
      await repository.settleJob(
        job,
        'obsolete',
        now,
        'stale_input',
        'Site input changed while providers were running.',
      )
      return {
        jobId,
        status: 'obsolete',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    const settlement = await settleDecisions({
      repository,
      env,
      job,
      snapshot,
      policy,
      stateMode: state.mode,
      results,
      requiredVoters: routePlan.requiredVoters,
      now,
    })
    if (!settlement.agreement) {
      const willRetry = job.attemptCount < job.maxAttempts
      await repository.retryJob(
        job,
        now +
          retryDelaySeconds(
            job.attemptCount,
            policy.retryBaseSeconds,
            policy.retryMaxSeconds,
          ),
        now,
        'provider_disagreement',
        'Providers did not agree; no mutation was applied.',
      )
      await evaluateCircuit(repository, policy, now)
      return {
        jobId,
        status: willRetry ? 'retry_wait' : 'degraded',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    if (!settlement.decisionCount) {
      await repository.settleClassification(job, snapshot.site, now)
    }
    await evaluateCircuit(repository, policy, now)
    return {
      jobId,
      status: 'settled',
      attempts: job.attemptCount,
      mutations: settlement.mutations,
    }
  } catch (error) {
    const state = await repository.loadState()
    const policy = await repository.loadPolicy(
      job.policyConfigId ?? state.activePolicyConfigId,
    )
    const retryable =
      !(error instanceof TaxonomyProviderError) || error.retryable
    if (retryable && job.attemptCount < job.maxAttempts) {
      await repository.retryJob(
        job,
        now +
          retryDelaySeconds(
            job.attemptCount,
            policy.retryBaseSeconds,
            policy.retryMaxSeconds,
          ),
        now,
        error instanceof TaxonomyProviderError ? error.code : 'runtime_error',
        summary(error),
      )
      return {
        jobId,
        status: 'retry_wait',
        attempts: job.attemptCount,
        mutations: 0,
      }
    }
    await repository.settleJob(
      job,
      'degraded',
      now,
      'permanent_failure',
      summary(error),
    )
    await evaluateCircuit(repository, policy, now)
    return {
      jobId,
      status: 'degraded',
      attempts: job.attemptCount,
      mutations: 0,
    }
  } finally {
    clearTimeout(deadlineTimer)
    options.signal?.removeEventListener('abort', parentAbort)
  }
}

export async function dispatchTaxonomyOutbox(
  env: TaxonomyRuntimeEnv,
  options: RuntimeOptions & { limit?: number } = {},
): Promise<number> {
  const repository = new TaxonomyRepository(env.DB)
  const now = unixSeconds(options)
  const rows = await repository.leaseOutbox(
    boundedLimit(options.limit, 25, 100),
    now,
    60,
  )
  let dispatched = 0
  for (const row of rows) {
    try {
      await env.TAXONOMY_QUEUE.send({ jobId: row.jobId })
      await repository.completeOutbox(row.id, row.token, now)
      dispatched += 1
    } catch (error) {
      await repository.failOutbox(row.id, row.token, now + 60, summary(error))
    }
  }
  return dispatched
}

export async function runTaxonomyMaintenance(
  env: TaxonomyRuntimeEnv,
  options: RuntimeOptions & { outboxLimit?: number } = {},
): Promise<MaintenanceResult> {
  const repository = new TaxonomyRepository(env.DB)
  const now = unixSeconds(options)
  const maintenance = await repository.maintenance(now)
  const state = await repository.loadState()
  const policy = await repository.loadPolicy(state.activePolicyConfigId)
  await evaluateCircuit(repository, policy, now)
  const outboxDispatched = await dispatchTaxonomyOutbox(env, {
    ...options,
    limit: options.outboxLimit,
  })
  return { ...maintenance, outboxDispatched }
}
