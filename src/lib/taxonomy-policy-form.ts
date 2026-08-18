import type { TaxonomyPolicyAdminRecord } from '../db/taxonomy-admin-repository'
import type { TaxonomyPolicyCreateInput } from '../server/taxonomy-admin-validation'
import { numberFromForm } from './admin-parsers'

export type TaxonomyPolicyInput = TaxonomyPolicyCreateInput

export type PolicyDraft = {
  sourceId: number
  sourceRevision: number
  values: TaxonomyPolicyInput
}

export function policyInputFromForm(data: FormData): TaxonomyPolicyInput {
  return {
    assignmentLimit: numberFromForm(data, 'assignmentLimit'),
    novelEvidenceSiteThreshold: numberFromForm(
      data,
      'novelEvidenceSiteThreshold',
    ),
    assignmentConfidenceMicros: numberFromForm(
      data,
      'assignmentConfidenceMicros',
    ),
    ontologyConfidenceMicros: numberFromForm(data, 'ontologyConfidenceMicros'),
    minimumMarginMicros: numberFromForm(data, 'minimumMarginMicros'),
    hierarchyMaxDepth: numberFromForm(data, 'hierarchyMaxDepth'),
    hierarchyMaxFanout: numberFromForm(data, 'hierarchyMaxFanout'),
    ontologyProviderAgreement: numberFromForm(
      data,
      'ontologyProviderAgreement',
    ),
    retryBudget: numberFromForm(data, 'retryBudget'),
    retryBaseSeconds: numberFromForm(data, 'retryBaseSeconds'),
    retryMaxSeconds: numberFromForm(data, 'retryMaxSeconds'),
    rolloutBasisPoints: numberFromForm(data, 'rolloutBasisPoints'),
    dailyRequestBudget: numberFromForm(data, 'dailyRequestBudget'),
    dailyTokenBudget: numberFromForm(data, 'dailyTokenBudget'),
    schemaFailureTripBasisPoints: numberFromForm(
      data,
      'schemaFailureTripBasisPoints',
    ),
    disagreementTripBasisPoints: numberFromForm(
      data,
      'disagreementTripBasisPoints',
    ),
    rollbackTripBasisPoints: numberFromForm(data, 'rollbackTripBasisPoints'),
    mutationVolumeTripCount: numberFromForm(data, 'mutationVolumeTripCount'),
    rawResponseRetentionSeconds: numberFromForm(
      data,
      'rawResponseRetentionSeconds',
    ),
    shadowMinimumSamples: numberFromForm(data, 'shadowMinimumSamples'),
    shadowMinimumCoverageBasisPoints: numberFromForm(
      data,
      'shadowMinimumCoverageBasisPoints',
    ),
    shadowSchemaSuccessBasisPoints: numberFromForm(
      data,
      'shadowSchemaSuccessBasisPoints',
    ),
    shadowProviderAgreementBasisPoints: numberFromForm(
      data,
      'shadowProviderAgreementBasisPoints',
    ),
    promptHash: String(data.get('promptHash') || '').trim(),
    schemaHash: String(data.get('schemaHash') || '').trim(),
  }
}

