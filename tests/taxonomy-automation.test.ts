import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dispatchTaxonomyOutbox,
  processTaxonomyQueueBatch,
  processTaxonomyMessage,
  rolloutSelected,
  runTaxonomyMaintenance,
  TaxonomyRepository,
  TaxonomyService,
} from '../src/taxonomy'
import { commitSubmissionReapproval } from '../src/taxonomy/lifecycle'
import { sha256Hex } from '../src/taxonomy/normalize'
import { updateSiteFromSnapshot } from '../src/taxonomy/site-update'
import type { SiteUpdateSnapshot } from '../src/taxonomy/site-update'
import {
  insertSite,
  insertTag,
  masterKey,
  migratedTaxonomyDb,
} from './taxonomy-test-db'

const hash = 'a'.repeat(64)

function providerDecision(
  tagId: number,
  decision: 'assign' | 'do_not_assign' = 'assign',
) {
  return {
    schemaVersion: 1,
    decisions: [
      {
        tagId: String(tagId),
        decision,
        confidence: 0.99,
        margin: 0.5,
        evidence: `Evidence for tag ${tagId}`,
      },
    ],
  }
}

async function addProvider(
  service: TaxonomyService,
  input: {
    name: string
    credential: string
    role: 'primary' | 'failover' | 'consensus'
    priority: number
  },
) {
  return service.createProviderConfig({
    name: input.name,
    providerKind: 'openai_compatible',
    endpoint: 'https://api.openai.com/v1',
    model: input.name,
    dialect: 'responses',
    routingGroup: 'test-route',
    routingRole: input.role,
    routingPriority: input.priority,
    keyVersion: 1,
    credential: input.credential,
    enabled: true,
    actorId: 'test',
  })
}

function serviceEnv(db: D1Database) {
  return {
    DB: db,
    RELEASE_SHA: 'test-release',
    TAXONOMY_MASTER_KEY_V1: masterKey,
  }
}

function mockQueue(
  sendMessage: (message: unknown) => Promise<void> = async () => undefined,
): Queue {
  const metrics = { backlogCount: 0, backlogBytes: 0 }
  return {
    metrics: async () => metrics,
    send: async (message) => {
      await sendMessage(message)
      return { metadata: { metrics } }
    },
    sendBatch: async (messages) => {
      for (const message of messages) await sendMessage(message.body)
      return { metadata: { metrics } }
    },
  }
}

test('gradual rollout is deterministic, monotonic, and approximately weighted', async () => {
  const keys = Array.from({ length: 1_000 }, (_, index) => `site:${index}`)
  const quarter = await Promise.all(
    keys.map(async (key) => [key, await rolloutSelected(key, 2_500)] as const),
  )
  const half = await Promise.all(
    keys.map(async (key) => [key, await rolloutSelected(key, 5_000)] as const),
  )
  const repeated = await Promise.all(
    keys.map((key) => rolloutSelected(key, 2_500)),
  )
  assert.deepEqual(
    repeated,
    quarter.map(([, selected]) => selected),
  )
  assert.ok(
    quarter.every(
      ([key, selected]) =>
        !selected || half.find(([value]) => value === key)?.[1],
    ),
  )
  assert.ok(quarter.filter(([, selected]) => selected).length > 200)
  assert.ok(quarter.filter(([, selected]) => selected).length < 300)
})

test('outbox delivery retries, lease expiry, duplicate delivery, and dead settlement are conservative', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const repository = new TaxonomyRepository(db)
  await insertSite(db, 1)
  assert.equal(
    await repository.enqueueJob(
      {
        id: 'job-retry',
        jobKey: 'job-key-retry',
        kind: 'classify_site',
        siteId: 1,
        inputHash: hash,
        siteContentVersion: 1,
        taxonomyVersion: 1,
        policyConfigId: 1,
        maxAttempts: 2,
      },
      100,
    ),
    true,
  )
  assert.equal(
    await repository.enqueueJob(
      {
        id: 'ignored-duplicate-id',
        jobKey: 'job-key-retry',
        kind: 'classify_site',
        siteId: 1,
        inputHash: hash,
        siteContentVersion: 1,
        taxonomyVersion: 1,
        policyConfigId: 1,
        maxAttempts: 2,
      },
      100,
    ),
    false,
  )

  const firstOutbox = (await repository.leaseOutbox(10, 100, 10))[0]
  assert.ok(firstOutbox)
  await repository.failOutbox(
    firstOutbox.id,
    firstOutbox.token,
    120,
    'x'.repeat(800),
  )
  assert.equal((await repository.leaseOutbox(10, 119, 10)).length, 0)
  const retriedOutbox = (await repository.leaseOutbox(10, 120, 10))[0]
  assert.ok(retriedOutbox)
  assert.notEqual(retriedOutbox.token, firstOutbox.token)
  await repository.completeOutbox(retriedOutbox.id, firstOutbox.token, 121)
  assert.equal((await repository.leaseOutbox(10, 131, 10)).length, 1)
  const finalOutbox = (await repository.leaseOutbox(10, 142, 10))[0]
  assert.ok(finalOutbox)
  await repository.completeOutbox(finalOutbox.id, finalOutbox.token, 143)

  const firstLease = await repository.leaseJob(
    'job-retry',
    'worker-a',
    'lease-a',
    150,
    10,
  )
  assert.ok(firstLease)
  assert.equal(
    await repository.leaseJob('job-retry', 'worker-b', 'lease-b', 160, 10),
    null,
  )
  const recovered = await repository.leaseJob(
    'job-retry',
    'worker-b',
    'lease-b',
    161,
    10,
  )
  assert.ok(recovered)
  assert.equal(await repository.settleJob(firstLease, 'settled', 162), false)
  assert.equal(
    await repository.retryJob(recovered, 200, 162, 'rate_limit', 'retry'),
    true,
  )
  assert.equal(
    await db
      .prepare('SELECT status FROM taxonomy_jobs WHERE id = ?')
      .bind('job-retry')
      .first('status'),
    'dead',
  )
  assert.equal((await repository.leaseOutbox(10, 1_000, 10)).length, 0)
  assert.equal(
    await repository.leaseJob('job-retry', 'worker-c', 'lease-c', 1_000, 10),
    null,
  )
})

test('shadow records decisions without writes and never serializes credentials', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const secret = 'shadow-provider-secret'
  const service = new TaxonomyService(env, { now: () => 1_000_000 })
  const providerId = await addProvider(service, {
    name: 'shadow-primary',
    credential: secret,
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await service.setMode('shadow')
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  let requestBody = ''
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 1_001_000,
      fetch: async (_input, init) => {
        requestBody = String(init?.body)
        return Response.json({
          output_text: JSON.stringify(providerDecision(1)),
        })
      },
    },
  )
  assert.deepEqual(result, {
    jobId,
    status: 'settled',
    attempts: 1,
    mutations: 0,
  })
  assert.equal(
    await db.prepare('SELECT count(*) AS count FROM site_tags').first('count'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT outcome FROM tag_assignment_decisions')
      .first('outcome'),
    'shadow',
  )
  assert.equal(requestBody.includes(secret), false)
  const serialized = await db
    .prepare(
      `SELECT group_concat(value, '|') AS value FROM (
         SELECT payload AS value FROM taxonomy_outbox
         UNION ALL SELECT payload FROM taxonomy_candidates
         UNION ALL SELECT coalesce(raw_response, '') FROM taxonomy_job_attempts
         UNION ALL SELECT before || after || evidence || scores FROM taxonomy_audit_events
       )`,
    )
    .first<string>('value')
  assert.equal(serialized?.includes(secret), false)
  const stored = await db
    .prepare(
      'SELECT credential_ciphertext FROM taxonomy_provider_configs WHERE id = ?',
    )
    .bind(providerId)
    .first<string>('credential_ciphertext')
  assert.equal(stored?.includes(secret), false)
})

test('primary failover plus provider consensus mutates once and honors assignment locks', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  await insertTag(db, 2)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 2_000_000 })
  const primaryId = await addProvider(service, {
    name: 'primary',
    credential: 'primary-secret',
    role: 'primary',
    priority: 0,
  })
  await addProvider(service, {
    name: 'failover',
    credential: 'failover-secret',
    role: 'failover',
    priority: 1,
  })
  await addProvider(service, {
    name: 'consensus',
    credential: 'consensus-secret',
    role: 'consensus',
    priority: 2,
  })
  await service.activateProvider(primaryId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  await service.createLock({
    scope: 'site_assignment',
    siteId: 1,
    tagId: 2,
    reason: 'manual ownership',
    actorId: 'admin',
  })
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const calls: string[] = []
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 2_001_000,
      fetch: async (_input, init) => {
        const authorization = String(
          (init?.headers as Record<string, string>).authorization,
        )
        calls.push(authorization)
        if (authorization.includes('primary-secret')) {
          return Response.json({}, { status: 503 })
        }
        return Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            decisions: [
              providerDecision(1).decisions[0],
              providerDecision(2).decisions[0],
            ],
          }),
        })
      },
    },
  )
  assert.equal(result.status, 'settled')
  assert.equal(result.mutations, 1)
  assert.deepEqual(calls, [
    'Bearer primary-secret',
    'Bearer failover-secret',
    'Bearer consensus-secret',
  ])
  assert.deepEqual(
    (
      await db
        .prepare('SELECT tag_id AS tagId FROM site_tags ORDER BY tag_id')
        .all<{ tagId: number }>()
    ).results,
    [{ tagId: 1 }],
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          'SELECT tag_id AS tagId, outcome FROM tag_assignment_decisions ORDER BY tag_id',
        )
        .all()
    ).results,
    [
      { tagId: 1, outcome: 'applied' },
      { tagId: 2, outcome: 'locked' },
    ],
  )
})

test('provider disagreement retries, then dies without applying either opinion', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 3_000_000 })
  const primaryId = await addProvider(service, {
    name: 'disagree-primary',
    credential: 'assign-secret',
    role: 'primary',
    priority: 0,
  })
  await addProvider(service, {
    name: 'disagree-consensus',
    credential: 'reject-secret',
    role: 'consensus',
    priority: 1,
  })
  await service.activateProvider(primaryId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET retry_budget = 1,
       disagreement_trip_basis_points = 10000 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = String(
      (init?.headers as Record<string, string>).authorization,
    )
    return Response.json({
      output_text: JSON.stringify(
        providerDecision(
          1,
          authorization.includes('assign-secret') ? 'assign' : 'do_not_assign',
        ),
      ),
    })
  }
  const runtimeEnv = {
    ...env,
    TAXONOMY_QUEUE: mockQueue(),
  }
  assert.equal(
    (
      await processTaxonomyMessage({ jobId }, runtimeEnv, {
        now: () => 3_001_000,
        fetch,
      })
    ).status,
    'retry_wait',
  )
  assert.equal(
    (
      await processTaxonomyMessage({ jobId }, runtimeEnv, {
        now: () => 3_030_000,
        fetch,
      })
    ).status,
    'ignored',
  )
  assert.equal(
    (
      await processTaxonomyMessage({ jobId }, runtimeEnv, {
        now: () => 3_061_000,
        fetch,
      })
    ).status,
    'degraded',
  )
  assert.equal(
    await db.prepare('SELECT count(*) AS count FROM site_tags').first('count'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT status FROM taxonomy_jobs WHERE id = ?')
      .bind(jobId)
      .first('status'),
    'dead',
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) AS count FROM tag_assignment_decisions')
      .first('count'),
    0,
  )
})

test('mode gates require configuration, readiness metrics, ordering, and a closed circuit', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 4_000_000 })
  await assert.rejects(service.setMode('shadow'), /provider is required/i)
  const providerId = await addProvider(service, {
    name: 'mode-provider',
    credential: 'mode-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await service.setMode('shadow')
  await assert.rejects(
    service.setMode('gradual'),
    /thresholds have not been met/i,
  )
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET shadow_minimum_samples = 0,
       shadow_minimum_coverage_basis_points = 0,
       shadow_schema_success_basis_points = 0,
       shadow_provider_agreement_basis_points = 0 WHERE id = 1`,
    )
    .run()
  await assert.rejects(
    service.setMode('gradual'),
    /thresholds have not been met/i,
  )
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET shadow_minimum_samples = 20,
        shadow_minimum_coverage_basis_points = 9000,
        shadow_schema_success_basis_points = 9800,
        shadow_provider_agreement_basis_points = 8000 WHERE id = 1`,
    )
    .run()
  await insertSite(db, 1)
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, site_id, input_hash, site_content_version, taxonomy_version,
        provider_config_id, policy_config_id, status, max_attempts, available_at,
        created_at, updated_at, completed_at)
       VALUES ('ready-job', 'ready-key', 'classify_site', 1, ?, 1, 1, ?, 1,
                'settled', 1, 3999, 3999, 3999, 3999)`,
    )
    .bind(hash, providerId)
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, input_tokens, output_tokens, started_at, completed_at)
        VALUES ('ready-attempt', 'ready-job', 1, ?, 'invalid_response', 'model', ?, 1, 1, 3999, 3999)`,
    )
    .bind(providerId, hash)
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, input_tokens, output_tokens, started_at, completed_at)
       VALUES ('ready-retry', 'ready-job', 2, ?, 'succeeded', 'model', ?, 1, 1, 4000, 4000)`,
    )
    .bind(providerId, hash)
    .run()
  await service.setMode('gradual')
  await service.setMode('autonomous')
  await service.repository.openCircuit('test trip', 4_001)
  await assert.rejects(service.setMode('shadow'), /circuit is not closed/i)
  await service.resetCircuit()
  assert.deepEqual(await service.repository.loadState(), {
    publishedVersion: 1,
    activeProviderConfigId: providerId,
    activePolicyConfigId: 1,
    mode: 'shadow',
    siteClassificationEnabled: true,
    circuitState: 'closed',
    circuitReason: null,
    circuitOpenedAt: null,
    modeChangedAt: 4_000,
  })
})

test('missing active policy is reported as an unsafe, non-ready state', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 4_500_000 })
  const providerId = await addProvider(service, {
    name: 'missing-policy-provider',
    credential: 'missing-policy-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_state SET active_policy_config_id = NULL, mode = 'disabled' WHERE id = 1`,
    )
    .run()
  const state = await service.repository.loadState()
  assert.equal(state.activePolicyConfigId, null)
  await assert.rejects(service.setMode('shadow'), /active taxonomy policy/i)
})

