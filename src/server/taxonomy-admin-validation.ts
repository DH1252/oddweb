import { z } from 'zod'

import { validateProviderEndpoint } from '../taxonomy/endpoint'

export const taxonomyProviderHostAllowlist = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
] as const

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const basisPoints = z.number().int().min(0).max(10_000)
const micros = z.number().int().min(0).max(1_000_000)
const policyConfigId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const providerBase = {
  name: z.string().trim().min(1).max(100),
  endpoint: z.string().trim().url().max(500),
  model: z.string().trim().min(1).max(200),
  routingGroup: z.string().trim().min(1).max(100),
  routingRole: z.enum(['primary', 'failover', 'consensus']),
  routingPriority: z.number().int().min(0).max(10_000),
  timeoutMs: z.number().int().min(1_000).max(120_000),
  apiKey: z.string().min(1).max(5_000),
  enabled: z.boolean(),
}

export const taxonomyProviderCreateSchema = z
  .discriminatedUnion('providerKind', [
    z.strictObject({
      ...providerBase,
      providerKind: z.literal('openai_compatible'),
      dialect: z.enum(['responses', 'chat_completions']),
    }),
    z.strictObject({
      ...providerBase,
      providerKind: z.literal('gemini'),
      dialect: z.null(),
    }),
  ])
  .superRefine((input, context) => {
    try {
      validateProviderEndpoint(input.endpoint, {
        allowedHosts: taxonomyProviderHostAllowlist,
      })
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['endpoint'],
        message:
          error instanceof Error ? error.message : 'Invalid provider endpoint',
      })
    }
  })

const providerUpdateBase = {
  providerConfigId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(100).optional(),
  endpoint: z.string().trim().url().max(500).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  routingGroup: z.string().trim().min(1).max(100).optional(),
  routingRole: z.enum(['primary', 'failover', 'consensus']).optional(),
  routingPriority: z.number().int().min(0).max(10_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  apiKey: z.string().min(1).max(5_000).optional(),
}

export const taxonomyProviderUpdateSchema = z
  .discriminatedUnion('providerKind', [
    z.strictObject({
      ...providerUpdateBase,
      providerKind: z.literal('openai_compatible'),
      dialect: z.enum(['responses', 'chat_completions']).optional(),
    }),
    z.strictObject({
      ...providerUpdateBase,
      providerKind: z.literal('gemini'),
      dialect: z.null().optional(),
    }),
  ])
  .superRefine((input, context) => {
    if (!input.endpoint) return
    try {
      validateProviderEndpoint(input.endpoint, {
        allowedHosts: taxonomyProviderHostAllowlist,
      })
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['endpoint'],
        message:
          error instanceof Error ? error.message : 'Invalid provider endpoint',
      })
    }
  })

export const taxonomyPolicyCreateSchema = z.strictObject({
  assignmentLimit: z.number().int().min(1).max(100),
  novelEvidenceSiteThreshold: z.number().int().min(1).max(100_000),
  assignmentConfidenceMicros: micros,
  ontologyConfidenceMicros: micros,
  minimumMarginMicros: micros,
  hierarchyMaxDepth: z.number().int().min(1).max(32),
  hierarchyMaxFanout: z.number().int().min(1).max(1_000),
  ontologyProviderAgreement: z.number().int().min(1).max(16),
  retryBudget: z.number().int().min(0).max(100),
  retryBaseSeconds: z.number().int().min(1).max(86_400),
  retryMaxSeconds: z.number().int().min(1).max(604_800),
  rolloutBasisPoints: basisPoints,
  dailyRequestBudget: z.number().int().min(0).max(10_000_000),
  dailyTokenBudget: z.number().int().min(0).max(10_000_000_000),
  schemaFailureTripBasisPoints: basisPoints,
  disagreementTripBasisPoints: basisPoints,
  rollbackTripBasisPoints: basisPoints,
  mutationVolumeTripCount: z.number().int().min(0).max(10_000_000),
  rawResponseRetentionSeconds: z.number().int().min(0).max(2_592_000),
  shadowMinimumSamples: z.number().int().min(0).max(10_000_000),
  shadowMinimumCoverageBasisPoints: basisPoints,
  shadowSchemaSuccessBasisPoints: basisPoints,
  shadowProviderAgreementBasisPoints: basisPoints,
  promptHash: hash,
  schemaHash: hash,
})

export const taxonomyPolicyRevisionSchema = taxonomyPolicyCreateSchema
  .extend({
    supersedesPolicyConfigId: policyConfigId.optional(),
  })
  .refine((input) => input.retryMaxSeconds >= input.retryBaseSeconds, {
    path: ['retryMaxSeconds'],
    message: 'retryMaxSeconds must be at least retryBaseSeconds',
  })

export type TaxonomyProviderCreateInput = z.infer<
  typeof taxonomyProviderCreateSchema
>
export type TaxonomyProviderUpdateInput = z.infer<
  typeof taxonomyProviderUpdateSchema
>
export type TaxonomyPolicyCreateInput = z.infer<
  typeof taxonomyPolicyCreateSchema
>
export type TaxonomyPolicyRevisionInput = z.infer<
  typeof taxonomyPolicyRevisionSchema
>
