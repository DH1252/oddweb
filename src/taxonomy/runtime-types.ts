import type { SiteDecision } from './contracts'

export type TaxonomyMode =
  'disabled' | 'shadow' | 'gradual' | 'autonomous' | 'degraded'

export type TaxonomyServiceEnv = {
  DB: Env['DB']
  RELEASE_SHA: string
  TAXONOMY_MASTER_KEY_V1: string
}

export type TaxonomyRuntimeEnv = TaxonomyServiceEnv & {
  TAXONOMY_QUEUE: Env['TAXONOMY_QUEUE']
}

export interface TaxonomyQueueMessage {
  jobId: string
}

export interface TaxonomyState {
  publishedVersion: number
  activeProviderConfigId: number | null
  activePolicyConfigId: number | null
  mode: TaxonomyMode
  siteClassificationEnabled: boolean
  circuitState: 'closed' | 'open' | 'half_open'
  circuitReason: string | null
  circuitOpenedAt: number | null
  modeChangedAt: number
}

export interface RuntimePolicy {
  id: number
  revision: number
  assignmentLimit: number
  novelEvidenceSiteThreshold: number
  assignmentConfidenceMicros: number
  ontologyConfidenceMicros: number
  minimumMarginMicros: number
  hierarchyMaxDepth: number
  hierarchyMaxFanout: number
  ontologyProviderAgreement: number
  retryBudget: number
  retryBaseSeconds: number
  retryMaxSeconds: number
  rolloutBasisPoints: number
  dailyRequestBudget: number
  dailyTokenBudget: number
  schemaFailureTripBasisPoints: number
  disagreementTripBasisPoints: number
  rollbackTripBasisPoints: number
  mutationVolumeTripCount: number
  rawResponseRetentionSeconds: number
  shadowMinimumSamples: number
  shadowMinimumCoverageBasisPoints: number
  shadowSchemaSuccessBasisPoints: number
  shadowProviderAgreementBasisPoints: number
  promptHash: string
  schemaHash: string
}

export interface ProviderConfig {
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
  credentialNonce: string
  credentialCiphertext: string
}

export interface TaxonomyJob {
  id: string
  jobKey: string
  kind: 'classify_site' | 'reassess_concept' | 'apply_ontology' | 'rollback'
  siteId: number | null
  conceptKey: string | null
  inputHash: string
  siteContentVersion: number | null
  taxonomyVersion: number
  providerConfigId: number | null
  policyConfigId: number | null
  batchId: string | null
  status: string
  attemptCount: number
  maxAttempts: number
  leaseToken: string
}

export interface SiteSnapshot {
  id: number
  name: string
  url: string
  description: string
  contentVersion: number
  classificationInputHash: string | null
  assignedTagIds: number[]
  automationAssignedTagIds: number[]
  assignments: SiteAssignmentSnapshot[]
}

export interface SiteAssignmentSnapshot {
  tagId: number
  rawName: string
  source: 'deterministic' | 'automation' | 'admin' | 'migration'
  decisionId: string | null
  revision: number
  createdAt: number
  updatedAt: number
}

export interface TagSnapshot {
  id: number
  slug: string
  name: string
  canonical: boolean
  revision: number
  automationLocked: boolean
  aliases: string[]
  parentIds: number[]
}

export interface CandidateSnapshot {
  site: SiteSnapshot
  tags: TagSnapshot[]
  activeLockKeys: string[]
}

export interface ProviderDecisionResult {
  config: ProviderConfig
  attemptId: string
  decision: SiteDecision
  inputTokens: number | null
  outputTokens: number | null
}

export interface ProviderRoutePlan {
  primary: ProviderConfig[]
  voters: ProviderConfig[]
  requiredVoters: number
}

export interface RuntimeOptions {
  now?: () => number
  fetch?: typeof fetch
  signal?: AbortSignal
  owner?: string
  leaseSeconds?: number
  candidateLimit?: number
}

export interface ProcessingResult {
  jobId: string
  status: 'ignored' | 'obsolete' | 'retry_wait' | 'settled' | 'degraded'
  attempts: number
  mutations: number
}

export interface MaintenanceResult {
  staleJobs: number
  staleOutbox: number
  rawResponsesPurged: number
  reconciledOutbox: number
  eligibleConceptsEnqueued: number
  outboxDispatched: number
}

export interface BackfillResult {
  scanned: number
  enqueued: number
  nextCursor: number | null
}

export type OntologyMutation =
  | {
      kind: 'canonical'
      proposedName: string
      proposedSlug: string
      normalizedConcept: string
      expectedVersion: number
      expectedTagRevision?: never
    }
  | {
      kind: 'alias'
      alias: string
      targetTagId: number
      expectedVersion: number
      expectedTagRevision: number
    }
  | {
      kind: 'merge'
      sourceTagId: number
      targetTagId: number
      expectedVersion: number
      expectedTagRevision: number
    }
  | {
      kind: 'parent'
      childTagId: number
      parentTagId: number
      expectedVersion: number
      expectedTagRevision: number
    }

export interface RollbackResult {
  batchId: string
  status: 'applied' | 'partial'
  compensatedEvents: number
}
