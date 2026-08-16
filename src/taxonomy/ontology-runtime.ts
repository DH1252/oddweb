import {
  ontologyProposalResponseSchema,
  ontologyProposalSchema,
} from './contracts'
import type { OntologyProposal, OntologyProposalResponse } from './contracts'
import { decryptStoredProviderCredential } from './encryption'
import {
  normalizeProposedSlug,
  permitsMutation,
  requiredConsensus,
} from './guards'
import { normalizeTaxonomyTag, sha256Hex, stableJson } from './normalize'
import {
  createGeminiProvider,
  createOpenAICompatibleProvider,
  TaxonomyProviderError,
} from './providers'
import type { TaxonomyRepository } from './repository'
import { TaxonomyService } from './service'
import { allowedProviderHosts, providerHostAllowed } from './provider-security'
import type {
  OntologyMutation,
  ProcessingResult,
  ProviderConfig,
  RuntimeOptions,
  RuntimePolicy,
  TaxonomyJob,
  TaxonomyRuntimeEnv,
  TaxonomyState,
} from './runtime-types'

const ontologySystemPrompt = `You propose conservative taxonomy changes from supplied evidence and active tags.
Use only supplied numeric tag IDs. Do not create categories.
Concepts require repeated distinct-site evidence. Aliases must be lexical equivalents.
Merges require semantic identity. Parent edges must express a strict broader-to-narrower relationship.`

interface OntologyResult {
  config: ProviderConfig
  attemptId: string
  response: OntologyProposalResponse
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).byteLength / 3))
}

function provider(
  config: ProviderConfig,
  apiKey: string,
  options: RuntimeOptions,
) {
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
  const runtime = { fetch: options.fetch, now: options.now ?? Date.now }
  return config.providerKind === 'gemini'
    ? createGeminiProvider(shared, runtime)
    : createOpenAICompatibleProvider(
        { ...shared, dialect: config.dialect ?? 'responses' },
        runtime,
      )
}

