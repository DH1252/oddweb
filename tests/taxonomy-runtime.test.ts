import assert from 'node:assert/strict'
import test from 'node:test'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

import {
  boundedLimit,
  consensusValues,
  decryptStoredProviderCredential,
  encryptStoredProviderCredential,
  graphAcceptsParent,
  ontologyProposalResponseSchema,
  parseQueueMessage,
  permitsMutation,
  resolveTaxonomyMasterKey,
  retryDelaySeconds,
  rolloutSelected,
  TaxonomyRepository,
  TaxonomyService,
} from '../src/taxonomy'

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

test('runtime bounds limits and exponential retry settlement', () => {
  assert.equal(boundedLimit(undefined, 25, 100), 25)
  assert.equal(boundedLimit(500, 25, 100), 100)
  assert.throws(() => boundedLimit(0, 25, 100), /positive/)
  assert.equal(retryDelaySeconds(1, 60, 3_600), 60)
  assert.equal(retryDelaySeconds(4, 60, 3_600), 480)
  assert.equal(retryDelaySeconds(20, 60, 3_600), 3_600)
})

test('queue contracts accept only a job id', () => {
  assert.deepEqual(parseQueueMessage({ jobId: 'job-1' }), { jobId: 'job-1' })
  assert.throws(() => parseQueueMessage('job-1'), /only jobId/)
  assert.throws(
    () => parseQueueMessage({ jobId: 'job-1', provider: 'untrusted' }),
    /only jobId/,
  )
})

test('consensus counts each provider at most once', () => {
  const values = consensusValues(
    [
      [{ id: 'a' }, { id: 'a' }, { id: 'b' }],
      [{ id: 'a' }, { id: 'c' }],
      [{ id: 'c' }],
    ],
    ({ id }) => id,
    2,
  )
  assert.deepEqual(values.map(({ id }) => id).sort(), ['a', 'c'])
})

test('parent guards reject cycles, depth overflow, and fanout overflow', () => {
  const edges = [
    { parentId: 1, childId: 2 },
    { parentId: 2, childId: 3 },
  ]
  assert.equal(graphAcceptsParent(edges, 3, 1, 4, 4), false)
  assert.equal(graphAcceptsParent(edges, 3, 4, 3, 4), false)
  assert.equal(graphAcceptsParent(edges, 3, 4, 4, 4), true)
  assert.equal(
    graphAcceptsParent(
      [
        { parentId: 1, childId: 2 },
        { parentId: 1, childId: 3 },
      ],
      1,
      4,
      4,
      2,
    ),
    false,
  )
})

test('gradual rollout is stable and shadow never mutates', async () => {
  const first = await rolloutSelected('site:7:tag:3', 5_000)
  assert.equal(await rolloutSelected('site:7:tag:3', 5_000), first)
  assert.equal(await rolloutSelected('anything', 0), false)
  assert.equal(await rolloutSelected('anything', 10_000), true)
  assert.equal(await permitsMutation('shadow', 'anything', 10_000), false)
  assert.equal(await permitsMutation('autonomous', 'anything', 0), true)
})

test('stored provider credentials bind provider id and key version', async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const env = {
    TAXONOMY_MASTER_KEY_V1: base64Url(key),
  }
  assert.deepEqual(resolveTaxonomyMasterKey(env, 1), key)
  const encrypted = await encryptStoredProviderCredential('provider-secret', {
    providerId: 17,
    keyVersion: 1,
    env,
    nonce: new Uint8Array(12).fill(9),
  })
  assert.equal(encrypted.ciphertext.includes('provider-secret'), false)
  assert.equal(
    await decryptStoredProviderCredential(
      {
        providerId: 17,
        keyVersion: 1,
        ...encrypted,
      },
      env,
    ),
    'provider-secret',
  )
  await assert.rejects(
    decryptStoredProviderCredential(
      { providerId: 18, keyVersion: 1, ...encrypted },
      env,
    ),
    /Unable to decrypt/,
  )
})

test('ontology output has no category surface', () => {
  const proposal = {
    schemaVersion: 1,
    proposals: [
      {
        kind: 'concept',
        proposedName: 'Listening maps',
        proposedSlug: 'listening-maps',
        confidence: 0.98,
        evidence: 'Observed independently on three sites.',
      },
    ],
  }
  assert.equal(ontologyProposalResponseSchema.safeParse(proposal).success, true)
  assert.equal(
    ontologyProposalResponseSchema.safeParse({
      ...proposal,
      proposals: [{ ...proposal.proposals[0], category: 'media' }],
    }).success,
    false,
  )
})