test('disabled provider cannot activate and test-and-enable changes only after a successful test', async (context) => {
  const db = await migratedTaxonomyDb(context)
  let calls = 0
  const service = new TaxonomyService(serviceEnv(db), {
    now: () => 4_600_000,
    fetch: async () => {
      calls += 1
      return Response.json({ output_text: JSON.stringify({ ok: true }) })
    },
  })
  const providerId = await service.createProviderConfig({
    name: 'disabled-provider',
    providerKind: 'openai_compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'test-model',
    dialect: 'responses',
    keyVersion: 1,
    credential: 'provider-secret',
    enabled: false,
    actorId: 'test',
  })
  await assert.rejects(
    service.activateProvider(providerId),
    /must pass a test before activation/i,
  )
  assert.equal(
    await db
      .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
      .bind(providerId)
      .first('enabled'),
    0,
  )
  assert.equal(await service.enableProvider(providerId, 'test'), true)
  assert.equal(calls, 1)
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) AS count FROM taxonomy_audit_events
         WHERE event_type = 'provider_enabled' AND entity_id = ?`,
      )
      .bind(String(providerId))
      .first('count'),
    1,
  )
})

test('failed provider test leaves a revision disabled without a false enable audit', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const taxonomy = new TaxonomyService(serviceEnv(db), {
    now: () => 4_650_000,
    fetch: async () => Response.json({}, { status: 503 }),
  })
  const providerId = await taxonomy.createProviderConfig({
    name: 'failing-provider',
    providerKind: 'openai_compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'test-model',
    dialect: 'responses',
    keyVersion: 1,
    credential: 'failed-provider-secret',
    enabled: false,
    actorId: 'test',
  })
  await assert.rejects(taxonomy.enableProvider(providerId, 'test'))
  assert.equal(
    await db
      .prepare('SELECT enabled FROM taxonomy_provider_configs WHERE id = ?')
      .bind(providerId)
      .first('enabled'),
    0,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS count FROM taxonomy_audit_events WHERE event_type = 'provider_enabled' AND entity_id = ?",
      )
      .bind(String(providerId))
      .first('count'),
    0,
  )
})

test('accepted ontology candidates are decided and queued through the guarded worker job', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 4_700_000 })
  const providerId = await addProvider(service, {
    name: 'candidate-provider',
    credential: 'candidate-secret',
    role: 'primary',
    priority: 0,
  })
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, concept_key, input_hash, taxonomy_version, policy_config_id,
        status, max_attempts, available_at, created_at, updated_at, completed_at)
       VALUES ('source-job', 'source-job-key', 'reassess_concept', 'admin concept', ?, 1, 1,
               'settled', 1, 4700, 4700, 4700, 4700)`,
    )
    .bind('c'.repeat(64))
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, started_at, completed_at)
       VALUES ('source-attempt', 'source-job', 1, ?, 'succeeded',
               'candidate-provider', ?, 4700, 4700)`,
    )
    .bind(providerId, 'd'.repeat(64))
    .run()
  await service.repository.saveCandidate({
    id: 'candidate-admin-1',
    jobId: 'source-job',
    attemptId: 'source-attempt',
    candidateKey: 'concept:admin concept',
    kind: 'novel_concept',
    normalizedConcept: 'admin concept',
    proposedName: 'Admin Concept',
    proposedSlug: 'admin-concept',
    payload: {
      kind: 'concept',
      proposedName: 'Admin Concept',
      proposedSlug: 'admin-concept',
      confidence: 0.99,
    },
    confidenceMicros: 990_000,
    rank: 0,
    now: 4_700,
  })
  const result = await service.decideCandidate({
    candidateId: 'candidate-admin-1',
    decision: 'accepted',
    reason: 'Reviewed and approved',
    actorId: 'admin',
  })
  assert.equal(result.decided, true)
  assert.ok(result.jobId)
  assert.equal(
    await db
      .prepare('SELECT status FROM taxonomy_candidates WHERE id = ?')
      .bind('candidate-admin-1')
      .first('status'),
    'accepted',
  )
  const queuedJob = await db
    .prepare('SELECT kind, concept_key FROM taxonomy_jobs WHERE id = ?')
    .bind(result.jobId)
    .first<{ kind: string; concept_key: string }>()
  assert.equal(queuedJob?.kind, 'apply_ontology')
  assert.equal(queuedJob?.concept_key, 'candidate-admin-1')
  assert.equal(
    await db
      .prepare('SELECT count(*) AS count FROM taxonomy_outbox WHERE job_id = ?')
      .bind(result.jobId)
      .first('count'),
    1,
  )
})

test('rejected, deferred, and conflict candidate decisions are terminal and never queue jobs', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const taxonomy = new TaxonomyService(serviceEnv(db), { now: () => 4_800_000 })
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, concept_key, input_hash, taxonomy_version, policy_config_id,
        status, max_attempts, available_at, created_at, updated_at, completed_at)
       VALUES ('decision-source', 'decision-source-key', 'reassess_concept',
               'decision concept', ?, 1, 1, 'settled', 1, 4800, 4800, 4800, 4800)`,
    )
    .bind('e'.repeat(64))
    .run()
  const decisions: Array<'rejected' | 'deferred' | 'conflict'> = [
    'rejected',
    'deferred',
    'conflict',
  ]
  for (const [index, decision] of decisions.entries()) {
    const candidateId = `candidate-${decision}`
    await taxonomy.repository.saveCandidate({
      id: candidateId,
      jobId: 'decision-source',
      attemptId: null,
      candidateKey: `concept:${decision}`,
      kind: 'novel_concept',
      normalizedConcept: `${decision} concept`,
      proposedName: `${decision} concept`,
      proposedSlug: `${decision}-concept`,
      payload: {
        kind: 'concept',
        proposedName: `${decision} concept`,
        proposedSlug: `${decision}-concept`,
        confidence: 0.9,
      },
      confidenceMicros: 900_000,
      rank: index,
      now: 4_800,
    })
    const result = await taxonomy.decideCandidate({
      candidateId,
      decision,
      reason: `Reviewed as ${decision}`,
      actorId: 'admin',
    })
    assert.deepEqual(result, { decided: true, jobId: null })
  }
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS count FROM taxonomy_jobs WHERE kind = 'apply_ontology'",
      )
      .first('count'),
    0,
  )
})

test('maintenance trips the circuit at schema and mutation thresholds', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 5_000_000 })
  const providerId = await addProvider(service, {
    name: 'circuit-provider',
    credential: 'circuit-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      "UPDATE taxonomy_state SET mode = 'autonomous', mode_changed_at = 0",
    )
    .run()
  await insertSite(db, 1)
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, site_id, input_hash, site_content_version, taxonomy_version,
        provider_config_id, policy_config_id, status, max_attempts, available_at,
        created_at, updated_at, completed_at)
       VALUES ('circuit-job', 'circuit-key', 'classify_site', 1, ?, 1, 1, ?, 1,
               'settled', 1, 4999, 4999, 4999, 4999)`,
    )
    .bind(hash, providerId)
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, started_at, completed_at)
       VALUES ('bad-attempt', 'circuit-job', 1, ?, 'invalid_response', 'model', ?, 4999, 4999)`,
    )
    .bind(providerId, hash)
    .run()
  await runTaxonomyMaintenance(
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    { now: () => 5_000_000 },
  )
  const state = await service.repository.loadState()
  assert.equal(state.mode, 'degraded')
  assert.equal(state.circuitState, 'open')
  assert.match(state.circuitReason ?? '', /Schema failure/)
})

test('circuit reset excludes schema failures from the prior mode epoch', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 5_100_000 })
  const providerId = await addProvider(service, {
    name: 'reset-circuit-provider',
    credential: 'reset-circuit-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await insertSite(db, 1)
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, site_id, input_hash, site_content_version, taxonomy_version,
        policy_config_id, status, max_attempts, available_at, created_at, updated_at,
        completed_at)
       VALUES ('prior-mode-job', 'prior-mode-key', 'classify_site', 1, ?, 1, 1,
               1, 'settled', 1, 5099, 5099, 5099, 5099)`,
    )
    .bind(hash)
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, started_at, completed_at)
        VALUES ('prior-mode-failure', 'prior-mode-job', 1, ?, 'invalid_response',
               'model', ?, 5099, 5099)`,
    )
    .bind(providerId, hash)
    .run()
  await db
    .prepare(
      `UPDATE taxonomy_state SET mode = 'degraded', circuit_state = 'open',
       circuit_reason = 'Schema failure threshold exceeded.', circuit_opened_at = 5099,
       mode_changed_at = 5099`,
    )
    .run()

  await service.resetCircuit()
  await runTaxonomyMaintenance(
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    { now: () => 5_100_000 },
  )

  const state = await service.repository.loadState()
  assert.equal(state.mode, 'shadow')
  assert.equal(state.circuitState, 'closed')
  assert.equal(state.circuitReason, null)
})

test('distinct-site evidence, ontology locks, and graph guards block unsafe publication', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 6_000_000 })
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  for (let id = 1; id <= 3; id += 1) await insertSite(db, id)
  for (let id = 1; id <= 4; id += 1) await insertTag(db, id)
  const repository = service.repository
  for (const [id, siteId] of [
    ['evidence-1', 1],
    ['evidence-duplicate-site', 1],
  ] as const) {
    await repository.recordEvidence({
      id,
      concept: 'new concept',
      siteId,
      inputHash: hash,
      sourceKey: id,
      source: 'submitted_hint',
      evidenceHash: hash,
      evidenceSnippet: id,
      confidenceMicros: 1_000_000,
      accepted: true,
      now: 6_000,
    })
  }
  await assert.rejects(
    service.publishOntology({
      kind: 'canonical',
      proposedName: 'New Concept',
      proposedSlug: 'new-concept',
      normalizedConcept: 'new concept',
      expectedVersion: 1,
    }),
    /distinct-site evidence/i,
  )
  for (const siteId of [2, 3]) {
    await repository.recordEvidence({
      id: `evidence-${siteId}`,
      concept: 'new concept',
      siteId,
      inputHash: hash,
      sourceKey: `site-${siteId}`,
      source: 'submitted_hint',
      evidenceHash: hash,
      evidenceSnippet: `site ${siteId}`,
      confidenceMicros: 1_000_000,
      accepted: true,
      now: 6_000,
    })
  }
  const published = await service.publishOntology({
    kind: 'canonical',
    proposedName: 'New Concept',
    proposedSlug: 'new-concept',
    normalizedConcept: 'new concept',
    expectedVersion: 1,
  })
  assert.equal(published.version, 2)

  const lockId = await service.createLock({
    scope: 'alias',
    tagId: 1,
    alias: 'listening',
    reason: 'reserved',
    actorId: 'admin',
  })
  await assert.rejects(
    service.publishOntology({
      kind: 'alias',
      alias: 'listening',
      targetTagId: 1,
      expectedVersion: 2,
      expectedTagRevision: 1,
    }),
  )
  assert.equal(await service.releaseLock(lockId, 'admin', 'approved'), true)
  assert.equal(await service.releaseLock(lockId, 'admin', 'again'), false)
  await service.publishOntology({
    kind: 'alias',
    alias: 'listening',
    targetTagId: 1,
    expectedVersion: 2,
    expectedTagRevision: 1,
  })
  await db
    .prepare(
      'INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (1, 2), (2, 3)',
    )
    .run()
  await assert.rejects(
    service.publishOntology({
      kind: 'parent',
      parentTagId: 3,
      childTagId: 1,
      expectedVersion: 3,
      expectedTagRevision: 2,
    }),
    /cycle, depth, or fanout/i,
  )
})

test('event, site, and batch rollback helpers compensate only their selected audit scope', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 7_000_000 })
  for (let id = 1; id <= 4; id += 1) await insertSite(db, id)
  await insertTag(db, 1)
  await insertTag(db, 2)
  for (let siteId = 1; siteId <= 4; siteId += 1) {
    await db
      .prepare(
        `INSERT INTO site_tags
         (site_id, tag_id, raw_name, source, revision, created_at, updated_at)
         VALUES (?, 1, 'Tag 1', 'automation', 1, 6999, 6999)`,
      )
      .bind(siteId)
      .run()
  }
  await db
    .prepare(
      `INSERT INTO site_tags
       (site_id, tag_id, raw_name, source, revision, created_at, updated_at)
       VALUES (2, 2, 'Tag 2', 'automation', 1, 6999, 6999)`,
    )
    .run()
  for (const batchId of ['event-batch', 'site-batch', 'batch-scope']) {
    await db
      .prepare(
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at)
         VALUES (?, 'classification', 'applied', 'system', 1, 1, ?, 6999, 6999)`,
      )
      .bind(batchId, batchId)
      .run()
  }
  const events = [
    ['event-one', 'event-batch', 1],
    ['site-one', 'site-batch', 2],
    ['site-two', 'site-batch', 2],
    ['batch-one', 'batch-scope', 3],
    ['batch-two', 'batch-scope', 4],
  ] as const
  for (const [id, batchId, siteId] of events) {
    const tagId = id === 'site-two' ? 2 : 1
    await db
      .prepare(
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         VALUES (?, ?, 'assignment_add', 'site_assignment', ?, 'system',
                 1, 1, '{}', 'test', ?, ?, 'test', 6999)`,
      )
      .bind(
        id,
        batchId,
        `${siteId}:${tagId}`,
        JSON.stringify({
          assigned: false,
          tagId,
          tag: { id: tagId, status: 'active', revision: 1 },
        }),
        JSON.stringify({
          assigned: true,
          tagId,
          tag: { id: tagId, status: 'active', revision: 1 },
          assignment: {
            tagId,
            rawName: `Tag ${tagId}`,
            source: 'automation',
            decisionId: null,
            revision: 1,
            createdAt: 6999,
            updatedAt: 6999,
          },
        }),
      )
      .run()
  }

  assert.equal(
    (await service.rollbackEvent('event-one', 'admin')).compensatedEvents,
    1,
  )
  assert.equal((await service.rollbackSite(2, 'admin')).compensatedEvents, 2)
  assert.equal(
    (await service.rollbackBatch('batch-scope', 'admin')).compensatedEvents,
    2,
  )
  assert.deepEqual(
    (
      await db
        .prepare('SELECT site_id AS siteId FROM site_tags ORDER BY site_id')
        .all<{ siteId: number }>()
    ).results,
    [],
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) AS count FROM taxonomy_audit_events
         WHERE event_type = 'compensating_rollback' AND compensates_event_id IS NOT NULL`,
      )
      .first('count'),
    5,
  )
})

test('mixed rollback preparation checks later events after an earlier failure', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await insertTag(db, 2)
  await db
    .prepare(
      `INSERT INTO tag_aliases (alias, tag_id)
       VALUES ('older alias', 1), ('newer alias', 2)`,
    )
    .run()
  await db.batch([
    db
      .prepare(
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at,
          created_at)
         VALUES (?, 'ontology', 'applied', 'system', 1, 1, ?, 7000, 7000,
                 7000)`,
      )
      .bind('mixed-rollback', 'mixed rollback'),
    db
      .prepare(
        `INSERT INTO taxonomy_change_batches
         (id, kind, status, actor_type, expected_taxonomy_version,
          resulting_taxonomy_version, summary, applied_at, completed_at,
          created_at)
         VALUES (?, 'ontology', 'applied', 'system', 1, 1, ?, 7000, 7000,
                 7000)`,
      )
      .bind('mixed-rollback-blocker', 'mixed rollback blocker'),
    db
      .prepare(
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         VALUES ('mixed-older', 'mixed-rollback', 'alias_created', 'alias',
                 'older alias', 'system', 1, 1, '{}', '', '{}', ?, 'test',
                 7001)`,
      )
      .bind(JSON.stringify({ targetTagId: 1, targetTagRevision: 1 })),
    db
      .prepare(
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         VALUES ('mixed-newer', 'mixed-rollback', 'alias_created', 'alias',
                 'newer alias', 'system', 1, 1, '{}', '', '{}', ?, 'test',
                 7002)`,
      )
      .bind(JSON.stringify({ targetTagId: 2, targetTagRevision: 1 })),
    db
      .prepare(
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         VALUES ('mixed-blocker', 'mixed-rollback-blocker', 'alias_created',
                 'alias', 'newer alias', 'system', 1, 1, '{}', '', '{}', ?,
                 'test', 7003)`,
      )
      .bind(JSON.stringify({ targetTagId: 2, targetTagRevision: 1 })),
  ])

  const checkedEntities: string[] = []
  const observedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (query: string) => {
          const prepared = target.prepare(query)
          if (!query.includes('SELECT id FROM taxonomy_audit_events')) {
            return prepared
          }
          return new Proxy(prepared, {
            get(statement, statementProperty, statementReceiver) {
              if (statementProperty === 'bind') {
                return (...values: unknown[]) => {
                  checkedEntities.push(String(values[1]))
                  return Reflect.apply(statement.bind, statement, values)
                }
              }
              const value = Reflect.get(
                statement,
                statementProperty,
                statementReceiver,
              ) as unknown
              return typeof value === 'function' ? value.bind(statement) : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as D1Database
  const service = new TaxonomyService(serviceEnv(observedDb), {
    now: () => 7_004_000,
  })

  await assert.rejects(
    service.rollbackBatch('mixed-rollback', 'admin'),
    /mixed-blocker/,
  )
  assert.deepEqual(checkedEntities, ['newer alias', 'older alias'])
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'compensating_rollback'",
      )
      .first('count(*)'),
    0,
  )
})

test('max-size classification batches and sites roll back atomically', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 7_500_000 })
  for (const siteId of [1, 2]) await insertSite(db, siteId)
  for (let index = 1; index <= 100; index += 1) {
    await insertTag(db, index)
  }
  const rows = Array.from({ length: 200 }, (_, offset) => {
    const siteId = offset < 100 ? 1 : 2
    const tagId = (offset % 100) + 1
    const assignment = {
      rawName: `Tag ${tagId}`,
      source: 'automation',
      decisionId: null,
      revision: 1,
      createdAt: 7_499,
      updatedAt: 7_499,
    }
    return {
      eventId: `max-event-${siteId}-${tagId}`,
      batchId: `max-batch-${siteId}`,
      entityId: `${siteId}:${tagId}`,
      siteId,
      tagId,
      before: JSON.stringify({
        assigned: false,
        tagId,
        tag: { id: tagId, status: 'active', revision: 1 },
      }),
      after: JSON.stringify({
        assigned: true,
        tagId,
        tag: { id: tagId, status: 'active', revision: 1 },
        assignment,
      }),
      assignment,
    }
  })
  await db.batch(
    [1, 2].map((siteId) =>
      db
        .prepare(
          `INSERT INTO taxonomy_change_batches
           (id, kind, status, actor_type, expected_taxonomy_version,
            resulting_taxonomy_version, summary, applied_at, completed_at)
           VALUES (?, 'classification', 'applied', 'system', 1, 1, ?, 7499, 7499)`,
        )
        .bind(`max-batch-${siteId}`, `max batch ${siteId}`),
    ),
  )
  await db.batch([
    db
      .prepare(
        `INSERT INTO site_tags
         (site_id, tag_id, raw_name, source, decision_id, revision, created_at, updated_at)
         SELECT json_extract(value, '$.siteId'), json_extract(value, '$.tagId'),
                json_extract(value, '$.assignment.rawName'), 'automation', NULL, 1, 7499, 7499
         FROM json_each(?)`,
      )
      .bind(JSON.stringify(rows)),
    db
      .prepare(
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         SELECT json_extract(value, '$.eventId'), json_extract(value, '$.batchId'),
                'assignment_add', 'site_assignment', json_extract(value, '$.entityId'),
                'system', 1, 1, '{}', '', json_extract(value, '$.before'),
                json_extract(value, '$.after'), 'test', 7499 FROM json_each(?)`,
      )
      .bind(JSON.stringify(rows)),
  ])
  assert.equal((await service.rollbackSite(1, 'admin')).compensatedEvents, 100)
  assert.equal(
    (await service.rollbackBatch('max-batch-2', 'admin')).compensatedEvents,
    100,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'compensating_rollback'",
      )
      .first('count(*)'),
    200,
  )
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
})