async function invoke(input: {
  repository: TaxonomyRepository
  env: TaxonomyRuntimeEnv
  options: RuntimeOptions
  job: TaxonomyJob
  policy: RuntimePolicy
  config: ProviderConfig
  prompt: string
  now: number
  attemptNumber?: number
}): Promise<OntologyResult> {
  const number =
    input.attemptNumber ??
    (await input.repository.nextAttemptNumber(input.job.id))
  const attemptId = `attempt:${input.job.id}:${number}`
  const requestHash = await sha256Hex(
    stableJson({
      providerConfigId: input.config.id,
      promptHash: input.policy.promptHash,
      schemaHash: input.policy.schemaHash,
      prompt: input.prompt,
    }),
  )
  const estimatedInputTokens = estimateTokens(
    `${ontologySystemPrompt}\n${input.prompt}`,
  )
  const estimatedOutputTokens = 2_048
  const reserved = await input.repository.reserveAttempt({
    id: attemptId,
    jobId: input.job.id,
    number,
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
    const result = await provider(
      input.config,
      apiKey,
      input.options,
    ).generateStructured({
      schema: ontologyProposalResponseSchema,
      schemaName: 'taxonomy_ontology_proposals',
      systemPrompt: ontologySystemPrompt,
      userPrompt: input.prompt,
      signal: input.options.signal,
    })
    const raw = stableJson(result.data)
    await input.repository.finishAttempt({
      id: attemptId,
      status: 'succeeded',
      now: input.now,
      providerRequestId: result.providerRequestId,
      responseHash: await sha256Hex(raw),
      rawResponse: input.policy.rawResponseRetentionSeconds ? raw : null,
      rawResponseExpiresAt: input.policy.rawResponseRetentionSeconds
        ? input.now + input.policy.rawResponseRetentionSeconds
        : null,
      inputTokens: result.usage.inputTokens ?? estimatedInputTokens,
      outputTokens: result.usage.outputTokens ?? estimatedOutputTokens,
      latencyMs: result.latencyMs,
    })
    return { config: input.config, attemptId, response: result.data }
  } catch (error) {
    const normalized =
      error instanceof TaxonomyProviderError
        ? error
        : new TaxonomyProviderError('Ontology provider failed', {
            code: 'configuration',
            retryable: false,
            cause: error,
          })
    await input.repository.finishAttempt({
      id: attemptId,
      status:
        normalized.code === 'invalid_response'
          ? 'invalid_response'
          : normalized.retryable
            ? 'retryable_failure'
            : 'permanent_failure',
      now: input.now,
      errorCode: normalized.code,
      errorSummary: normalized.message,
      latencyMs: normalized.latencyMs,
    })
    throw normalized
  }
}

function proposalKey(proposal: OntologyProposal): string {
  if (proposal.kind === 'concept') {
    return `concept:${normalizeTaxonomyTag(proposal.proposedName)}:${normalizeProposedSlug(proposal.proposedSlug)}`
  }
  if (proposal.kind === 'alias') {
    return `alias:${normalizeTaxonomyTag(proposal.alias)}:${proposal.targetTagId}`
  }
  if (proposal.kind === 'merge') {
    return `merge:${proposal.sourceTagId}:${proposal.targetTagId}`
  }
  return `parent:${proposal.parentTagId}:${proposal.childTagId}`
}

function policyValidatedProposals(
  results: readonly OntologyResult[],
  policy: RuntimePolicy,
  knownIds: ReadonlySet<string>,
): OntologyProposal[] {
  const groups = results.map(({ response }) =>
    response.proposals.filter((proposal) => {
      if (proposal.confidence * 1_000_000 < policy.ontologyConfidenceMicros)
        return false
      if (proposal.kind === 'concept') return true
      if (proposal.kind === 'alias') return knownIds.has(proposal.targetTagId)
      if (proposal.kind === 'merge') {
        return (
          knownIds.has(proposal.sourceTagId) &&
          knownIds.has(proposal.targetTagId)
        )
      }
      return (
        knownIds.has(proposal.childTagId) && knownIds.has(proposal.parentTagId)
      )
    }),
  )
  return requiredConsensus(
    groups,
    proposalKey,
    policy.ontologyProviderAgreement,
  ).slice(0, 10)
}

function mutationFor(
  proposal: OntologyProposal,
  version: number,
  revisions: ReadonlyMap<number, number>,
): OntologyMutation {
  if (proposal.kind === 'concept') {
    return {
      kind: 'canonical',
      proposedName: proposal.proposedName,
      proposedSlug: proposal.proposedSlug,
      normalizedConcept: normalizeTaxonomyTag(proposal.proposedName),
      expectedVersion: version,
    }
  }
  if (proposal.kind === 'alias') {
    const targetTagId = Number(proposal.targetTagId)
    return {
      kind: 'alias',
      alias: proposal.alias,
      targetTagId,
      expectedVersion: version,
      expectedTagRevision: revisions.get(targetTagId) ?? 0,
    }
  }
  if (proposal.kind === 'merge') {
    const sourceTagId = Number(proposal.sourceTagId)
    return {
      kind: 'merge',
      sourceTagId,
      targetTagId: Number(proposal.targetTagId),
      expectedVersion: version,
      expectedTagRevision: revisions.get(sourceTagId) ?? 0,
    }
  }
  const childTagId = Number(proposal.childTagId)
  return {
    kind: 'parent',
    childTagId,
    parentTagId: Number(proposal.parentTagId),
    expectedVersion: version,
    expectedTagRevision: revisions.get(childTagId) ?? 0,
  }
}

async function saveProposal(input: {
  repository: TaxonomyRepository
  job: TaxonomyJob
  result: OntologyResult
  proposal: OntologyProposal
  rank: number
  now: number
}): Promise<string> {
  const key = proposalKey(input.proposal)
  const id = `candidate:${(await sha256Hex(`${input.job.id}:${key}`)).slice(0, 40)}`
  const common = {
    id,
    jobId: input.job.id,
    attemptId: input.result.attemptId,
    candidateKey: key,
    payload: input.proposal,
    confidenceMicros: Math.round(input.proposal.confidence * 1_000_000),
    rank: input.rank,
    now: input.now,
  }
  if (input.proposal.kind === 'concept') {
    await input.repository.saveCandidate({
      ...common,
      kind: 'novel_concept',
      normalizedConcept: normalizeTaxonomyTag(input.proposal.proposedName),
      proposedName: input.proposal.proposedName,
      proposedSlug: normalizeProposedSlug(input.proposal.proposedSlug),
    })
  } else if (input.proposal.kind === 'alias') {
    await input.repository.saveCandidate({
      ...common,
      kind: 'alias',
      tagId: Number(input.proposal.targetTagId),
      normalizedConcept: normalizeTaxonomyTag(input.proposal.alias),
    })
  } else {
    await input.repository.saveCandidate({
      ...common,
      kind: input.proposal.kind === 'merge' ? 'merge' : 'parent_edge',
      tagId: Number(
        input.proposal.kind === 'merge'
          ? input.proposal.sourceTagId
          : input.proposal.childTagId,
      ),
      relatedTagId: Number(
        input.proposal.kind === 'merge'
          ? input.proposal.targetTagId
          : input.proposal.parentTagId,
      ),
    })
  }
  return id
}

export async function processOntologyJob(input: {
  repository: TaxonomyRepository
  env: TaxonomyRuntimeEnv
  options: RuntimeOptions
  job: TaxonomyJob
  state: TaxonomyState
  policy: RuntimePolicy
  now: number
}): Promise<ProcessingResult> {
  if (input.job.kind === 'apply_ontology') {
    if (!input.job.conceptKey)
      throw new Error('Ontology application job has no candidate id')
    const row = await input.repository.candidate(input.job.conceptKey)
    if (!row) {
      await input.repository.settleJob(
        input.job,
        'obsolete',
        input.now,
        'candidate_missing',
        'Ontology candidate no longer exists.',
      )
      return {
        jobId: input.job.id,
        status: 'obsolete',
        attempts: input.job.attemptCount,
        mutations: 0,
      }
    }
    const candidateStatus = String(row.status)
    if (!['proposed', 'accepted'].includes(candidateStatus)) {
      await input.repository.settleJob(
        input.job,
        'obsolete',
        input.now,
        'candidate_not_proposed',
        'Ontology candidate is no longer proposed.',
      )
      return {
        jobId: input.job.id,
        status: 'obsolete',
        attempts: input.job.attemptCount,
        mutations: 0,
      }
    }
    if (
      candidateStatus === 'proposed' &&
      !(await permitsMutation(
        input.state.mode,
        input.job.conceptKey,
        input.policy.rolloutBasisPoints,
      ))
    ) {
      const settled = await input.repository.settleRolloutExcludedCandidate(
        input.job.conceptKey,
        input.job,
        input.now,
      )
      if (!settled) {
        const refreshed = await input.repository.candidate(input.job.conceptKey)
        if (String(refreshed?.status) === 'accepted') {
          return {
            jobId: input.job.id,
            status: 'ignored',
            attempts: input.job.attemptCount,
            mutations: 0,
          }
        }
        await input.repository.settleJob(
          input.job,
          'obsolete',
          input.now,
          'candidate_changed',
          'Ontology candidate changed while rollout exclusion was settling.',
        )
        return {
          jobId: input.job.id,
          status: 'obsolete',
          attempts: input.job.attemptCount,
          mutations: 0,
        }
      }
      return {
        jobId: input.job.id,
        status: 'settled',
        attempts: input.job.attemptCount,
        mutations: 0,
      }
    }
    const proposal = ontologyProposalSchema.parse(
      JSON.parse(String(row.payload)),
    )
    const alreadyApplied =
      proposal.kind === 'concept'
        ? await input.repository.db
            .prepare(
              `SELECT 1 FROM tags WHERE slug = ? AND name = ? AND canonical = 1 AND status = 'active'`,
            )
            .bind(
              normalizeProposedSlug(proposal.proposedSlug),
              proposal.proposedName,
            )
            .first('1')
        : proposal.kind === 'alias'
          ? await input.repository.db
              .prepare(
                'SELECT 1 FROM tag_aliases WHERE alias = ? AND tag_id = ?',
              )
              .bind(
                normalizeTaxonomyTag(proposal.alias),
                Number(proposal.targetTagId),
              )
              .first('1')
          : proposal.kind === 'parent'
            ? await input.repository.db
                .prepare(
                  'SELECT 1 FROM tag_parents WHERE parent_tag_id = ? AND child_tag_id = ?',
                )
                .bind(Number(proposal.parentTagId), Number(proposal.childTagId))
                .first('1')
            : await input.repository.db
                .prepare(
                  `SELECT 1 FROM tags WHERE id = ? AND status = 'merged' AND merged_into_tag_id = ?`,
                )
                .bind(
                  Number(proposal.sourceTagId),
                  Number(proposal.targetTagId),
                )
                .first('1')
    if (alreadyApplied) {
      await input.repository.settleAlreadyAppliedCandidate(
        input.job.conceptKey,
        input.job,
        input.now,
      )
      return {
        jobId: input.job.id,
        status: 'settled',
        attempts: input.job.attemptCount,
        mutations: 0,
      }
    }
    const context = await input.repository.ontologyContext(null, 500)
    const revisions = new Map(context.tags.map((tag) => [tag.id, tag.revision]))
    const result = await new TaxonomyService(
      input.env,
      input.options,
    ).publishOntology(
      mutationFor(proposal, input.state.publishedVersion, revisions),
      'ontology-job',
      { candidateId: input.job.conceptKey, job: input.job },
    )
    return {
      jobId: input.job.id,
      status: 'settled',
      attempts: input.job.attemptCount,
      mutations: result.applied ? 1 : 0,
    }
  }

  const context = await input.repository.ontologyContext(
    input.job.conceptKey,
    500,
  )
  const providers = await input.repository.loadProviderRoute(
    input.job.providerConfigId ?? input.state.activeProviderConfigId,
  )
  const primary = providers.filter(
    ({ routingRole }) => routingRole !== 'consensus',
  )
  const consensus = providers.filter(
    ({ routingRole }) => routingRole === 'consensus',
  )
  const requiredVoters = input.policy.ontologyProviderAgreement
  if (!primary.length || consensus.length + 1 < requiredVoters) {
    throw new TaxonomyProviderError(
      `Ontology route has ${consensus.length} configured voters but policy requires ${requiredVoters}`,
      { code: 'configuration', retryable: true },
    )
  }
  const voters = consensus.slice(0, Math.max(0, requiredVoters - 1))
  const prompt = stableJson({
    concept: input.job.conceptKey,
    evidence: context.evidence,
    tags: context.tags.map(({ id, slug, name, canonical, revision }) => ({
      id: String(id),
      slug,
      name,
      canonical,
      revision,
    })),
  })
  const results: OntologyResult[] = []
  let primarySucceeded = false
  for (const config of primary) {
    try {
      results.push(await invoke({ ...input, config, prompt }))
      primarySucceeded = true
      break
    } catch (error) {
      if (config === primary.at(-1)) {
        throw new TaxonomyProviderError(
          'Required ontology primary voter failed',
          {
            code: 'invalid_response',
            retryable: true,
            cause: error,
          },
        )
      }
    }
  }
  const firstVoterAttempt = await input.repository.nextAttemptNumber(
    input.job.id,
  )
  const voterResults = await Promise.allSettled(
    voters.map((config, index) =>
      invoke({
        ...input,
        config,
        prompt,
        attemptNumber: firstVoterAttempt + index,
      }),
    ),
  )
  const failedVoter = voterResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failedVoter) {
    throw new TaxonomyProviderError('Required ontology voter failed', {
      code: 'invalid_response',
      retryable: true,
      cause: failedVoter.reason,
    })
  }
  results.push(
    ...voterResults.map(
      (result) => (result as PromiseFulfilledResult<OntologyResult>).value,
    ),
  )
  if (!primarySucceeded || results.length !== requiredVoters) {
    throw new TaxonomyProviderError('Required ontology voter is missing', {
      code: 'invalid_response',
      retryable: true,
    })
  }
  const knownIds = new Set(context.tags.map((tag) => String(tag.id)))
  const proposals = policyValidatedProposals(results, input.policy, knownIds)
  const revisions = new Map(context.tags.map((tag) => [tag.id, tag.revision]))
  let mutations = 0
  const selected: Array<{ candidateId: string; proposal: OntologyProposal }> =
    []
  for (const [rank, proposal] of proposals.entries()) {
    const candidateId = await saveProposal({
      repository: input.repository,
      job: input.job,
      result: results[0],
      proposal,
      rank,
      now: input.now,
    })
    const mutationPermitted = await permitsMutation(
      input.state.mode,
      candidateId,
      input.policy.rolloutBasisPoints,
    )
    if (mutationPermitted) selected.push({ candidateId, proposal })
  }
  for (const { candidateId } of selected.slice(1)) {
    await new TaxonomyService(
      input.env,
      input.options,
    ).enqueueOntologyCandidate(candidateId)
  }
  for (const { candidateId, proposal } of selected.slice(0, 1)) {
    const service = new TaxonomyService(input.env, input.options)
    await service.publishOntology(
      mutationFor(
        proposal,
        input.state.publishedVersion + mutations,
        revisions,
      ),
      'ontology-provider',
      { candidateId, job: input.job },
    )
    mutations += 1
  }
  if (!proposals.length) {
    throw new TaxonomyProviderError(
      'Ontology providers did not reach consensus',
      {
        code: 'invalid_response',
        retryable: true,
      },
    )
  }
  await input.repository.settleJob(input.job, 'settled', input.now)
  return {
    jobId: input.job.id,
    status: 'settled',
    attempts: input.job.attemptCount,
    mutations,
  }
}