test('D1 jobs and outbox use idempotent conditional leases and retry settlement', async (context) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-14',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  )
  context.after(() => mf.dispose())
  const db = await mf.getD1Database('DB')
  await db.exec(runtimeSchema.replace(/\s+/g, ' '))
  const repository = new TaxonomyRepository(db)
  const inserted = await repository.enqueueJob(
    {
      id: 'job-1',
      jobKey: 'site:1:hash:one',
      kind: 'classify_site',
      siteId: 1,
      inputHash: 'a'.repeat(64),
      siteContentVersion: 1,
      taxonomyVersion: 1,
      maxAttempts: 2,
    },
    100,
  )
  assert.equal(inserted, true)
  assert.equal(
    await repository.enqueueJob(
      {
        id: 'duplicate-id-is-ignored',
        jobKey: 'site:1:hash:one',
        kind: 'classify_site',
        siteId: 1,
        inputHash: 'a'.repeat(64),
        siteContentVersion: 1,
        taxonomyVersion: 1,
        maxAttempts: 2,
      },
      100,
    ),
    false,
  )
  const outbox = await repository.leaseOutbox(10, 100, 60)
  assert.equal(outbox.length, 1)
  await repository.completeOutbox(outbox[0].id, outbox[0].token, 101)

  const job = await repository.leaseJob('job-1', 'worker-a', 'lease-a', 101, 30)
  assert.ok(job)
  assert.equal(
    await repository.leaseJob('job-1', 'worker-b', 'lease-b', 102, 30),
    null,
  )
  await repository.retryJob(job, 110, 102, 'rate_limit', 'retry later')
  assert.equal((await repository.leaseOutbox(10, 109, 60)).length, 0)
  assert.equal((await repository.leaseOutbox(10, 110, 60)).length, 1)
  const retried = await repository.leaseJob(
    'job-1',
    'worker-b',
    'lease-b',
    110,
    30,
  )
  assert.ok(retried)
  await repository.settleJob(retried, 'settled', 111)
  assert.equal(
    await repository.leaseJob('job-1', 'worker-c', 'lease-c', 200, 30),
    null,
  )
})

test('admin primitives persist encrypted provider and immutable policy revisions', async (context) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-14',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  )
  context.after(() => mf.dispose())
  const db = await mf.getD1Database('DB')
  await db.exec(`${adminSchema} ${runtimeSchema}`.replace(/\s+/g, ' '))
  const env = {
    DB: db,
    TAXONOMY_MASTER_KEY_V1: base64Url(new Uint8Array(32).fill(3)),
    RELEASE_SHA: 'test',
  }
  const service = new TaxonomyService(env, { now: () => 1_000_000 })
  const providerId = await service.createProviderConfig({
    name: 'primary',
    providerKind: 'openai_compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'model',
    dialect: 'responses',
    keyVersion: 1,
    credential: 'provider-secret',
    enabled: true,
    actorId: 'admin',
  })
  const provider = await db
    .prepare(
      'SELECT credential_ciphertext AS ciphertext, enabled FROM taxonomy_provider_configs WHERE id = ?',
    )
    .bind(providerId)
    .first<{ ciphertext: string; enabled: number }>()
  assert.equal(provider?.ciphertext.includes('provider-secret'), false)
  assert.equal(provider?.enabled, 1)
  assert.equal(await service.activateProvider(providerId), true)
  let authorization = ''
  const tested = await new TaxonomyService(env, {
    now: () => 1_000_000,
    fetch: async (_input, init) => {
      authorization = String(
        (init?.headers as Record<string, string>).authorization,
      )
      return Response.json({
        id: 'provider-test-request',
        output_text: '{"ok":true}',
      })
    },
  }).testProvider(providerId, ['api.openai.com'])
  assert.equal(authorization, 'Bearer provider-secret')
  assert.equal(tested.ok, true)
  assert.equal(tested.providerRequestId, 'provider-test-request')
  assert.ok(tested.latencyMs >= 0)

  const policyId = await service.createPolicyRevision(
    {
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
    },
    'admin',
  )
  assert.equal(await service.activatePolicy(policyId), true)
  await assert.rejects(
    service.setMode('gradual'),
    /requires.*shadow-mode gate/i,
  )
  await service.setMode('shadow')
  await assert.rejects(
    service.setMode('gradual'),
    /thresholds have not been met/i,
  )
})