test('outbox dispatcher retries queue failures without losing or duplicating successful rows', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const repository = new TaxonomyRepository(db)
  await insertSite(db, 1)
  await repository.enqueueJob(
    {
      id: 'dispatch-job',
      jobKey: 'dispatch-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      policyConfigId: 1,
      maxAttempts: 1,
    },
    8_000,
  )
  let sends = 0
  const env = {
    ...serviceEnv(db),
    TAXONOMY_QUEUE: mockQueue(async () => {
      sends += 1
      if (sends === 1) throw new Error('queue unavailable')
    }),
  }
  assert.equal(await dispatchTaxonomyOutbox(env, { now: () => 8_000_000 }), 0)
  assert.equal(await dispatchTaxonomyOutbox(env, { now: () => 8_059_000 }), 0)
  assert.equal(await dispatchTaxonomyOutbox(env, { now: () => 8_060_000 }), 1)
  assert.equal(await dispatchTaxonomyOutbox(env, { now: () => 9_000_000 }), 0)
  assert.equal(sends, 2)
})

test('maintenance does not redispatch a freshly delivered runnable job', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const repository = new TaxonomyRepository(db)
  await repository.enqueueJob(
    {
      id: 'fresh-delivery-job',
      jobKey: 'fresh-delivery-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      policyConfigId: 1,
      maxAttempts: 1,
    },
    10_500,
  )
  let sends = 0
  const env = {
    ...serviceEnv(db),
    TAXONOMY_QUEUE: mockQueue(async () => {
      sends += 1
    }),
  }
  assert.equal(await dispatchTaxonomyOutbox(env, { now: () => 10_500_000 }), 1)
  const maintained = await runTaxonomyMaintenance(env, {
    now: () => 10_500_000,
  })
  assert.equal(maintained.outboxDispatched, 0)
  assert.equal(sends, 1)
})

test('configured consensus fails closed when a required voter fails', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 9_000_000 })
  const primaryId = await addProvider(service, {
    name: 'required-primary',
    credential: 'primary-secret',
    role: 'primary',
    priority: 0,
  })
  await addProvider(service, {
    name: 'required-consensus',
    credential: 'consensus-secret',
    role: 'consensus',
    priority: 1,
  })
  await service.activateProvider(primaryId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 9_001_000,
      fetch: async (_input, init) => {
        const authorization = String(
          (init?.headers as Record<string, string>).authorization,
        )
        return authorization.includes('consensus-secret')
          ? Response.json({}, { status: 503 })
          : Response.json({ output_text: JSON.stringify(providerDecision(1)) })
      },
    },
  )
  assert.equal(result.status, 'retry_wait')
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM tag_assignment_decisions')
      .first('count(*)'),
    0,
  )
})

test('budget reservations are atomic and missing usage remains conservatively charged', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const repository = new TaxonomyRepository(db)
  await insertSite(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 10_000_000 })
  const providerId = await addProvider(service, {
    name: 'budget-primary',
    credential: 'secret',
    role: 'primary',
    priority: 0,
  })
  await repository.enqueueJob(
    {
      id: 'budget-job',
      jobKey: 'budget-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      providerConfigId: providerId,
      policyConfigId: 1,
      maxAttempts: 2,
    },
    10_000,
  )
  const provider = (await repository.loadProvider(providerId))!
  const reservations = await Promise.all([
    repository.reserveAttempt({
      id: 'budget-a',
      jobId: 'budget-job',
      number: 1,
      provider,
      requestHash: hash,
      now: 10_000,
      estimatedInputTokens: 60,
      estimatedOutputTokens: 40,
      requestBudget: 1,
      tokenBudget: 100,
    }),
    repository.reserveAttempt({
      id: 'budget-b',
      jobId: 'budget-job',
      number: 2,
      provider,
      requestHash: hash,
      now: 10_000,
      estimatedInputTokens: 60,
      estimatedOutputTokens: 40,
      requestBudget: 1,
      tokenBudget: 100,
    }),
  ])
  assert.equal(reservations.filter(Boolean).length, 1)
  assert.deepEqual(await repository.budgetUsage(10_000), {
    requests: 1,
    tokens: 100,
  })
})

test('maintenance recreates queue delivery for every bounded runnable job', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const repository = new TaxonomyRepository(db)
  await insertSite(db, 1)
  await repository.enqueueJob(
    {
      id: 'lost-job',
      jobKey: 'lost-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      policyConfigId: 1,
      maxAttempts: 2,
    },
    11_000,
  )
  await db
    .prepare('DELETE FROM taxonomy_outbox WHERE job_id = ?')
    .bind('lost-job')
    .run()
  const result = await repository.maintenance(11_001)
  assert.equal(result.reconciledOutbox, 1)
  assert.deepEqual(
    await db
      .prepare('SELECT payload FROM taxonomy_outbox WHERE job_id = ?')
      .bind('lost-job')
      .first('payload'),
    JSON.stringify({ jobId: 'lost-job' }),
  )
  await db
    .prepare(
      `UPDATE taxonomy_outbox SET dispatched_at = 11000 WHERE job_id = 'lost-job'`,
    )
    .run()
  await repository.maintenance(11_100)
  assert.equal(
    await db
      .prepare(
        "SELECT dispatched_at FROM taxonomy_outbox WHERE job_id = 'lost-job'",
      )
      .first('dispatched_at'),
    11_000,
  )
  await repository.maintenance(11_301)
  assert.equal(
    await db
      .prepare(
        "SELECT dispatched_at FROM taxonomy_outbox WHERE job_id = 'lost-job'",
      )
      .first('dispatched_at'),
    null,
  )
})

test('policy revisions can supersede an edited non-active revision', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 11_500_000 })
  const first = await service.enqueueSite(1)
  assert.ok(first)
  const policy = await service.repository.loadPolicy(1)
  const { id: _id, revision: _revision, ...policyInput } = policy
  const policyId = await service.createPolicyRevision(policyInput, 'admin')
  const editedPolicyId = await service.createPolicyRevision(
    { ...policyInput, assignmentLimit: policyInput.assignmentLimit + 1 },
    'admin',
    policyId,
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT supersedes_id AS supersedesId, assignment_limit AS assignmentLimit
         FROM taxonomy_policy_configs WHERE id = ?`,
      )
      .bind(editedPolicyId)
      .first(),
    {
      supersedesId: policyId,
      assignmentLimit: policyInput.assignmentLimit + 1,
    },
  )
  await service.activatePolicy(editedPolicyId)
  const second = await service.enqueueSite(1)
  assert.ok(second)
  assert.notEqual(second, first)
  assert.equal(
    await db.prepare('SELECT count(*) FROM taxonomy_jobs').first('count(*)'),
    2,
  )
})

test('concurrent site edits use content and hash CAS with atomic rollback', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const existing = await db
    .prepare(
      `SELECT name, url, description, summary, categories, poster, notes, facts,
              accent, status, thumbnail_alt AS thumbnailAlt,
              content_version AS contentVersion,
              classification_input_hash AS classificationInputHash,
              thumbnail_key AS thumbnailKey
       FROM sites WHERE id = 1`,
    )
    .first<{
      contentVersion: number
      classificationInputHash: string | null
      thumbnailKey: string | null
    }>()
  assert.ok(existing)
  existing.categories = JSON.parse(String(existing.categories)) as string[]
  existing.notes = JSON.parse(String(existing.notes)) as string[]
  existing.facts = JSON.parse(String(existing.facts)) as Array<{
    label: string
    value: string
  }>
  const common = {
    id: 1,
    url: 'https://site-1.example/',
    summary: '',
    categories: [],
    poster: '',
    notes: [],
    facts: [],
    accent: '',
    tags: [] as string[],
    status: 'active' as const,
    thumbnailAlt: 'Site 1',
  }
  const first = await updateSiteFromSnapshot(
    db,
    {
      ...common,
      name: 'First Edit',
      description: 'First edit description',
    },
    existing,
  )
  assert.equal(first.thumbnailKey, null)
  await assert.rejects(
    updateSiteFromSnapshot(
      db,
      {
        ...common,
        name: 'Stale Edit',
        description: 'Stale edit description',
      },
      existing,
    ),
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT name, description, content_version AS contentVersion
         FROM sites WHERE id = 1`,
      )
      .first(),
    {
      name: 'First Edit',
      description: 'First edit description',
      contentVersion: 2,
    },
  )
})

test('site update CAS rejects concurrent non-taxonomy field edits', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const existing = await db
    .prepare(
      `SELECT name, url, description, summary, categories, poster, notes, facts,
              accent, status, thumbnail_key AS thumbnailKey,
              thumbnail_alt AS thumbnailAlt, content_version AS contentVersion,
              classification_input_hash AS classificationInputHash
       FROM sites WHERE id = 1`,
    )
    .first<SiteUpdateSnapshot>()
  assert.ok(existing)
  await db.prepare("UPDATE sites SET poster = 'CONCURRENT' WHERE id = 1").run()
  await assert.rejects(
    updateSiteFromSnapshot(
      db,
      {
        id: 1,
        name: existing.name,
        url: existing.url,
        description: existing.description,
        summary: existing.summary,
        categories: existing.categories,
        poster: 'STALE',
        notes: existing.notes,
        facts: existing.facts,
        accent: existing.accent,
        tags: [],
        status: existing.status,
        thumbnailAlt: existing.thumbnailAlt ?? '',
      },
      existing,
    ),
  )
  assert.equal(
    await db.prepare('SELECT poster FROM sites WHERE id = 1').first('poster'),
    'CONCURRENT',
  )
})

