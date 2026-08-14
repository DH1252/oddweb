import { z } from 'zod'

import type { SiteDecision, SiteTagDecision } from './contracts'

export const taxonomyPolicySchema = z.strictObject({
  autoAssignThreshold: z.number().finite().min(0).max(1),
  reviewThreshold: z.number().finite().min(0).max(1),
  minimumMargin: z.number().finite().min(0).max(1),
  maxAutomaticAssignments: z.number().int().min(0).max(25),
  maxResponseBytes: z.number().int().min(1_024).max(5_000_000),
  timeoutMs: z.number().int().min(100).max(120_000),
  maxRetries: z.number().int().min(0).max(5),
  circuitFailureThreshold: z.number().int().min(1).max(100),
  circuitWindowMs: z.number().int().min(1_000).max(3_600_000),
  circuitCooldownMs: z.number().int().min(1_000).max(86_400_000),
})

export type TaxonomyPolicy = z.infer<typeof taxonomyPolicySchema>

export const defaultTaxonomyPolicy: Readonly<TaxonomyPolicy> = Object.freeze({
  autoAssignThreshold: 0.9,
  reviewThreshold: 0.65,
  minimumMargin: 0.15,
  maxAutomaticAssignments: 5,
  maxResponseBytes: 256_000,
  timeoutMs: 20_000,
  maxRetries: 2,
  circuitFailureThreshold: 5,
  circuitWindowMs: 60_000,
  circuitCooldownMs: 300_000,
})

export function parseTaxonomyPolicy(
  input: Partial<TaxonomyPolicy> = {},
): TaxonomyPolicy {
  const policy = taxonomyPolicySchema.parse({
    ...defaultTaxonomyPolicy,
    ...input,
  })
  if (policy.reviewThreshold > policy.autoAssignThreshold) {
    throw new TypeError('reviewThreshold cannot exceed autoAssignThreshold')
  }
  return policy
}

export interface ValidatedSiteDecisions {
  automatic: SiteTagDecision[]
  review: SiteTagDecision[]
  rejected: SiteTagDecision[]
  violations: string[]
}

export function validateSiteDecisions(
  response: SiteDecision,
  knownTagIds: ReadonlySet<string>,
  policyInput: Partial<TaxonomyPolicy> = {},
): ValidatedSiteDecisions {
  const policy = parseTaxonomyPolicy(policyInput)
  const automatic: SiteTagDecision[] = []
  const review: SiteTagDecision[] = []
  const rejected: SiteTagDecision[] = []
  const violations: string[] = []
  const seen = new Set<string>()

  for (const decision of response.decisions) {
    if (seen.has(decision.tagId)) {
      violations.push(`duplicate tag decision: ${decision.tagId}`)
      continue
    }
    seen.add(decision.tagId)

    if (!knownTagIds.has(decision.tagId)) {
      violations.push(`unknown tag: ${decision.tagId}`)
      rejected.push(decision)
      continue
    }
    if (decision.decision === 'do_not_assign') {
      rejected.push(decision)
      continue
    }

    if (
      decision.decision === 'assign' &&
      decision.confidence >= policy.autoAssignThreshold &&
      decision.margin >= policy.minimumMargin &&
      automatic.length < policy.maxAutomaticAssignments
    ) {
      automatic.push(decision)
    } else if (decision.confidence >= policy.reviewThreshold) {
      review.push(decision)
    } else {
      rejected.push(decision)
    }
  }

  return { automatic, review, rejected, violations }
}

export interface CircuitState {
  failures: readonly number[]
  openedAt?: number
}

export function circuitStatus(
  state: CircuitState,
  now: number,
  policyInput: Partial<TaxonomyPolicy> = {},
): 'closed' | 'open' | 'half_open' {
  const policy = parseTaxonomyPolicy(policyInput)
  if (state.openedAt !== undefined) {
    return now - state.openedAt >= policy.circuitCooldownMs
      ? 'half_open'
      : 'open'
  }
  const recentFailures = state.failures.filter(
    (timestamp) => now - timestamp <= policy.circuitWindowMs,
  )
  return recentFailures.length >= policy.circuitFailureThreshold
    ? 'open'
    : 'closed'
}
