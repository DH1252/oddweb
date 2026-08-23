import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listTaxonomyCandidates,
  listTaxonomyPolicies,
  listTaxonomyProviders,
  readTaxonomyDashboard,
} from '../src/db/taxonomy-admin-repository'
import { TaxonomyService } from '../src/taxonomy'
import { insertSite, masterKey, migratedTaxonomyDb } from './taxonomy-test-db'

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

function service(db: D1Database) {
  return new TaxonomyService({
    DB: db,
    RELEASE_SHA: 'admin-repository-test',
    TAXONOMY_MASTER_KEY_V1: masterKey,
  })
}

test('dashboard renders a missing active policy as unconfigured and blocked', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await db
    .prepare(
      'UPDATE taxonomy_state SET active_policy_config_id = NULL WHERE id = 1',
    )
    .run()

  const dashboard = await readTaxonomyDashboard(db)

  assert.equal(dashboard.state.activePolicyConfigId, null)
  assert.equal(dashboard.health.budget.requestLimit, null)
  assert.equal(dashboard.readiness.thresholds.samples, null)
  assert.equal(dashboard.readiness.checks.policyConfigured, false)
  assert.equal(dashboard.readiness.readyForGradual, false)
})

test('provider and policy admin records paginate and never expose credentials', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const taxonomy = service(db)
  for (let index = 1; index <= 3; index += 1) {
    await taxonomy.createProviderConfig({
      name: `Provider ${index}`,
      providerKind: 'openai_compatible',
      endpoint: 'https://api.openai.com/v1',
      model: `model-${index}`,
      dialect: 'responses',
      keyVersion: 1,
      credential: `secret-provider-${index}`,
      enabled: false,
      actorId: 'test',
    })
    await taxonomy.createPolicyRevision(
      { ...policy, assignmentLimit: policy.assignmentLimit + index },
      'test',
    )
  }

  const providers = await listTaxonomyProviders({ page: 1, pageSize: 2 }, db)
  const policies = await listTaxonomyPolicies({ page: 1, pageSize: 2 }, db)

  assert.equal(providers.total, 3)
  assert.equal(providers.page, 1)
  assert.equal(providers.items.length, 1)
  assert.equal(policies.total, 4)
  assert.equal(policies.page, 1)
  assert.equal(policies.items.length, 2)
  const serialized = JSON.stringify(providers)
  assert.equal(serialized.includes('secret-provider'), false)
  assert.equal(serialized.includes('credentialCiphertext'), false)
  assert.equal(serialized.includes('credentialNonce'), false)
  assert.match(
    providers.items[0]?.credentialFingerprint ?? '',
    /^\*{4}[a-f0-9]{8}$/,
  )

  const clampedProviders = await listTaxonomyProviders(
    { page: 99, pageSize: 2 },
    db,
  )
  const clampedPolicies = await listTaxonomyPolicies(
    { page: 99, pageSize: 2 },
    db,
  )
  assert.equal(clampedProviders.page, 1)
  assert.equal(clampedProviders.items.length, 1)
  assert.equal(clampedPolicies.page, 1)
  assert.equal(clampedPolicies.items.length, 2)
})

test('candidate evidence exposes its stable database identity', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const taxonomy = service(db)
  await insertSite(db, 1)
  const jobId = await taxonomy.forceConceptReassessment('shared evidence')
  assert.ok(jobId)

  await db.batch([
    db
      .prepare(
        `INSERT INTO taxonomy_candidates
         (id, job_id, candidate_key, kind, normalized_concept, proposed_name,
          proposed_slug, payload, confidence_micros, rank)
         VALUES ('candidate-with-evidence', ?, 'concept:shared-evidence',
                 'novel_concept', 'shared evidence', 'Shared Evidence',
                 'shared-evidence', '{}', 950000, 0)`,
      )
      .bind(jobId),
    db.prepare(
      `INSERT INTO taxonomy_concept_evidence
       (id, normalized_concept, site_id, input_hash, source_key, source,
        evidence_hash, evidence_snippet, confidence_micros, accepted, observed_at)
       VALUES ('evidence-a', 'shared evidence', 1, '${'a'.repeat(64)}',
               'source-a', 'deterministic', '${'c'.repeat(64)}',
               'Identical visible evidence', 900000, 1, 1000)`,
    ),
    db.prepare(
      `INSERT INTO taxonomy_concept_evidence
       (id, normalized_concept, site_id, input_hash, source_key, source,
        evidence_hash, evidence_snippet, confidence_micros, accepted, observed_at)
       VALUES ('evidence-b', 'shared evidence', 1, '${'b'.repeat(64)}',
               'source-b', 'deterministic', '${'d'.repeat(64)}',
               'Identical visible evidence', 900000, 1, 1000)`,
    ),
  ])

  const candidates = await listTaxonomyCandidates(
    { page: 0, pageSize: 10, status: null, kind: null },
    db,
  )

  assert.deepEqual(
    candidates.items[0]?.evidence.map((evidence) => evidence.id).sort(),
    ['evidence-a', 'evidence-b'],
  )
})