test('submission reapproval CAS rejects a concurrent taxonomy input edit', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await db
    .prepare(
      `INSERT INTO submissions
       (id, name, url, url_key, description, tags, status)
       VALUES (1, 'Submitted Site', 'https://submitted.example/', 'submitted.example',
               'Submitted description', '["Tag 1"]', 'pending')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO sites
       (id, slug, name, url, url_key, description, summary, categories, poster,
        notes, facts, status, source, submission_id, content_version,
        classification_input_hash)
       VALUES (1, 'submitted-site', 'Submitted Site', 'https://submitted.example/',
               'submitted.example', 'Submitted description', 'Summary', '[]', 'NEW',
               '[]', '[]', 'archived', 'Submission', 1, 1, ?)`,
    )
    .bind(hash)
    .run()
  let raced = false
  const concurrentHash = 'b'.repeat(64)
  const raceDb = new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true
            await target
              .prepare(
                `UPDATE sites SET content_version = 2,
                 classification_input_hash = ? WHERE id = 1`,
              )
              .bind(concurrentHash)
              .run()
          }
          return target.batch(statements)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  await assert.rejects(
    commitSubmissionReapproval(raceDb, {
      submissionId: 1,
      siteId: 1,
      expectedContentVersion: 1,
      expectedInputHash: hash,
      expectedSubmission: {
        name: 'Submitted Site',
        url: 'https://submitted.example/',
        urlKey: 'submitted.example',
        description: 'Submitted description',
        tags: ['Tag 1'],
        thumbnailKey: null,
        thumbnailAlt: null,
        submittedAt: new Date(
          Number(
            await db
              .prepare('SELECT submitted_at FROM submissions WHERE id = 1')
              .first('submitted_at'),
          ) * 1000,
        ),
      },
      contentVersion: 2,
      metadataHash: 'e'.repeat(64),
      changed: true,
      lifecycle: [],
    }),
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT status, content_version AS contentVersion,
                classification_input_hash AS inputHash FROM sites WHERE id = 1`,
      )
      .first(),
    { status: 'archived', contentVersion: 2, inputHash: concurrentHash },
  )
  assert.equal(
    await db
      .prepare('SELECT status FROM submissions WHERE id = 1')
      .first('status'),
    'pending',
  )
  assert.equal(
    await db.prepare('SELECT count(*) FROM taxonomy_jobs').first('count(*)'),
    0,
  )
})

test('submission reapproval CAS rejects concurrent resubmission', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await db
    .prepare(
      `INSERT INTO submissions (id, name, url, url_key, description, tags, status)
     VALUES (1, 'Old', 'https://old.example/', 'old.example', 'Old', '[]', 'pending')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO sites (id, slug, name, url, url_key, description, status, source,
                        submission_id, classification_input_hash)
     VALUES (1, 'old', 'Old', 'https://old.example/', 'old.example', 'Old',
             'archived', 'Submission', 1, ?)`,
    )
    .bind(hash)
    .run()
  const submittedAt = Number(
    await db
      .prepare('SELECT submitted_at FROM submissions')
      .first('submitted_at'),
  )
  await db
    .prepare(
      `UPDATE submissions SET name = 'New', description = 'New', submitted_at = submitted_at + 1
     WHERE id = 1`,
    )
    .run()
  await assert.rejects(
    commitSubmissionReapproval(db, {
      submissionId: 1,
      siteId: 1,
      expectedContentVersion: 1,
      expectedInputHash: hash,
      expectedSubmission: {
        name: 'Old',
        url: 'https://old.example/',
        urlKey: 'old.example',
        description: 'Old',
        tags: [],
        thumbnailKey: null,
        thumbnailAlt: null,
        submittedAt: new Date(submittedAt * 1000),
      },
      contentVersion: 1,
      metadataHash: hash,
      changed: false,
      lifecycle: [],
    }),
  )
  assert.deepEqual(
    await db
      .prepare('SELECT name, status FROM submissions WHERE id = 1')
      .first(),
    { name: 'New', status: 'pending' },
  )
})

test('same-second distinct evidence advances the strict reassessment frontier', async (context) => {
  const db = await migratedTaxonomyDb(context)
  for (const siteId of [1, 2, 3, 4]) await insertSite(db, siteId)
  const repository = new TaxonomyRepository(db)
  for (const siteId of [1, 2, 3]) {
    await repository.recordEvidence({
      id: `evidence-${siteId}`,
      concept: 'frontier',
      siteId,
      inputHash: hash,
      sourceKey: `site-${siteId}`,
      source: 'submitted_hint',
      evidenceHash: hash,
      evidenceSnippet: String(siteId),
      confidenceMicros: 1_000_000,
      accepted: true,
      now: 30_000,
    })
  }
  await db
    .prepare(
      `UPDATE taxonomy_jobs SET status = 'settled', completed_at = 30000, updated_at = 30000
     WHERE concept_key = 'frontier'`,
    )
    .run()
  await repository.recordEvidence({
    id: 'evidence-4',
    concept: 'frontier',
    siteId: 4,
    inputHash: hash,
    sourceKey: 'site-4',
    source: 'submitted_hint',
    evidenceHash: hash,
    evidenceSnippet: '4',
    confidenceMicros: 1_000_000,
    accepted: true,
    now: 30_000,
  })
  assert.equal(
    await db
      .prepare(
        "SELECT status FROM taxonomy_jobs WHERE concept_key = 'frontier'",
      )
      .first('status'),
    'pending',
  )
})

test('lowered evidence threshold lets backfill enqueue existing concepts', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const repository = new TaxonomyRepository(db)
  const evidence = {
    id: 'existing-threshold-evidence',
    concept: 'existing concept',
    siteId: 1,
    inputHash: hash,
    sourceKey: 'submitted-hint',
    source: 'submitted_hint' as const,
    evidenceHash: hash,
    evidenceSnippet: 'existing concept',
    confidenceMicros: 1_000_000,
    accepted: true,
    now: 9_000,
  }

  await repository.recordEvidence(evidence)
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'reassess_concept'",
      )
      .first('count(*)'),
    0,
  )

  await db
    .prepare(
      'UPDATE taxonomy_policy_configs SET novel_evidence_site_threshold = 1 WHERE id = 1',
    )
    .run()
  await repository.recordEvidence({ ...evidence, now: 9_001 })

  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'reassess_concept' AND status = 'pending'",
      )
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_outbox outbox
         JOIN taxonomy_jobs job ON job.id = outbox.job_id
         WHERE job.kind = 'reassess_concept' AND outbox.dispatched_at IS NULL`,
      )
      .first('count(*)'),
    1,
  )
})

test('maintenance self-heals eligible existing concepts without duplicate jobs', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const repository = new TaxonomyRepository(db)
  await repository.recordEvidence({
    id: 'maintenance-existing-evidence',
    concept: 'maintenance concept',
    siteId: 1,
    inputHash: hash,
    sourceKey: 'submitted-hint',
    source: 'submitted_hint',
    evidenceHash: hash,
    evidenceSnippet: 'maintenance concept',
    confidenceMicros: 1_000_000,
    accepted: true,
    now: 9_100,
  })
  await db
    .prepare(
      'UPDATE taxonomy_policy_configs SET novel_evidence_site_threshold = 1 WHERE id = 1',
    )
    .run()

  const first = await repository.maintenance(9_101)
  const second = await repository.maintenance(9_102)
  assert.equal(first.eligibleConceptsEnqueued, 1)
  assert.equal(second.eligibleConceptsEnqueued, 0)
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'reassess_concept' AND concept_key = 'maintenance concept'",
      )
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_outbox outbox
         JOIN taxonomy_jobs job ON job.id = outbox.job_id
         WHERE job.kind = 'reassess_concept'
           AND job.concept_key = 'maintenance concept'`,
      )
      .first('count(*)'),
    1,
  )
})

test('candidate snapshots include only relevant locks despite global lock saturation', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  for (let tagId = 1; tagId <= 12; tagId += 1) await insertTag(db, tagId)
  await db
    .prepare(
      `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
       VALUES (1, 12, 'Assigned tag', 'automation')`,
    )
    .run()
  await db.batch(
    Array.from({ length: 12 }, (_, offset) => {
      const tagId = offset + 1
      const siteScoped = tagId === 12
      return db
        .prepare(
          `INSERT INTO taxonomy_locks
           (id, scope, resource_key, site_id, tag_id, reason, created_by)
           VALUES (?, ?, ?, ?, ?, 'test', 'test')`,
        )
        .bind(
          `lock-${tagId}`,
          siteScoped ? 'site_assignment' : 'tag',
          siteScoped ? `site:1:tag:${tagId}` : `tag:${tagId}`,
          siteScoped ? 1 : null,
          tagId,
        )
    }),
  )
  const repository = new TaxonomyRepository(db)
  await repository.enqueueJob(
    {
      id: 'lock-snapshot-job',
      jobKey: 'lock-snapshot-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      policyConfigId: 1,
      maxAttempts: 1,
    },
    13_500,
  )
  const job = await repository.leaseJob(
    'lock-snapshot-job',
    'worker',
    'lock-snapshot-token',
    13_500,
    900,
  )
  assert.ok(job)
  const snapshot = await repository.candidateSnapshot(job, 1)
  assert.ok(snapshot)
  assert.deepEqual(
    snapshot.tags.map(({ id }) => id),
    [1, 12],
  )
  assert.deepEqual(snapshot.activeLockKeys, ['site:1:tag:12', 'tag:1'])
})

test('two applicable ontology queue jobs from one batch settle without permanent degradation', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 11_900_000 })
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, concept_key, input_hash, taxonomy_version,
        policy_config_id, status, max_attempts, available_at, created_at,
        updated_at, completed_at)
       VALUES ('batch-source-job', 'batch-source-key', 'reassess_concept',
               'batch aliases', ?, 1, 1, 'settled', 1, 11900, 11900, 11900,
               11900)`,
    )
    .bind(hash)
    .run()
  const proposals = [
    {
      id: 'batch-candidate-one',
      alias: 'batch alias one',
      rank: 0,
    },
    {
      id: 'batch-candidate-two',
      alias: 'batch alias two',
      rank: 1,
    },
  ]
  await db.batch(
    proposals.map(({ id, alias, rank }) =>
      db
        .prepare(
          `INSERT INTO taxonomy_candidates
           (id, job_id, candidate_key, kind, tag_id, normalized_concept,
            payload, confidence_micros, rank)
           VALUES (?, 'batch-source-job', ?, 'alias', 1, ?, ?, 990000, ?)`,
        )
        .bind(
          id,
          `alias:${alias}:1`,
          alias,
          JSON.stringify({
            kind: 'alias',
            alias,
            targetTagId: '1',
            confidence: 0.99,
            evidence: 'The terms are equivalent.',
          }),
          rank,
        ),
    ),
  )
  const jobIds = await Promise.all(
    proposals.map(({ id }) => service.enqueueOntologyCandidate(id)),
  )
  assert.ok(jobIds[0])
  assert.ok(jobIds[1])

  let releasePublications: () => void = () => undefined
  const bothPublicationsReady = new Promise<void>((resolve) => {
    releasePublications = resolve
  })
  let publicationBatchCount = 0
  const racingDb = new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          publicationBatchCount += 1
          if (publicationBatchCount <= 2) {
            if (publicationBatchCount === 2) releasePublications()
            await Promise.race([
              bothPublicationsReady,
              new Promise<void>((resolve) => setTimeout(resolve, 500)),
            ])
          }
          return target.batch(statements)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as D1Database

  await processTaxonomyQueueBatch(jobIds as string[], async (jobId) => {
    await processTaxonomyMessage(
      { jobId },
      { ...env, DB: racingDb, TAXONOMY_QUEUE: mockQueue() },
      { now: () => 11_901_000 },
    )
  })

  const statuses = await Promise.all(
    (jobIds as string[]).map((jobId) =>
      db
        .prepare('SELECT status FROM taxonomy_jobs WHERE id = ?')
        .bind(jobId)
        .first<string>('status'),
    ),
  )
  assert.deepEqual(statuses.sort(), ['settled', 'settled'])
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    2,
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    3,
  )
})

test('ontology candidate redelivery is idempotent and control changes are audited', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 12_000_000 })
  await insertSite(db, 1)
  await insertSite(db, 2)
  await insertSite(db, 3)
  await insertTag(db, 1)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  for (const siteId of [1, 2, 3]) {
    await service.repository.recordEvidence({
      id: `candidate-evidence-${siteId}`,
      concept: 'new signal',
      siteId,
      inputHash: hash,
      sourceKey: String(siteId),
      source: 'submitted_hint',
      evidenceHash: hash,
      evidenceSnippet: 'new signal',
      confidenceMicros: 1_000_000,
      accepted: true,
      now: 12_000,
    })
  }
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, concept_key, input_hash, taxonomy_version, policy_config_id,
        status, max_attempts, available_at, created_at, updated_at, completed_at)
       VALUES ('source-job', 'source-key', 'reassess_concept', 'new signal', ?, 1, 1,
               'settled', 1, 12000, 12000, 12000, 12000)`,
    )
    .bind(hash)
    .run()
  const proposal = {
    kind: 'concept',
    proposedName: 'New Signal',
    proposedSlug: 'new-signal',
    confidence: 0.99,
    evidence: 'three sites',
  }
  await db
    .prepare(
      `INSERT INTO taxonomy_candidates
       (id, job_id, candidate_key, kind, normalized_concept, proposed_name,
        proposed_slug, payload, confidence_micros, rank)
       VALUES ('candidate-apply', 'source-job', 'concept:new-signal', 'novel_concept',
               'new signal', 'New Signal', 'new-signal', ?, 990000, 0)`,
    )
    .bind(JSON.stringify(proposal))
    .run()
  const applyJobId = await service.enqueueOntologyCandidate('candidate-apply')
  assert.ok(applyJobId)
  const runtimeEnv = { ...env, TAXONOMY_QUEUE: mockQueue() }
  const first = await processTaxonomyMessage(
    { jobId: applyJobId },
    runtimeEnv,
    { now: () => 12_001_000 },
  )
  const second = await processTaxonomyMessage(
    { jobId: applyJobId },
    runtimeEnv,
    { now: () => 12_002_000 },
  )
  assert.equal(first.status, 'settled')
  assert.equal(second.status, 'ignored')
  assert.equal(
    await db
      .prepare("SELECT count(*) FROM tags WHERE slug = 'new-signal'")
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'canonical_created'",
      )
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state WHERE id = 1')
      .first('published_version'),
    2,
  )

  await service.createLock({
    scope: 'tag',
    tagId: 1,
    reason: 'freeze',
    actorId: 'admin',
  })
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'lock_created'",
      )
      .first('count(*)'),
    1,
  )
})

test('ontology retries update one stable persisted candidate identity', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 12_500_000 })
  const providerConfigId = await addProvider(service, {
    name: 'candidate-attempt-provider',
    credential: 'candidate-attempt-secret',
    role: 'primary',
    priority: 0,
  })
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, concept_key, input_hash, taxonomy_version,
        policy_config_id, status, max_attempts, available_at, created_at, updated_at)
       VALUES ('candidate-attempt-job', 'candidate-attempt-key', 'reassess_concept',
               'retry alias', ?, 1, 1, 'pending', 2, 12500, 12500, 12500)`,
    )
    .bind(hash)
    .run()
  for (const attemptNumber of [1, 2]) {
    await db
      .prepare(
        `INSERT INTO taxonomy_job_attempts
         (id, job_id, attempt_number, provider_config_id, status, provider_model,
          request_hash, started_at, completed_at)
         VALUES (?, 'candidate-attempt-job', ?, ?, 'succeeded',
                 'candidate-attempt-provider', ?, 12500, 12500)`,
      )
      .bind(
        `attempt:candidate-attempt-job:${attemptNumber}`,
        attemptNumber,
        providerConfigId,
        hash,
      )
      .run()
    const semanticKey = 'alias:retry alias:1'
    const attemptId = `attempt:candidate-attempt-job:${attemptNumber}`
    await service.repository.saveCandidate({
      id: 'candidate-stable-retry',
      jobId: 'candidate-attempt-job',
      attemptId,
      candidateKey: semanticKey,
      kind: 'alias',
      tagId: 1,
      normalizedConcept: 'retry alias',
      payload: {
        kind: 'alias',
        alias: 'retry alias',
        targetTagId: '1',
        confidence: attemptNumber === 1 ? 0.91 : 0.99,
        evidence: `attempt ${attemptNumber}`,
      },
      confidenceMicros: attemptNumber === 1 ? 910_000 : 990_000,
      rank: 0,
      now: 12_500 + attemptNumber,
    })
  }
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT attempt_id AS attemptId, status, confidence_micros AS confidence
           FROM taxonomy_candidates ORDER BY created_at`,
        )
        .all()
    ).results,
    [
      {
        attemptId: 'attempt:candidate-attempt-job:2',
        status: 'proposed',
        confidence: 990_000,
      },
    ],
  )
})

test('rollback refuses locked or later-dependent state without partial writes', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 13_000_000 })
  await insertSite(db, 1)
  await insertTag(db, 1)
  await db
    .prepare(
      "INSERT INTO site_tags (site_id, tag_id, raw_name, source) VALUES (1, 1, 'Tag 1', 'automation')",
    )
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_change_batches
    (id, kind, status, actor_type, expected_taxonomy_version, resulting_taxonomy_version, summary)
    VALUES ('unsafe-batch', 'classification', 'applied', 'system', 1, 1, 'unsafe')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_audit_events
    (id, batch_id, event_type, entity_type, entity_id, actor_type,
     taxonomy_version_before, taxonomy_version_after, scores, evidence, before, after, release_sha, created_at)
    VALUES ('unsafe-event', 'unsafe-batch', 'assignment_add', 'site_assignment', '1:1', 'system',
            1, 1, '{}', '', '{"assigned":false}', '{"assigned":true}', 'test', 12999)`,
    )
    .run()
  const lockId = await service.createLock({
    scope: 'tag',
    tagId: 1,
    reason: 'owned',
    actorId: 'admin',
  })
  await assert.rejects(
    service.rollbackEvent('unsafe-event', 'admin'),
    /locked/i,
  )
  assert.equal(
    await service.releaseLock(lockId, 'admin', 'test old audit'),
    true,
  )
  await assert.rejects(
    service.rollbackEvent('unsafe-event', 'admin'),
    /tag provenance metadata/i,
  )
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE event_type = 'compensating_rollback'",
      )
      .first('count(*)'),
    0,
  )
})