const runtimeSchema = `
CREATE TABLE taxonomy_jobs (
  id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  site_id INTEGER, concept_key TEXT, input_hash TEXT NOT NULL,
  site_content_version INTEGER, taxonomy_version INTEGER NOT NULL,
  provider_config_id INTEGER, policy_config_id INTEGER, batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL, lease_owner TEXT, lease_token TEXT,
  leased_until INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL, last_error_code TEXT, last_error_summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE TABLE taxonomy_outbox (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL DEFAULT 'taxonomy_jobs',
  payload TEXT NOT NULL, available_at INTEGER NOT NULL, lease_token TEXT,
  leased_until INTEGER, dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  dispatched_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE taxonomy_job_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  provider_config_id INTEGER NOT NULL, status TEXT NOT NULL, provider_request_id TEXT,
  provider_model TEXT NOT NULL, request_hash TEXT NOT NULL, response_hash TEXT,
  raw_response TEXT, raw_response_expires_at INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, latency_ms INTEGER, error_code TEXT, error_summary TEXT,
  started_at INTEGER NOT NULL, completed_at INTEGER
);
`

const adminSchema = `
CREATE TABLE taxonomy_provider_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, revision INTEGER NOT NULL,
  provider_kind TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, dialect TEXT,
  routing_group TEXT NOT NULL, routing_role TEXT NOT NULL, routing_priority INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL, key_version INTEGER NOT NULL, credential_nonce TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL, credential_fingerprint TEXT NOT NULL,
  enabled INTEGER NOT NULL, supersedes_id INTEGER, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(name, revision)
);
CREATE TABLE taxonomy_policy_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL UNIQUE,
  assignment_limit INTEGER NOT NULL, novel_evidence_site_threshold INTEGER NOT NULL,
  assignment_confidence_micros INTEGER NOT NULL, ontology_confidence_micros INTEGER NOT NULL,
  minimum_margin_micros INTEGER NOT NULL, hierarchy_max_depth INTEGER NOT NULL,
  hierarchy_max_fanout INTEGER NOT NULL, ontology_provider_agreement INTEGER NOT NULL,
  retry_budget INTEGER NOT NULL, retry_base_seconds INTEGER NOT NULL,
  retry_max_seconds INTEGER NOT NULL, rollout_basis_points INTEGER NOT NULL,
  daily_request_budget INTEGER NOT NULL, daily_token_budget INTEGER NOT NULL,
  schema_failure_trip_basis_points INTEGER NOT NULL,
  disagreement_trip_basis_points INTEGER NOT NULL, rollback_trip_basis_points INTEGER NOT NULL,
  mutation_volume_trip_count INTEGER NOT NULL, raw_response_retention_seconds INTEGER NOT NULL,
  shadow_minimum_samples INTEGER NOT NULL, shadow_minimum_coverage_basis_points INTEGER NOT NULL,
  shadow_schema_success_basis_points INTEGER NOT NULL,
  shadow_provider_agreement_basis_points INTEGER NOT NULL, prompt_hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL, supersedes_id INTEGER, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE taxonomy_state (
  id INTEGER PRIMARY KEY, published_version INTEGER NOT NULL,
  active_provider_config_id INTEGER, active_policy_config_id INTEGER,
  mode TEXT NOT NULL, circuit_state TEXT NOT NULL, circuit_reason TEXT,
  circuit_opened_at INTEGER, mode_changed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO taxonomy_state
  (id, published_version, mode, circuit_state, mode_changed_at, created_at, updated_at)
VALUES (1, 1, 'disabled', 'closed', 0, 0, 0);
CREATE TABLE taxonomy_change_batches (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, expected_taxonomy_version INTEGER NOT NULL,
  resulting_taxonomy_version INTEGER, parent_batch_id TEXT, rollback_of_batch_id TEXT,
  summary TEXT NOT NULL, created_at INTEGER NOT NULL, applied_at INTEGER,
  completed_at INTEGER
);
CREATE TABLE taxonomy_audit_events (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, job_id TEXT, decision_id TEXT,
  event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, provider_config_id INTEGER,
  provider_model TEXT, policy_config_id INTEGER, prompt_hash TEXT, schema_hash TEXT,
  input_hash TEXT, taxonomy_version_before INTEGER NOT NULL,
  taxonomy_version_after INTEGER NOT NULL, scores TEXT NOT NULL, evidence TEXT NOT NULL,
  before TEXT NOT NULL, after TEXT NOT NULL, release_sha TEXT NOT NULL,
  rollback_of_event_id TEXT, compensates_event_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE sites (
  id INTEGER PRIMARY KEY, status TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  content_version INTEGER NOT NULL DEFAULT 1
);
`