export function policyInputFromPolicy(
  policy: TaxonomyPolicyAdminRecord,
): TaxonomyPolicyInput {
  const {
    id: _id,
    revision: _revision,
    active: _active,
    supersedesId: _supersedesId,
    createdBy: _createdBy,
    createdAt: _createdAt,
    ...input
  } = policy
  return input
}
export const policyFields: Array<{
  name: keyof TaxonomyPolicyInput
  label: string
  placeholder?: string
  type?: string
  min?: string
  max?: string
  maxLength?: number
  pattern?: string
}> = [
  { name: 'assignmentLimit', label: 'Assignment limit', min: '1', max: '100' },
  {
    name: 'novelEvidenceSiteThreshold',
    label: 'Novel evidence sites',
    min: '1',
    max: '100000',
  },
  {
    name: 'assignmentConfidenceMicros',
    label: 'Assignment confidence (micros)',
    min: '0',
    max: '1000000',
  },
  {
    name: 'ontologyConfidenceMicros',
    label: 'Ontology confidence (micros)',
    min: '0',
    max: '1000000',
  },
  {
    name: 'minimumMarginMicros',
    label: 'Minimum margin (micros)',
    min: '0',
    max: '1000000',
  },
  {
    name: 'hierarchyMaxDepth',
    label: 'Hierarchy max depth',
    min: '1',
    max: '32',
  },
  {
    name: 'hierarchyMaxFanout',
    label: 'Hierarchy max fanout',
    min: '1',
    max: '1000',
  },
  {
    name: 'ontologyProviderAgreement',
    label: 'Provider agreement count',
    min: '1',
    max: '16',
  },
  { name: 'retryBudget', label: 'Retry budget', min: '0', max: '100' },
  {
    name: 'retryBaseSeconds',
    label: 'Retry base seconds',
    min: '1',
    max: '86400',
  },
  {
    name: 'retryMaxSeconds',
    label: 'Retry max seconds',
    min: '1',
    max: '604800',
  },
  {
    name: 'rolloutBasisPoints',
    label: 'Rollout basis points',
    min: '0',
    max: '10000',
  },
  {
    name: 'dailyRequestBudget',
    label: 'Daily request budget',
    min: '0',
    max: '10000000',
  },
  {
    name: 'dailyTokenBudget',
    label: 'Daily token budget',
    min: '0',
    max: '10000000000',
  },
  {
    name: 'schemaFailureTripBasisPoints',
    label: 'Schema failure trip (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'disagreementTripBasisPoints',
    label: 'Disagreement trip (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'rollbackTripBasisPoints',
    label: 'Rollback trip (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'mutationVolumeTripCount',
    label: 'Mutation volume trip',
    min: '0',
    max: '10000000',
  },
  {
    name: 'rawResponseRetentionSeconds',
    label: 'Raw response retention seconds',
    min: '0',
    max: '2592000',
  },
  {
    name: 'shadowMinimumSamples',
    label: 'Shadow minimum samples',
    min: '0',
    max: '10000000',
  },
  {
    name: 'shadowMinimumCoverageBasisPoints',
    label: 'Shadow coverage (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'shadowSchemaSuccessBasisPoints',
    label: 'Shadow schema success (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'shadowProviderAgreementBasisPoints',
    label: 'Shadow agreement (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'promptHash',
    label: 'Prompt SHA-256',
    type: 'text',
    placeholder: '64 lowercase hexadecimal characters',
    maxLength: 64,
    pattern: '[a-f0-9]{64}',
  },
  {
    name: 'schemaHash',
    label: 'Schema SHA-256',
    type: 'text',
    placeholder: '64 lowercase hexadecimal characters',
    maxLength: 64,
    pattern: '[a-f0-9]{64}',
  },
]
export const defaultTaxonomyPolicy = {
  assignmentLimit: 12,
  novelEvidenceSiteThreshold: 3,
  assignmentConfidenceMicros: 850_000,
  ontologyConfidenceMicros: 920_000,
  minimumMarginMicros: 150_000,
  hierarchyMaxDepth: 3,
  hierarchyMaxFanout: 24,
  ontologyProviderAgreement: 2,
  retryBudget: 5,
  retryBaseSeconds: 60,
  retryMaxSeconds: 3_600,
  rolloutBasisPoints: 0,
  dailyRequestBudget: 250,
  dailyTokenBudget: 500_000,
  schemaFailureTripBasisPoints: 500,
  disagreementTripBasisPoints: 2_000,
  rollbackTripBasisPoints: 1_000,
  mutationVolumeTripCount: 100,
  rawResponseRetentionSeconds: 604_800,
  shadowMinimumSamples: 20,
  shadowMinimumCoverageBasisPoints: 9_000,
  shadowSchemaSuccessBasisPoints: 9_800,
  shadowProviderAgreementBasisPoints: 8_000,
  promptHash: '0'.repeat(64),
  schemaHash: '0'.repeat(64),
}