test('bounded merge preserves stronger provenance and remaps hierarchy edges', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 14_000_000 })
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  await insertSite(db, 1)
  for (let id = 1; id <= 4; id += 1) await insertTag(db, id)
  await db
    .prepare(
      `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
       VALUES (1, 1, 'Admin source', 'admin'),
              (1, 2, 'Automation target', 'automation')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO tag_parents (parent_tag_id, child_tag_id)
       VALUES (3, 1), (1, 4)`,
    )
    .run()
  await service.publishOntology({
    kind: 'merge',
    sourceTagId: 1,
    targetTagId: 2,
    expectedVersion: 1,
    expectedTagRevision: 1,
  })
  assert.deepEqual(
    await db
      .prepare(
        `SELECT raw_name AS rawName, source FROM site_tags
         WHERE site_id = 1 AND tag_id = 2`,
      )
      .first(),
    { rawName: 'Admin source', source: 'admin' },
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT parent_tag_id AS parentId, child_tag_id AS childId
           FROM tag_parents ORDER BY parent_tag_id, child_tag_id`,
        )
        .all()
    ).results,
    [
      { parentId: 2, childId: 4 },
      { parentId: 3, childId: 2 },
    ],
  )
})

test('gradual rollout exclusions stay review-only while admin acceptance still applies', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_000_000 })
  const providerId = await addProvider(service, {
    name: 'rollout-primary',
    credential: 'rollout-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs
       SET ontology_provider_agreement = 1, rollout_basis_points = 0 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'gradual'").run()
  const reassessJobId = await service.enqueueConcept('rollout concept')
  assert.ok(reassessJobId)
  const runtimeEnv = { ...env, TAXONOMY_QUEUE: mockQueue() }
  const providerResponse = {
    schemaVersion: 1,
    proposals: [
      {
        kind: 'alias',
        alias: 'rollout alias',
        targetTagId: '1',
        confidence: 0.99,
        evidence: 'The terms are equivalent.',
      },
    ],
  }
  const reassessed = await processTaxonomyMessage(
    { jobId: reassessJobId },
    runtimeEnv,
    {
      now: () => 15_001_000,
      fetch: async () =>
        Response.json({ output_text: JSON.stringify(providerResponse) }),
    },
  )
  assert.equal(reassessed.status, 'settled')
  assert.equal(reassessed.mutations, 0)
  const candidate = await db
    .prepare(`SELECT id, status FROM taxonomy_candidates WHERE kind = 'alias'`)
    .first<{ id: string; status: string }>()
  assert.deepEqual(candidate && { status: candidate.status }, {
    status: 'proposed',
  })
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'apply_ontology'",
      )
      .first('count(*)'),
    0,
  )

  const excludedJobId = await service.enqueueOntologyCandidate(candidate!.id)
  assert.ok(excludedJobId)
  const excluded = await processTaxonomyMessage(
    { jobId: excludedJobId },
    runtimeEnv,
    { now: () => 15_002_000 },
  )
  assert.equal(excluded.status, 'settled')
  assert.equal(excluded.mutations, 0)
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT last_error_code FROM taxonomy_jobs WHERE id = ?')
      .bind(excludedJobId)
      .first('last_error_code'),
    'rollout_excluded',
  )

  const accepted = await service.decideCandidate({
    candidateId: candidate!.id,
    decision: 'accepted',
    reason: 'Deliberately approved',
    actorId: 'admin',
  })
  assert.equal(accepted.decided, true)
  assert.equal(accepted.jobId, excludedJobId)
  const applied = await processTaxonomyMessage(
    { jobId: accepted.jobId },
    runtimeEnv,
    { now: () => 15_003_000 },
  )
  assert.equal(applied.mutations, 1)
  assert.equal(
    await db
      .prepare("SELECT tag_id FROM tag_aliases WHERE alias = 'rollout alias'")
      .first('tag_id'),
    1,
  )
})

test('partial ontology rollout reuses the persisted candidate decision', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_050_000 })
  const providerId = await addProvider(service, {
    name: 'partial-rollout-primary',
    credential: 'partial-rollout-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs
       SET ontology_provider_agreement = 1 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'gradual'").run()
  const jobId = await service.enqueueConcept('partial rollout')
  assert.ok(jobId)
  const selectedAliases: Array<{ alias: string; candidateId: string }> = []
  for (let index = 1; selectedAliases.length < 2; index += 1) {
    const alias = `partial rollout alias ${index}`
    const candidateId = `candidate:${(
      await sha256Hex(`${jobId}:alias:${alias}:1`)
    ).slice(0, 40)}`
    if (await rolloutSelected(candidateId, 5_000)) {
      selectedAliases.push({ alias, candidateId })
    }
  }
  await db
    .prepare(
      'UPDATE taxonomy_policy_configs SET rollout_basis_points = ? WHERE id = 1',
    )
    .bind(5_000)
    .run()
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 15_051_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            proposals: selectedAliases.map(({ alias }) => ({
              kind: 'alias',
              alias,
              targetTagId: '1',
              confidence: 0.99,
              evidence: 'Stable partial rollout evidence.',
            })),
          }),
        }),
    },
  )
  const candidates = await db
    .prepare(
      'SELECT id FROM taxonomy_candidates WHERE job_id = ? ORDER BY rank',
    )
    .bind(jobId)
    .all<{ id: string }>()
  assert.deepEqual(
    candidates.results.map((candidate: { id: string }) => candidate.id),
    selectedAliases.map(({ candidateId }) => candidateId),
  )
  const applicationJob = await db
    .prepare("SELECT id FROM taxonomy_jobs WHERE kind = 'apply_ontology'")
    .first<string>('id')
  assert.ok(applicationJob)
  assert.equal(result.mutations, 1)
  const applied = await processTaxonomyMessage(
    { jobId: applicationJob },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    { now: () => 15_052_000 },
  )
  assert.equal(applied.mutations, 1)
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    2,
  )
})

test('multi-proposal rollout retries idempotently after a later enqueue failure', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_075_000 })
  const providerId = await addProvider(service, {
    name: 'retry-rollout-primary',
    credential: 'retry-rollout-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1,
     rollout_basis_points = 10000 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'gradual'").run()
  const jobId = await service.enqueueConcept('retry rollout')
  assert.ok(jobId)
  const response = {
    schemaVersion: 1,
    proposals: ['retry alias one', 'retry alias two'].map((alias) => ({
      kind: 'alias',
      alias,
      targetTagId: '1',
      confidence: 0.99,
      evidence: 'Retry-safe multi-proposal evidence.',
    })),
  }
  await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 15_076_000,
      fetch: async () =>
        Response.json({ output_text: JSON.stringify(response) }),
    },
  )
  const laterJobId = await db
    .prepare("SELECT id FROM taxonomy_jobs WHERE kind = 'apply_ontology'")
    .first<string>('id')
  assert.ok(laterJobId)
  await db
    .prepare('DELETE FROM taxonomy_outbox WHERE job_id = ?')
    .bind(laterJobId)
    .run()
  await db
    .prepare('DELETE FROM taxonomy_jobs WHERE id = ?')
    .bind(laterJobId)
    .run()
  await db.prepare('DELETE FROM tag_aliases').run()
  await db.prepare('UPDATE taxonomy_state SET published_version = 1').run()
  await db
    .prepare(
      `UPDATE taxonomy_candidates SET status = 'proposed', decision_reason = NULL,
     decided_at = NULL WHERE job_id = ?`,
    )
    .bind(jobId)
    .run()
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    0,
  )
  await db
    .prepare(
      `UPDATE taxonomy_jobs SET status = 'pending', available_at = 15076,
     lease_owner = NULL, lease_token = NULL, leased_until = NULL,
     completed_at = NULL, last_error_code = NULL, last_error_summary = NULL
     WHERE id = ?`,
    )
    .bind(jobId)
    .run()
  const retried = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 15_077_000,
      fetch: async () =>
        Response.json({ output_text: JSON.stringify(response) }),
    },
  )
  assert.equal(retried.mutations, 1)
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'apply_ontology'",
      )
      .first('count(*)'),
    1,
  )
})

test('reassess filters provider proposals that collide with occupied tag slugs', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1, 'humor')
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_150_000 })
  const providerId = await addProvider(service, {
    name: 'slug-collision-provider',
    credential: 'slug-collision-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1,
       rollout_basis_points = 10000 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('humor evidence')
  assert.ok(jobId)
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 15_151_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            proposals: [
              {
                kind: 'alias',
                alias: 'humor',
                targetTagId: '1',
                confidence: 0.99,
                evidence: 'The provider mistook the tag name for an alias.',
              },
            ],
          }),
        }),
    },
  )
  assert.deepEqual(result, {
    jobId,
    status: 'settled',
    attempts: 1,
    mutations: 0,
  })
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM taxonomy_candidates')
      .first('count(*)'),
    0,
  )
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    0,
  )
})

test('reassess filters concept proposals whose slug is occupied by a merged tag', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1, 'endless')
  await insertTag(db, 2, 'infinite')
  await db
    .prepare(
      `UPDATE tags SET status = 'merged', canonical = 0,
       merged_into_tag_id = 2, deprecated_at = unixepoch() WHERE id = 1`,
    )
    .run()
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_200_000 })
  const providerId = await addProvider(service, {
    name: 'merged-slug-provider',
    credential: 'merged-slug-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1,
       rollout_basis_points = 10000 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('endless evidence')
  assert.ok(jobId)
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 15_201_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            proposals: [
              {
                kind: 'concept',
                proposedName: 'endless',
                proposedSlug: 'endless',
                confidence: 0.99,
                evidence: 'The merged slug cannot be published again.',
              },
            ],
          }),
        }),
    },
  )
  assert.deepEqual(result, {
    jobId,
    status: 'settled',
    attempts: 1,
    mutations: 0,
  })
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM taxonomy_candidates')
      .first('count(*)'),
    0,
  )
})

test('apply_ontology settles obsolete when the accepted candidate collides with a new tag slug', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_250_000 })
  const providerId = await addProvider(service, {
    name: 'late-collision-provider',
    credential: 'late-collision-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1,
       rollout_basis_points = 0 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'gradual'").run()
  const jobId = await service.enqueueConcept('late collision')
  assert.ok(jobId)
  await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 15_251_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            proposals: [
              {
                kind: 'alias',
                alias: 'taken alias',
                targetTagId: '1',
                confidence: 0.99,
                evidence: 'Valid at proposal time.',
              },
            ],
          }),
        }),
    },
  )
  const candidateId = await db
    .prepare(
      "SELECT id FROM taxonomy_candidates WHERE job_id = ? AND kind = 'alias'",
    )
    .bind(jobId)
    .first<string>('id')
  assert.ok(candidateId)
  const accepted = await service.decideCandidate({
    candidateId,
    decision: 'accepted',
    reason: 'Deliberately approved',
    actorId: 'admin',
  })
  assert.ok(accepted.jobId)
  await insertTag(db, 2, 'taken alias')
  const applied = await processTaxonomyMessage(
    { jobId: accepted.jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    { now: () => 15_252_000 },
  )
  assert.equal(applied.status, 'obsolete')
  assert.equal(applied.mutations, 0)
  assert.equal(
    await db.prepare('SELECT count(*) FROM tag_aliases').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT last_error_code FROM taxonomy_jobs WHERE id = ?')
      .bind(accepted.jobId)
      .first('last_error_code'),
    'candidate_changed',
  )
})

test('admin acceptance atomically requeues a leased rollout exclusion', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET rollout_basis_points = 0 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'gradual'").run()
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 15_100_000 })
  await db
    .prepare(
      `INSERT INTO taxonomy_jobs
       (id, job_key, kind, concept_key, input_hash, taxonomy_version,
        policy_config_id, status, max_attempts, available_at, created_at,
        updated_at, completed_at)
       VALUES ('accept-race-source', 'accept-race-source-key', 'reassess_concept',
               'accept race', ?, 1, 1, 'settled', 1, 15099, 15099, 15099, 15099)`,
    )
    .bind(hash)
    .run()
  await service.repository.saveCandidate({
    id: 'accept-race-candidate',
    jobId: 'accept-race-source',
    attemptId: null,
    candidateKey: 'alias:accept-race:1',
    kind: 'alias',
    tagId: 1,
    normalizedConcept: 'accept race',
    payload: {
      kind: 'alias',
      alias: 'accepted during lease',
      targetTagId: '1',
      confidence: 0.99,
      evidence: 'Explicitly approved while the rollout worker is leased.',
    },
    confidenceMicros: 990_000,
    rank: 0,
    now: 15_099,
  })
  const jobId = await service.enqueueOntologyCandidate('accept-race-candidate')
  assert.ok(jobId)
  await db
    .prepare(
      'UPDATE taxonomy_outbox SET dispatched_at = 15101 WHERE job_id = ?',
    )
    .bind(jobId)
    .run()
  const leased = await service.repository.leaseJob(
    jobId,
    'rollout-worker',
    'stale-rollout-token',
    15_101,
    120,
  )
  assert.ok(leased)

  const accepted = await service.decideCandidate({
    candidateId: 'accept-race-candidate',
    decision: 'accepted',
    reason: 'Approve during active rollout lease',
    actorId: 'admin',
  })
  assert.equal(accepted.decided, true)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT status, lease_token AS leaseToken, attempt_count AS attemptCount,
                completed_at AS completedAt
         FROM taxonomy_jobs WHERE id = ?`,
      )
      .bind(jobId)
      .first(),
    {
      status: 'pending',
      leaseToken: null,
      attemptCount: 0,
      completedAt: null,
    },
  )
  assert.equal(
    await db
      .prepare('SELECT dispatched_at FROM taxonomy_outbox WHERE job_id = ?')
      .bind(jobId)
      .first('dispatched_at'),
    null,
  )
  assert.equal(
    await service.repository.settleRolloutExcludedCandidate(
      'accept-race-candidate',
      leased,
      15_102,
    ),
    false,
  )
  assert.equal(
    await service.repository.settleJob(
      leased,
      'settled',
      15_102,
      'rollout_excluded',
      'stale settlement',
    ),
    false,
  )

  const applied = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    { now: () => 15_102_000 },
  )
  assert.equal(applied.status, 'settled')
  assert.equal(applied.mutations, 1)
  assert.equal(
    await db
      .prepare(
        "SELECT tag_id FROM tag_aliases WHERE alias = 'accepted during lease'",
      )
      .first('tag_id'),
    1,
  )
})

