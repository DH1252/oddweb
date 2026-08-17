import assert from 'node:assert/strict'
import test from 'node:test'

import {
  taxonomyPolicyCreateSchema,
  taxonomyProviderCreateSchema,
} from '../src/server/taxonomy-admin-validation'

test('taxonomy control-plane mutations publish synchronization events', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(
      new URL('../src/server/taxonomy-admin.ts', import.meta.url),
      'utf8',
    ),
  )
  assert.match(
    source,
    /publishRealtimeEvent\(\{ type: 'taxonomy\.changed' \}\)/,
  )
  assert.match(
    source,
    /triggerTaxonomyBackfill[\s\S]*dispatchTaxonomyOutbox\(env, \{ limit: 100 \}\)/,
  )
})

const provider = {
  name: 'OpenAI primary',
  providerKind: 'openai_compatible' as const,
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-test',
  dialect: 'responses' as const,
  routingGroup: 'default',
  routingRole: 'primary' as const,
  routingPriority: 0,
  timeoutMs: 15_000,
  apiKey: 'secret',
  enabled: false,
}

const policy = {
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
  promptHash: 'a'.repeat(64),
  schemaHash: 'b'.repeat(64),
}

test('taxonomy provider admin input is strict and host allowlisted', () => {
  assert.equal(taxonomyProviderCreateSchema.safeParse(provider).success, true)
  assert.equal(
    taxonomyProviderCreateSchema.safeParse({
      ...provider,
      endpoint: 'https://provider.attacker.example/v1',
    }).success,
    false,
  )
  assert.equal(
    taxonomyProviderCreateSchema.safeParse({
      ...provider,
      endpoint: 'https://127.0.0.1/v1',
    }).success,
    false,
  )
  assert.equal(
    taxonomyProviderCreateSchema.safeParse({
      ...provider,
      apiKeyCopy: 'secret',
    }).success,
    false,
  )
  assert.equal(
    taxonomyProviderCreateSchema.safeParse({
      ...provider,
      providerKind: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      dialect: 'responses',
    }).success,
    false,
  )
})

test('taxonomy policy admin input enforces bounds and retry ordering', () => {
  assert.equal(taxonomyPolicyCreateSchema.safeParse(policy).success, true)
  assert.equal(
    taxonomyPolicyCreateSchema.safeParse({
      ...policy,
      retryMaxSeconds: policy.retryBaseSeconds - 1,
    }).success,
    false,
  )
  assert.equal(
    taxonomyPolicyCreateSchema.safeParse({
      ...policy,
      rolloutBasisPoints: 10_001,
    }).success,
    false,
  )
  assert.equal(
    taxonomyPolicyCreateSchema.safeParse({ ...policy, extra: true }).success,
    false,
  )
})
