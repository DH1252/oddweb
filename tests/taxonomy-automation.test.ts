import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dispatchTaxonomyOutbox,
  processTaxonomyMessage,
  rolloutSelected,
  runTaxonomyMaintenance,
  TaxonomyRepository,
  TaxonomyService,
} from '../src/taxonomy'
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
      `UPDATE taxonomy_policy_configs SET shadow_minimum_samples = 1,
       shadow_minimum_coverage_basis_points = 1,
       shadow_schema_success_basis_points = 1,
       shadow_provider_agreement_basis_points = 1 WHERE id = 1`,
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
               'settled', 1, 4000, 4000, 4000, 4000)`,
    )
    .bind(hash, providerId)
    .run()
  await db
    .prepare(
      `INSERT INTO taxonomy_job_attempts
       (id, job_id, attempt_number, provider_config_id, status, provider_model,
        request_hash, input_tokens, output_tokens, started_at, completed_at)
       VALUES ('ready-attempt', 'ready-job', 1, ?, 'succeeded', 'model', ?, 1, 1, 4000, 4000)`,
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
  await db.prepare("UPDATE taxonomy_state SET mode = 'autonomous'").run()
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
        `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
         VALUES (?, 1, 'Tag 1', 'automation')`,
      )
      .bind(siteId)
      .run()
  }
  await db
    .prepare(
      `INSERT INTO site_tags (site_id, tag_id, raw_name, source)
       VALUES (2, 2, 'Tag 2', 'automation')`,
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
    await db
      .prepare(
        `INSERT INTO taxonomy_audit_events
         (id, batch_id, event_type, entity_type, entity_id, actor_type,
          taxonomy_version_before, taxonomy_version_after, scores, evidence,
          before, after, release_sha, created_at)
         VALUES (?, ?, 'assignment_add', 'site_assignment', ?, 'system',
                 1, 1, '{}', 'test', '{"assigned":false}',
                 '{"assigned":true}', 'test', 6999)`,
      )
      .bind(id, batchId, `${siteId}:${id === 'site-two' ? 2 : 1}`)
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
  await service.createLock({
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