test('disagreement retries keep attempt-consistent conservative and applied settlements', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  await insertTag(db, 2)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 16_000_000 })
  const primaryId = await addProvider(service, {
    name: 'partial-primary',
    credential: 'partial-primary-secret',
    role: 'primary',
    priority: 0,
  })
  await addProvider(service, {
    name: 'partial-consensus',
    credential: 'partial-consensus-secret',
    role: 'consensus',
    priority: 1,
  })
  await service.activateProvider(primaryId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET retry_budget = 1,
       disagreement_trip_basis_points = 10000 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  let calls = 0
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const round = Math.floor(calls / 2)
    calls += 1
    const authorization = String(
      (init?.headers as Record<string, string>).authorization,
    )
    const decisions = [providerDecision(1).decisions[0]]
    if (round === 0 && authorization.includes('partial-primary-secret')) {
      decisions.push(providerDecision(2).decisions[0])
    }
    return Response.json({
      output_text: JSON.stringify({ schemaVersion: 1, decisions }),
    })
  }
  const runtimeEnv = { ...env, TAXONOMY_QUEUE: mockQueue() }
  const first = await processTaxonomyMessage({ jobId }, runtimeEnv, {
    now: () => 16_001_000,
    fetch,
  })
  assert.equal(first.status, 'retry_wait')
  assert.equal(first.mutations, 0)
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT candidate.attempt_id AS attemptId, candidate.status, decision.outcome
           FROM taxonomy_candidates candidate
           JOIN tag_assignment_decisions decision ON decision.candidate_id = candidate.id`,
        )
        .all()
    ).results,
    [
      {
        attemptId: `attempt:${jobId}:1`,
        status: 'deferred',
        outcome: 'conservative',
      },
    ],
  )

  const second = await processTaxonomyMessage({ jobId }, runtimeEnv, {
    now: () => 16_061_000,
    fetch,
  })
  assert.equal(second.status, 'settled')
  assert.equal(second.mutations, 1)
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT candidate.attempt_id AS attemptId, candidate.status, decision.outcome
           FROM taxonomy_candidates candidate
           JOIN tag_assignment_decisions decision ON decision.candidate_id = candidate.id
           ORDER BY candidate.created_at, candidate.id`,
        )
        .all()
    ).results,
    [
      {
        attemptId: `attempt:${jobId}:1`,
        status: 'deferred',
        outcome: 'conservative',
      },
      {
        attemptId: `attempt:${jobId}:3`,
        status: 'accepted',
        outcome: 'applied',
      },
    ],
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT assignment.source, decision.outcome
         FROM site_tags assignment
         JOIN tag_assignment_decisions decision ON decision.id = assignment.decision_id`,
      )
      .first(),
    { source: 'automation', outcome: 'applied' },
  )
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT event_type AS eventType FROM taxonomy_audit_events
           WHERE entity_type = 'site_assignment' ORDER BY created_at, id`,
        )
        .all()
    ).results,
    [{ eventType: 'assignment_evaluated' }, { eventType: 'assignment_add' }],
  )
  const assignmentAudit = await db
    .prepare(
      `SELECT before, after FROM taxonomy_audit_events
       WHERE event_type = 'assignment_add'`,
    )
    .first<{ before: string; after: string }>()
  assert.ok(assignmentAudit)
  assert.deepEqual(JSON.parse(assignmentAudit.before).tag, {
    id: 1,
    status: 'active',
    revision: 1,
  })
  assert.deepEqual(JSON.parse(assignmentAudit.after).tag, {
    id: 1,
    status: 'active',
    revision: 1,
  })
})

test('duplicate provider tag IDs reject the whole response without assignment settlement', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 17_000_000 })
  const providerId = await addProvider(service, {
    name: 'duplicate-primary',
    credential: 'duplicate-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare('UPDATE taxonomy_policy_configs SET retry_budget = 0 WHERE id = 1')
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const duplicate = {
    schemaVersion: 1,
    decisions: [
      providerDecision(1, 'assign').decisions[0],
      providerDecision(1, 'do_not_assign').decisions[0],
    ],
  }
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 17_001_000,
      fetch: async () =>
        Response.json({ output_text: JSON.stringify(duplicate) }),
    },
  )
  assert.equal(result.status, 'degraded')
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM tag_assignment_decisions')
      .first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM taxonomy_candidates')
      .first('count(*)'),
    0,
  )
})

test('classification settlement rejects a stale tag revision without audit writes', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 17_500_000 })
  const providerConfigId = await addProvider(service, {
    name: 'stale-tag-provider',
    credential: 'stale-tag-secret',
    role: 'primary',
    priority: 0,
  })
  const repository = new TaxonomyRepository(db)
  await repository.enqueueJob(
    {
      id: 'stale-tag-job',
      jobKey: 'stale-tag-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      policyConfigId: 1,
      maxAttempts: 1,
    },
    17_500,
  )
  const job = await repository.leaseJob(
    'stale-tag-job',
    'worker',
    'stale-tag-token',
    17_500,
    900,
  )
  assert.ok(job)
  const snapshot = await repository.candidateSnapshot(job, 500)
  assert.ok(snapshot)
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, started_at, completed_at)
       VALUES ('attempt-stale-tag', 'stale-tag-job', 1, ?, 'succeeded',
               'stale-tag-provider', ?, 17500, 17500)`,
    )
    .bind(providerConfigId, hash)
    .run()
  await db.prepare('UPDATE tags SET revision = 2 WHERE id = 1').run()
  const policy = await repository.loadPolicy(1)
  await assert.rejects(
    repository.applyAssignments(
      [
        {
          job,
          site: snapshot.site,
          tag: snapshot.tags[0],
          candidateId: 'candidate-stale-tag',
          attemptId: 'attempt-stale-tag',
          candidateKey: 'existing:1:assign:stale',
          payload: providerDecision(1).decisions[0],
          marginMicros: 500_000,
          rank: 0,
          decisionId: 'decision-stale-tag',
          batchId: 'classification:stale-tag-job',
          eventId: 'event-stale-tag',
          action: 'add',
          outcome: 'applied',
          confidenceMicros: 990_000,
          reason: 'stale revision',
          providerConfigId,
          providerModel: 'test',
          policy,
          releaseSha: 'test',
          now: 17_501,
        },
      ],
      true,
    ),
  )
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_audit_events WHERE id = 'event-stale-tag'",
      )
      .first('count(*)'),
    0,
  )
})

test('classification provider work cannot settle after the site input hash changes', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 17_600_000 })
  const providerId = await addProvider(service, {
    name: 'stale-hash-provider',
    credential: 'stale-hash-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const newerHash = 'b'.repeat(64)
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 17_601_000,
      fetch: async () => {
        await db
          .prepare(
            `UPDATE sites SET classification_input_hash = ?, content_version = 2
             WHERE id = 1`,
          )
          .bind(newerHash)
          .run()
        return Response.json({
          output_text: JSON.stringify(providerDecision(1)),
        })
      },
    },
  )
  assert.equal(result.status, 'obsolete')
  assert.equal(result.mutations, 0)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT classification_input_hash AS inputHash,
                content_version AS contentVersion FROM sites WHERE id = 1`,
      )
      .first(),
    { inputHash: newerHash, contentVersion: 2 },
  )
  const replacement = await db
    .prepare(
      `SELECT status, input_hash AS inputHash,
              site_content_version AS siteContentVersion
       FROM taxonomy_jobs WHERE id <> ?`,
    )
    .bind(jobId)
    .first()
  assert.deepEqual(replacement, {
    status: 'pending',
    inputHash: newerHash,
    siteContentVersion: 2,
  })
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_audit_events
         WHERE entity_type = 'site_assignment'`,
      )
      .first('count(*)'),
    0,
  )
})

test('classification requeues current site input after a concurrent taxonomy revision', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 17_700_000 })
  const providerId = await addProvider(service, {
    name: 'taxonomy-race-provider',
    credential: 'taxonomy-race-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const sourceJob = await db
    .prepare('SELECT input_hash AS inputHash FROM taxonomy_jobs WHERE id = ?')
    .bind(jobId)
    .first<{ inputHash: string }>()
  assert.ok(sourceJob)

  await db.prepare('UPDATE taxonomy_state SET published_version = 2').run()
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    { now: () => 17_701_000 },
  )

  assert.equal(result.status, 'retry_wait')
  assert.deepEqual(
    await db
      .prepare(
        `SELECT id, status, taxonomy_version AS taxonomyVersion,
                attempt_count AS attemptCount, input_hash AS inputHash
         FROM taxonomy_jobs WHERE kind = 'classify_site'`,
      )
      .first(),
    {
      id: jobId,
      status: 'pending',
      taxonomyVersion: 2,
      attemptCount: 0,
      inputHash: sourceJob.inputHash,
    },
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_jobs WHERE kind = 'classify_site'`,
      )
      .first('count(*)'),
    1,
  )
})

test('a new site keeps one classification job through repeated taxonomy revisions', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 17_800_000 })
  const providerId = await addProvider(service, {
    name: 'stable-version-provider',
    credential: 'stable-version-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)

  for (const version of [2, 3, 4]) {
    await db
      .prepare('UPDATE taxonomy_state SET published_version = ?')
      .bind(version)
      .run()
    const result = await processTaxonomyMessage(
      { jobId },
      { ...env, TAXONOMY_QUEUE: mockQueue() },
      { now: () => 17_800_000 + version * 1_000 },
    )
    assert.equal(result.status, 'retry_wait')
    assert.deepEqual(
      await db
        .prepare(
          `SELECT id, status, taxonomy_version AS taxonomyVersion,
                  attempt_count AS attemptCount
           FROM taxonomy_jobs WHERE kind = 'classify_site'`,
        )
        .first(),
      {
        id: jobId,
        status: 'pending',
        taxonomyVersion: version,
        attemptCount: 0,
      },
    )
  }
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_jobs WHERE kind = 'classify_site'`,
      )
      .first('count(*)'),
    1,
  )
})

test('enqueued taxonomy jobs dispatch to the queue immediately', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const sent: unknown[] = []
  const repository = new TaxonomyRepository(
    db,
    mockQueue(async (message) => {
      sent.push(message)
    }),
  )
  const inserted = await repository.enqueueJob(
    {
      id: 'immediate-dispatch-job',
      jobKey: `site:1:input:${'a'.repeat(64)}:taxonomy:1:classifier:1-1`,
      kind: 'classify_site',
      siteId: 1,
      inputHash: 'a'.repeat(64),
      siteContentVersion: 1,
      taxonomyVersion: 1,
      providerConfigId: null,
      policyConfigId: null,
      priority: 0,
      maxAttempts: 3,
    },
    19_000_000,
  )
  assert.equal(inserted, true)
  assert.deepEqual(sent, [{ jobId: 'immediate-dispatch-job' }])
  const outbox = await db
    .prepare(
      `SELECT dispatched_at AS dispatchedAt, job_id AS jobId
       FROM taxonomy_outbox WHERE job_id = ?`,
    )
    .bind('immediate-dispatch-job')
    .first()
  assert.ok(outbox)
  assert.ok(outbox.dispatchedAt !== null)
  assert.ok(outbox.jobId === 'immediate-dispatch-job')
})

test('forced reassessment enqueues after a settled concept job at the same version', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1, 'humor')
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 16_000_000 })
  const providerId = await addProvider(service, {
    name: 'forced-wrangle-provider',
    credential: 'forced-wrangle-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  const standard = await service.enqueueConcept('humor')
  assert.ok(standard)
  await db
    .prepare(
      "UPDATE taxonomy_jobs SET status = 'settled', completed_at = ? WHERE id = ?",
    )
    .bind(16_000_001, standard)
    .run()
  const forced = await service.forceConceptReassessment('humor')
  assert.ok(forced)
  assert.notEqual(forced, standard)
  const rows = await db
    .prepare(
      `SELECT id, status FROM taxonomy_jobs
       WHERE kind = 'reassess_concept' ORDER BY created_at`,
    )
    .all<{ id: string; status: string }>()
  assert.equal(rows.results.length, 2)
  assert.deepEqual(
    rows.results.map((row: { status: string }) => row.status),
    ['settled', 'pending'],
  )
  const again = await service.forceConceptReassessment('humor')
  assert.equal(again, forced)
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'reassess_concept'",
      )
      .first('count(*)'),
    2,
  )
})

test('ontology budget exhaustion surfaces the real error and retries at the next budget reset', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 90_000_000 })
  const providerId = await addProvider(service, {
    name: 'budget-exhausted-provider',
    credential: 'budget-exhausted-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1,
       daily_request_budget = 0 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('budget concept')
  assert.ok(jobId)
  let fetchCalls = 0
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 90_000_000,
      fetch: async () => {
        fetchCalls += 1
        return Response.json({ output_text: JSON.stringify({}) })
      },
    },
  )
  assert.equal(result.status, 'retry_wait')
  assert.equal(fetchCalls, 0)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT last_error_code, last_error_summary, available_at, attempt_count
         FROM taxonomy_jobs WHERE id = ?`,
      )
      .bind(jobId)
      .first(),
    {
      last_error_code: 'rate_limit',
      last_error_summary: 'Daily taxonomy provider budget exhausted',
      available_at: 172_830,
      attempt_count: 1,
    },
  )
  assert.equal(
    await db
      .prepare('SELECT count(*) FROM taxonomy_job_attempts')
      .first('count(*)'),
    0,
  )
})

test('pending ontology jobs follow the activated policy revision', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 16_200_000 })
  const providerId = await addProvider(service, {
    name: 'policy-follow-provider',
    credential: 'policy-follow-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1
       WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('policy pin')
  assert.ok(jobId)
  const policy = await service.repository.loadPolicy(1)
  const { id: _id, revision: _revision, ...policyInput } = policy
  const nextPolicyId = await service.createPolicyRevision(
    { ...policyInput, dailyRequestBudget: 500 },
    'admin',
  )
  await service.activatePolicy(nextPolicyId)
  let fetchCalls = 0
  const first = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 16_201_000,
      fetch: async () => {
        fetchCalls += 1
        return Response.json({
          output_text: JSON.stringify({ schemaVersion: 1, proposals: [] }),
        })
      },
    },
  )
  assert.equal(first.status, 'retry_wait')
  assert.equal(fetchCalls, 0)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT policy_config_id AS policyConfigId, attempt_count AS attemptCount,
                status FROM taxonomy_jobs WHERE id = ?`,
      )
      .bind(jobId)
      .first(),
    {
      policyConfigId: nextPolicyId,
      attemptCount: 0,
      status: 'pending',
    },
  )
  const second = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 16_202_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({ schemaVersion: 1, proposals: [] }),
        }),
    },
  )
  assert.equal(second.status, 'settled')
})

test('ontology contract violations surface the real error without retrying', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 16_300_000 })
  const providerId = await addProvider(service, {
    name: 'contract-violation-provider',
    credential: 'contract-violation-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1
       WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('contract concept')
  assert.ok(jobId)
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 16_301_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({ schemaVersion: 1, proposals: 'oops' }),
        }),
    },
  )
  assert.equal(result.status, 'degraded')
  assert.deepEqual(
    await db
      .prepare(
        `SELECT last_error_code, last_error_summary, attempt_count
         FROM taxonomy_jobs WHERE id = ?`,
      )
      .bind(jobId)
      .first(),
    {
      last_error_code: 'permanent_failure',
      last_error_summary: 'Provider output violated the response contract',
      attempt_count: 1,
    },
  )
})

test('site classification can be disabled without stopping concept reassessment', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 17_800_000 })
  const providerId = await addProvider(service, {
    name: 'classification-toggle-provider',
    credential: 'classification-toggle-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const classificationJobId = await service.enqueueSite(1)
  assert.ok(classificationJobId)

  await service.setSiteClassificationEnabled(false)
  assert.equal(await service.enqueueSite(1), null)
  assert.ok(await service.enqueueConcept('still assessed'))

  const result = await processTaxonomyMessage(
    { jobId: classificationJobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 17_801_000,
      fetch: async () => {
        throw new Error('Disabled classification must not call a provider')
      },
    },
  )
  assert.deepEqual(result, {
    jobId: classificationJobId,
    status: 'degraded',
    attempts: 1,
    mutations: 0,
  })
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_job_attempts
         WHERE job_id = ?`,
      )
      .bind(classificationJobId)
      .first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_audit_events
         WHERE event_type = 'site_classification_changed'
           AND json_extract(after, '$.siteClassificationEnabled') = 0`,
      )
      .first('count(*)'),
    1,
  )
})

test('placeholder promotion preserves assignments and threshold evidence queues one reassessment', async (context) => {
  const db = await migratedTaxonomyDb(context)
  for (const siteId of [1, 2, 3]) await insertSite(db, siteId)
  await db
    .prepare(
      `INSERT INTO tags
       (id, slug, name, canonical, status, revision, automation_locked)
       VALUES (10, 'new-signal', 'New Signal', 0, 'active', 1, 0)`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO site_tags
       (site_id, tag_id, raw_name, source, revision, created_at, updated_at)
       VALUES (1, 10, 'New Signal', 'admin', 4, 100, 200)`,
    )
    .run()
  const service = new TaxonomyService(serviceEnv(db), { now: () => 18_000_000 })
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const terminalJobId = await service.enqueueConcept('new signal')
  await db
    .prepare(
      `UPDATE taxonomy_jobs SET status = 'degraded', attempt_count = max_attempts,
       completed_at = 17999, last_error_code = 'automation_disabled',
       last_error_summary = 'disabled' WHERE id = ?`,
    )
    .bind(terminalJobId)
    .run()
  await db
    .prepare(
      `UPDATE taxonomy_outbox SET dispatched_at = 17999, last_error = 'sent'
       WHERE job_id = ?`,
    )
    .bind(terminalJobId)
    .run()
  for (const siteId of [1, 2, 3]) {
    await service.repository.recordEvidence({
      id: `promotion-evidence-${siteId}`,
      concept: 'new signal',
      siteId,
      inputHash: hash,
      sourceKey: `site-${siteId}`,
      source: 'submitted_hint',
      evidenceHash: hash,
      evidenceSnippet: `site ${siteId}`,
      confidenceMicros: 1_000_000,
      accepted: true,
      now: 18_000,
    })
  }
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_jobs WHERE kind = 'reassess_concept'",
      )
      .first('count(*)'),
    1,
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_outbox outbox
         JOIN taxonomy_jobs job ON job.id = outbox.job_id
         WHERE job.kind = 'reassess_concept'`,
      )
      .first('count(*)'),
    1,
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT id, status, attempt_count AS attemptCount,
                completed_at AS completedAt, last_error_code AS lastErrorCode
         FROM taxonomy_jobs WHERE kind = 'reassess_concept'`,
      )
      .first(),
    {
      id: terminalJobId,
      status: 'pending',
      attemptCount: 0,
      completedAt: null,
      lastErrorCode: null,
    },
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT dispatched_at AS dispatchedAt, lease_token AS leaseToken,
                last_error AS lastError
         FROM taxonomy_outbox WHERE job_id = ?`,
      )
      .bind(terminalJobId)
      .first(),
    { dispatchedAt: null, leaseToken: null, lastError: null },
  )
  await db.batch([
    db
      .prepare(
        `UPDATE taxonomy_jobs SET status = 'settled', completed_at = 18001,
         attempt_count = 1 WHERE id = ?`,
      )
      .bind(terminalJobId),
    db
      .prepare(
        `UPDATE taxonomy_outbox SET dispatched_at = 18001 WHERE job_id = ?`,
      )
      .bind(terminalJobId),
  ])
  await service.repository.recordEvidence({
    id: 'duplicate-promotion-evidence',
    concept: 'new signal',
    siteId: 3,
    inputHash: hash,
    sourceKey: 'site-3',
    source: 'submitted_hint',
    evidenceHash: hash,
    evidenceSnippet: 'duplicate site 3',
    confidenceMicros: 1_000_000,
    accepted: true,
    now: 18_002,
  })
  assert.deepEqual(
    await db
      .prepare(
        `SELECT status, completed_at AS completedAt
         FROM taxonomy_jobs WHERE id = ?`,
      )
      .bind(terminalJobId)
      .first(),
    { status: 'settled', completedAt: 18_001 },
  )
  await service.repository.recordEvidence({
    id: 'material-promotion-evidence',
    concept: 'new signal',
    siteId: 3,
    inputHash: 'c'.repeat(64),
    sourceKey: 'material-reassessment',
    source: 'deterministic',
    evidenceHash: 'd'.repeat(64),
    evidenceSnippet: 'Material new support from the same site',
    confidenceMicros: 1_000_000,
    accepted: true,
    materiallyNewSupport: true,
    now: 18_003,
  })
  assert.equal(
    await db
      .prepare('SELECT status FROM taxonomy_jobs WHERE id = ?')
      .bind(terminalJobId)
      .first('status'),
    'pending',
  )
  await service.createLock({
    scope: 'site_assignment',
    siteId: 1,
    tagId: 10,
    reason: 'Preserve this site assignment only',
    actorId: 'admin',
  })
  const published = await service.publishOntology({
    kind: 'canonical',
    proposedName: 'New Signal Canonical',
    proposedSlug: 'new-signal',
    normalizedConcept: 'new signal',
    expectedVersion: 1,
  })
  assert.equal(published.tagId, 10)
  assert.deepEqual(
    await db
      .prepare(`SELECT name, canonical, revision FROM tags WHERE id = 10`)
      .first(),
    { name: 'New Signal Canonical', canonical: 1, revision: 2 },
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT raw_name AS rawName, source, revision, created_at AS createdAt,
                updated_at AS updatedAt FROM site_tags
         WHERE site_id = 1 AND tag_id = 10`,
      )
      .first(),
    {
      rawName: 'New Signal',
      source: 'admin',
      revision: 4,
      createdAt: 100,
      updatedAt: 200,
    },
  )
  assert.equal(
    await db
      .prepare("SELECT count(*) FROM tags WHERE slug = 'new-signal'")
      .first('count(*)'),
    1,
  )
})

test('canonical publication returns its in-batch identity across an immediate merge', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  for (const siteId of [1, 2, 3]) await insertSite(db, siteId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 18_100_000 })
  for (const siteId of [1, 2, 3]) {
    await service.repository.recordEvidence({
      id: `identity-evidence-${siteId}`,
      concept: 'batch identity',
      siteId,
      inputHash: hash,
      sourceKey: `site-${siteId}`,
      source: 'submitted_hint',
      evidenceHash: hash,
      evidenceSnippet: `site ${siteId}`,
      confidenceMicros: 1_000_000,
      accepted: true,
      now: 18_100,
    })
  }

  let mergedAfterPublication = false
  let mergedTagId: number | null = null
  const raceDb = new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements)
          if (!mergedAfterPublication) {
            mergedAfterPublication = true
            const source = await target
              .prepare("SELECT id FROM tags WHERE slug = 'batch-identity'")
              .first<{ id: number }>()
            assert.ok(source)
            mergedTagId = source.id
            await service.publishOntology({
              kind: 'merge',
              sourceTagId: source.id,
              targetTagId: 1,
              expectedVersion: 2,
              expectedTagRevision: 1,
            })
          }
          return results
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const racingService = new TaxonomyService(
    { ...env, DB: raceDb },
    { now: () => 18_100_000 },
  )
  const published = await racingService.publishOntology({
    kind: 'canonical',
    proposedName: 'Batch Identity',
    proposedSlug: 'batch-identity',
    normalizedConcept: 'batch identity',
    expectedVersion: 1,
  })

  assert.equal(mergedAfterPublication, true)
  assert.equal(published.tagId, mergedTagId)
  assert.deepEqual(
    await db
      .prepare(
        "SELECT status, merged_into_tag_id AS mergedInto FROM tags WHERE slug = 'batch-identity'",
      )
      .first(),
    { status: 'merged', mergedInto: 1 },
  )
})

test('inactive automation settlements are recoverable through atomic degraded retries', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 19_000_000 })
  const runtimeEnv = { ...env, TAXONOMY_QUEUE: mockQueue() }
  const jobIds: string[] = []
  const states = [
    { mode: 'disabled', circuit: 'closed' },
    { mode: 'degraded', circuit: 'closed' },
    { mode: 'shadow', circuit: 'open' },
  ] as const
  for (const [index, state] of states.entries()) {
    const siteId = index + 1
    await insertSite(db, siteId)
    await db
      .prepare(
        `UPDATE taxonomy_state SET mode = ?, circuit_state = ?,
         circuit_opened_at = CASE WHEN ? = 'open' THEN 19000 ELSE NULL END`,
      )
      .bind(state.mode, state.circuit, state.circuit)
      .run()
    const jobId = await service.enqueueSite(siteId)
    assert.ok(jobId)
    jobIds.push(jobId)
    await db
      .prepare(
        'UPDATE taxonomy_outbox SET dispatched_at = 19000 WHERE job_id = ?',
      )
      .bind(jobId)
      .run()
    const result = await processTaxonomyMessage({ jobId }, runtimeEnv, {
      now: () => 19_001_000 + index * 1_000,
    })
    assert.equal(result.status, 'degraded')
  }
  await db
    .prepare(
      `UPDATE taxonomy_state SET mode = 'shadow', circuit_state = 'closed',
       circuit_reason = NULL, circuit_opened_at = NULL`,
    )
    .run()
  assert.equal(await service.retryJobs(jobIds), 3)
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT status, attempt_count AS attemptCount
           FROM taxonomy_jobs WHERE id IN (?, ?, ?) ORDER BY site_id`,
        )
        .bind(...jobIds)
        .all()
    ).results,
    [
      { status: 'pending', attemptCount: 0 },
      { status: 'pending', attemptCount: 0 },
      { status: 'pending', attemptCount: 0 },
    ],
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_outbox
         WHERE job_id IN (?, ?, ?) AND dispatched_at IS NULL`,
      )
      .bind(...jobIds)
      .first('count(*)'),
    3,
  )
})

test('retry recovers pending, waiting, and leased jobs and dispatches them', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 19_500_000 })
  const sent: string[] = []
  const runtimeEnv = {
    ...env,
    TAXONOMY_QUEUE: mockQueue(async (message) => {
      sent.push(
        typeof message === 'object' &&
          message !== null &&
          'jobId' in message &&
          typeof message.jobId === 'string'
          ? message.jobId
          : '',
      )
    }),
  }
  const statuses = ['pending', 'retry_wait', 'leased'] as const
  const jobIds: string[] = []
  for (const [index, status] of statuses.entries()) {
    const siteId = index + 1
    await insertSite(db, siteId)
    const jobId = await service.enqueueSite(siteId)
    assert.ok(jobId)
    jobIds.push(jobId)
    await db
      .prepare(
        `UPDATE taxonomy_jobs SET status = ?, attempt_count = 2,
         available_at = 20000, last_error_code = 'stale',
         lease_owner = CASE WHEN ? = 'leased' THEN 'worker' ELSE NULL END,
         lease_token = CASE WHEN ? = 'leased' THEN 'token' ELSE NULL END,
         leased_until = CASE WHEN ? = 'leased' THEN 20000 ELSE NULL END
         WHERE id = ?`,
      )
      .bind(status, status, status, status, jobId)
      .run()
    await db
      .prepare(
        'UPDATE taxonomy_outbox SET dispatched_at = 19000 WHERE job_id = ?',
      )
      .bind(jobId)
      .run()
  }
  assert.equal(await service.retryJobs(jobIds), 3)
  assert.deepEqual(
    (
      await db
        .prepare(
          `SELECT status, attempt_count AS attemptCount, last_error_code AS error
           FROM taxonomy_jobs WHERE id IN (?, ?, ?) ORDER BY site_id`,
        )
        .bind(...jobIds)
        .all()
    ).results,
    [
      { status: 'pending', attemptCount: 0, error: null },
      { status: 'pending', attemptCount: 0, error: null },
      { status: 'pending', attemptCount: 0, error: null },
    ],
  )
  assert.equal(
    await db
      .prepare(
        `SELECT count(*) FROM taxonomy_outbox
         WHERE job_id IN (?, ?, ?) AND dispatched_at IS NULL`,
      )
      .bind(...jobIds)
      .first('count(*)'),
    3,
  )
  assert.equal(
    await dispatchTaxonomyOutbox(runtimeEnv, { now: () => 19_500_000 }),
    3,
  )
  assert.deepEqual(sent.sort(), [...jobIds].sort())
})

test('retrying a stale classification job enqueues current work instead', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 19_700_000 })
  const staleJobId = await service.enqueueSite(1)
  assert.ok(staleJobId)
  await db
    .prepare(
      `UPDATE taxonomy_jobs SET status = 'degraded', completed_at = 19699,
       last_error_code = 'stale_input' WHERE id = ?`,
    )
    .bind(staleJobId)
    .run()
  await db.prepare('UPDATE taxonomy_state SET published_version = 2').run()

  assert.equal(await service.retryJobs([staleJobId]), 1)
  const jobs = (
    await db
      .prepare(
        `SELECT id, taxonomy_version AS taxonomyVersion, status
         FROM taxonomy_jobs ORDER BY taxonomy_version`,
      )
      .all()
  ).results
  assert.deepEqual(jobs[0], {
    id: staleJobId,
    taxonomyVersion: 1,
    status: 'degraded',
  })
  assert.equal(jobs[1]?.taxonomyVersion, 2)
  assert.equal(jobs[1]?.status, 'pending')
})

test('ignored leases rearm runnable pending outbox rows', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const repository = new TaxonomyRepository(db)
  await insertSite(db, 1)
  await repository.enqueueJob(
    {
      id: 'rearm-job',
      jobKey: 'rearm-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      policyConfigId: 1,
      maxAttempts: 3,
    },
    19_600,
  )
  await db
    .prepare(
      "UPDATE taxonomy_outbox SET dispatched_at = 19600 WHERE job_id = 'rearm-job'",
    )
    .run()
  assert.equal(await repository.rearmRunnableOutbox('rearm-job', 19_600), true)
  assert.equal(
    await db
      .prepare(
        "SELECT dispatched_at FROM taxonomy_outbox WHERE job_id = 'rearm-job'",
      )
      .first('dispatched_at'),
    null,
  )
  await db
    .prepare(
      `UPDATE taxonomy_jobs SET available_at = 30000, status = 'retry_wait'
       WHERE id = 'rearm-job'`,
    )
    .run()
  await db
    .prepare(
      "UPDATE taxonomy_outbox SET dispatched_at = 19600 WHERE job_id = 'rearm-job'",
    )
    .run()
  assert.equal(await repository.rearmRunnableOutbox('rearm-job', 19_600), false)
  const env = { ...serviceEnv(db), TAXONOMY_QUEUE: mockQueue() }
  assert.equal(
    (
      await processTaxonomyMessage({ jobId: 'rearm-job' }, env, {
        now: () => 19_600_000,
      })
    ).status,
    'ignored',
  )
  assert.equal(
    await db
      .prepare(
        "SELECT dispatched_at FROM taxonomy_outbox WHERE job_id = 'rearm-job'",
      )
      .first('dispatched_at'),
    19_600,
  )
})

test('ontology consensus uses the deterministic required voter subset', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 20_000_000 })
  const primaryId = await addProvider(service, {
    name: 'subset-primary',
    credential: 'subset-primary-secret',
    role: 'primary',
    priority: 0,
  })
  await addProvider(service, {
    name: 'subset-first',
    credential: 'subset-first-secret',
    role: 'consensus',
    priority: 1,
  })
  await addProvider(service, {
    name: 'subset-extra',
    credential: 'subset-extra-secret',
    role: 'consensus',
    priority: 2,
  })
  await service.activateProvider(primaryId)
  await db
    .prepare(
      `UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 2 WHERE id = 1`,
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('subset concept')
  assert.ok(jobId)
  const calls: string[] = []
  const proposal = {
    schemaVersion: 1,
    proposals: [
      {
        kind: 'alias',
        alias: 'subset alias',
        targetTagId: '1',
        confidence: 0.99,
        evidence: 'The terms match.',
      },
    ],
  }
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 20_001_000,
      fetch: async (_input, init) => {
        calls.push(
          String((init?.headers as Record<string, string>).authorization),
        )
        return Response.json({ output_text: JSON.stringify(proposal) })
      },
    },
  )
  assert.equal(result.status, 'settled')
  assert.equal(result.mutations, 1)
  assert.deepEqual(calls, [
    'Bearer subset-primary-secret',
    'Bearer subset-first-secret',
  ])
  assert.equal(
    await db
      .prepare("SELECT tag_id FROM tag_aliases WHERE alias = 'subset alias'")
      .first('tag_id'),
    1,
  )
})

test('ontology prompt resolves eligible placeholders and accepts a no-op response', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await db
    .prepare(
      `INSERT INTO tags (id, slug, name, canonical, status, revision)
       VALUES (1, 'eligible-concept', 'eligible concept', 0, 'active', 1)`,
    )
    .run()
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 20_250_000 })
  const providerId = await addProvider(service, {
    name: 'no-op-primary',
    credential: 'no-op-primary-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      'UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1 WHERE id = 1',
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('eligible concept')
  assert.ok(jobId)
  let requestBody = ''
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 20_251_000,
      fetch: async (_input, init) => {
        requestBody = String(init?.body)
        return Response.json({
          output_text: JSON.stringify({ schemaVersion: 1, proposals: [] }),
        })
      },
    },
  )
  assert.equal(result.status, 'settled')
  assert.equal(result.mutations, 0)
  assert.match(requestBody, /unresolved placeholder/)
  assert.match(requestBody, /evidenceSiteThreshold/)
})

test('reassessing an existing parent edge does not republish the taxonomy', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertTag(db, 1)
  await insertTag(db, 2)
  await db
    .prepare(
      'INSERT INTO tag_parents (parent_tag_id, child_tag_id) VALUES (2, 1)',
    )
    .run()
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 20_300_000 })
  const providerId = await addProvider(service, {
    name: 'existing-parent-primary',
    credential: 'existing-parent-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db
    .prepare(
      'UPDATE taxonomy_policy_configs SET ontology_provider_agreement = 1 WHERE id = 1',
    )
    .run()
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  const jobId = await service.enqueueConcept('existing parent')
  assert.ok(jobId)

  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 20_301_000,
      fetch: async () =>
        Response.json({
          output_text: JSON.stringify({
            schemaVersion: 1,
            proposals: [
              {
                kind: 'parent',
                parentTagId: '2',
                childTagId: '1',
                confidence: 0.99,
                evidence: 'The existing parent relationship is appropriate.',
              },
            ],
          }),
        }),
    },
  )

  assert.deepEqual(result, {
    jobId,
    status: 'settled',
    attempts: 1,
    mutations: 0,
  })
  assert.equal(
    await db
      .prepare('SELECT published_version FROM taxonomy_state')
      .first('published_version'),
    1,
  )
  assert.equal(
    await db
      .prepare('SELECT revision FROM tags WHERE id = 1')
      .first('revision'),
    1,
  )
})

test('classification consensus voters run concurrently under one fenced lease', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 20_500_000 })
  const primaryId = await addProvider(service, {
    name: 'parallel-primary',
    credential: 'parallel-primary-secret',
    role: 'primary',
    priority: 0,
  })
  await addProvider(service, {
    name: 'parallel-voter-one',
    credential: 'parallel-voter-one-secret',
    role: 'consensus',
    priority: 1,
  })
  await addProvider(service, {
    name: 'parallel-voter-two',
    credential: 'parallel-voter-two-secret',
    role: 'consensus',
    priority: 2,
  })
  await service.activateProvider(primaryId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'shadow'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  let activeVoters = 0
  let maxActiveVoters = 0
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 20_501_000,
      fetch: async (_input, init) => {
        const authorization = String(
          (init?.headers as Record<string, string>).authorization,
        )
        if (authorization.includes('voter')) {
          activeVoters += 1
          maxActiveVoters = Math.max(maxActiveVoters, activeVoters)
          await new Promise((resolve) => setTimeout(resolve, 20))
          activeVoters -= 1
        }
        return Response.json({
          output_text: JSON.stringify(providerDecision(1)),
        })
      },
    },
  )
  assert.equal(result.status, 'settled')
  assert.equal(maxActiveVoters, 2)
  assert.equal(
    await db
      .prepare(
        'SELECT count(DISTINCT attempt_number) FROM taxonomy_job_attempts',
      )
      .first('count(DISTINCT attempt_number)'),
    3,
  )
})

test('default five-decision classification stays below the D1 free query limit', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  for (let tagId = 1; tagId <= 5; tagId += 1) await insertTag(db, tagId)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 20_550_000 })
  const providerId = await addProvider(service, {
    name: 'free-query-primary',
    credential: 'free-query-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
  await db
    .prepare(`UPDATE sites SET classification_input_hash = ? WHERE id = 1`)
    .bind(hash)
    .run()
  await service.repository.enqueueJob(
    {
      id: 'free-query-job',
      jobKey: 'free-query-key',
      kind: 'classify_site',
      siteId: 1,
      inputHash: hash,
      siteContentVersion: 1,
      taxonomyVersion: 1,
      providerConfigId: providerId,
      policyConfigId: 1,
      maxAttempts: 1,
    },
    20_550,
  )
  let queryCount = 0
  const countingDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          queryCount += 1
          return target.prepare(sql)
        }
      }
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) => target.batch(statements)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const decisions = {
    schemaVersion: 1,
    decisions: Array.from(
      { length: 5 },
      (_, index) => providerDecision(index + 1).decisions[0],
    ),
  }
  const result = await processTaxonomyMessage(
    { jobId: 'free-query-job' },
    { ...env, DB: countingDb, TAXONOMY_QUEUE: mockQueue() },
    {
      now: () => 20_551_000,
      fetch: async () =>
        Response.json({ output_text: JSON.stringify(decisions) }),
    },
  )
  assert.equal(result.status, 'settled')
  assert.equal(result.mutations, 5)
  assert.equal(queryCount, 27)
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    5,
  )
})

test('aggregate provider deadline aborts work before the fenced lease expires', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  const env = serviceEnv(db)
  const service = new TaxonomyService(env, { now: () => 20_600_000 })
  const providerId = await addProvider(service, {
    name: 'deadline-primary',
    credential: 'deadline-secret',
    role: 'primary',
    priority: 0,
  })
  await service.activateProvider(providerId)
  await db.prepare("UPDATE taxonomy_state SET mode = 'shadow'").run()
  const jobId = await service.enqueueSite(1)
  assert.ok(jobId)
  const started = Date.now()
  const result = await processTaxonomyMessage(
    { jobId },
    { ...env, TAXONOMY_QUEUE: mockQueue() },
    {
      leaseSeconds: 31,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
    },
  )
  assert.ok(Date.now() - started < 5_000)
  assert.equal(result.status, 'retry_wait')
  assert.equal(
    await db
      .prepare('SELECT last_error_code FROM taxonomy_jobs WHERE id = ?')
      .bind(jobId)
      .first('last_error_code'),
    'timeout',
  )
})

test('assignment rollback refuses newer provenance and revision without partial writes', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 21_000_000 })
  await db.batch([
    db.prepare(
      `INSERT INTO taxonomy_change_batches
       (id, kind, status, actor_type, expected_taxonomy_version,
        resulting_taxonomy_version, summary, applied_at, completed_at)
       VALUES ('old-add-batch', 'classification', 'applied', 'system', 1, 1,
               'old add', 20999, 20999)`,
    ),
    db.prepare(
      `INSERT INTO site_tags
       (site_id, tag_id, raw_name, source, revision, created_at, updated_at)
       VALUES (1, 1, 'Admin replacement', 'admin', 2, 20998, 20999)`,
    ),
    db
      .prepare(
        `INSERT INTO taxonomy_audit_events
       (id, batch_id, event_type, entity_type, entity_id, actor_type,
        taxonomy_version_before, taxonomy_version_after, scores, evidence,
        before, after, release_sha, created_at)
       VALUES ('old-add-event', 'old-add-batch', 'assignment_add',
               'site_assignment', '1:1', 'system', 1, 1, '{}', '', ?, ?,
               'test', 20997)`,
      )
      .bind(
        JSON.stringify({
          assigned: false,
          tagId: 1,
          tag: { id: 1, status: 'active', revision: 1 },
        }),
        JSON.stringify({
          assigned: true,
          tagId: 1,
          tag: { id: 1, status: 'active', revision: 1 },
          assignment: {
            rawName: 'Tag 1',
            source: 'automation',
            decisionId: null,
            revision: 1,
            createdAt: 20997,
            updatedAt: 20997,
          },
        }),
      ),
  ])
  await assert.rejects(
    service.rollbackEvent('old-add-event', 'admin'),
    /provenance or revision/i,
  )
  assert.deepEqual(
    await db
      .prepare(
        `SELECT raw_name AS rawName, source, revision FROM site_tags
         WHERE site_id = 1 AND tag_id = 1`,
      )
      .first(),
    { rawName: 'Admin replacement', source: 'admin', revision: 2 },
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_change_batches WHERE kind = 'rollback'",
      )
      .first('count(*)'),
    0,
  )
})

test('assignment removal rollback refuses merged, deprecated, or revised tags', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  for (const tagId of [1, 2, 3, 4]) await insertTag(db, tagId)
  for (const tagId of [1, 2, 3]) {
    const batchId = `tag-state-batch-${tagId}`
    const eventId = `tag-state-event-${tagId}`
    const before = JSON.stringify({
      assigned: true,
      tagId,
      tag: { id: tagId, status: 'active', revision: 1 },
      assignment: {
        rawName: `Tag ${tagId}`,
        source: 'automation',
        decisionId: null,
        revision: 1,
        createdAt: 22_050,
        updatedAt: 22_050,
      },
    })
    const after = JSON.stringify({
      assigned: false,
      tagId,
      tag: { id: tagId, status: 'active', revision: 1 },
    })
    await db.batch([
      db
        .prepare(
          `INSERT INTO taxonomy_change_batches
           (id, kind, status, actor_type, expected_taxonomy_version,
            resulting_taxonomy_version, summary, applied_at, completed_at)
           VALUES (?, 'classification', 'applied', 'system', 1, 1, ?, 22050, 22050)`,
        )
        .bind(batchId, `Removed tag ${tagId}`),
      db
        .prepare(
          `INSERT INTO taxonomy_audit_events
           (id, batch_id, event_type, entity_type, entity_id, actor_type,
            taxonomy_version_before, taxonomy_version_after, scores, evidence,
            before, after, release_sha, created_at)
           VALUES (?, ?, 'assignment_remove', 'site_assignment', ?, 'system',
                   1, 1, '{}', '', ?, ?, 'test', 22050)`,
        )
        .bind(eventId, batchId, `1:${tagId}`, before, after),
    ])
  }
  await db.batch([
    db.prepare(
      `UPDATE tags SET status = 'merged', canonical = 0,
       merged_into_tag_id = 4, deprecated_at = 22099 WHERE id = 1`,
    ),
    db.prepare(
      `UPDATE tags SET status = 'deprecated', canonical = 0,
       deprecated_at = 22099 WHERE id = 2`,
    ),
    db.prepare('UPDATE tags SET revision = 2 WHERE id = 3'),
    db.prepare('UPDATE taxonomy_state SET published_version = 2 WHERE id = 1'),
  ])
  const service = new TaxonomyService(serviceEnv(db), { now: () => 22_100_000 })

  for (const tagId of [1, 2, 3]) {
    await assert.rejects(
      service.rollbackEvent(`tag-state-event-${tagId}`, 'admin'),
      /tag status or revision/i,
    )
  }
  assert.equal(
    await db.prepare('SELECT count(*) FROM site_tags').first('count(*)'),
    0,
  )
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) FROM taxonomy_change_batches WHERE kind = 'rollback'",
      )
      .first('count(*)'),
    0,
  )
})

test('assignment removal rollback restores exact automation provenance', async (context) => {
  const db = await migratedTaxonomyDb(context)
  await insertSite(db, 1)
  await insertTag(db, 1)
  const service = new TaxonomyService(serviceEnv(db), { now: () => 22_000_000 })
  await db.batch([
    db
      .prepare(
        `INSERT INTO tag_assignment_decisions
       (id, site_id, tag_id, action, outcome, source, confidence_micros,
        was_assigned, is_assigned, reason, input_hash, taxonomy_version,
        site_content_version, created_at)
       VALUES ('prior-decision', 1, 1, 'add', 'applied', 'provider', 990000,
               0, 1, 'prior assignment', ?, 1, 1, 21000)`,
      )
      .bind(hash),
    db.prepare(
      `INSERT INTO taxonomy_change_batches
       (id, kind, status, actor_type, expected_taxonomy_version,
        resulting_taxonomy_version, summary, applied_at, completed_at)
       VALUES ('remove-batch', 'classification', 'applied', 'system', 1, 1,
               'removed assignment', 21999, 21999)`,
    ),
    db
      .prepare(
        `INSERT INTO taxonomy_audit_events
       (id, batch_id, event_type, entity_type, entity_id, actor_type,
        taxonomy_version_before, taxonomy_version_after, scores, evidence,
        before, after, release_sha, created_at)
       VALUES ('remove-event', 'remove-batch', 'assignment_remove',
               'site_assignment', '1:1', 'system', 1, 1, '{}', '', ?, ?,
               'test', 21999)`,
      )
      .bind(
        JSON.stringify({
          assigned: true,
          tagId: 1,
          tag: { id: 1, status: 'active', revision: 1 },
          assignment: {
            tagId: 1,
            rawName: 'Original machine wording',
            source: 'automation',
            decisionId: 'prior-decision',
            revision: 7,
            createdAt: 111,
            updatedAt: 222,
          },
        }),
        JSON.stringify({
          assigned: false,
          tagId: 1,
          tag: { id: 1, status: 'active', revision: 1 },
        }),
      ),
  ])
  const result = await service.rollbackEvent('remove-event', 'admin')
  assert.equal(result.compensatedEvents, 1)
  assert.deepEqual(
    await db
      .prepare(
        `SELECT raw_name AS rawName, source, decision_id AS decisionId,
                revision, created_at AS createdAt, updated_at AS updatedAt
         FROM site_tags WHERE site_id = 1 AND tag_id = 1`,
      )
      .first(),
    {
      rawName: 'Original machine wording',
      source: 'automation',
      decisionId: 'prior-decision',
      revision: 7,
      createdAt: 111,
      updatedAt: 222,
    },
  )
})
