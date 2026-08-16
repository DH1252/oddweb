import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Release helpers are plain JavaScript so they can run before TypeScript tooling.
const resourceChecks =
  // @ts-expect-error JavaScript release helper intentionally has no declaration file.
  await import('../../scripts/check-taxonomy-resources.mjs')
// @ts-expect-error JavaScript release helper intentionally has no declaration file.
const release = await import('../../scripts/release.mjs')
const migrationSafety =
  // @ts-expect-error JavaScript release helper intentionally has no declaration file.
  await import('../../scripts/release-migration-safety.mjs')
const stagingFirstDeploy =
  // @ts-expect-error JavaScript release helper intentionally has no declaration file.
  await import('../../scripts/staging-first-deploy.mjs')
const queueDeliveryState =
  // @ts-expect-error JavaScript release helper intentionally has no declaration file.
  await import('../../scripts/queue-delivery-state.mjs')

const {
  remoteHandlerValidation,
  remotePreflight,
  remoteResourcePreflight,
  validateTaxonomyConfig,
  validateQueueConsumerSettings,
} = resourceChecks
const {
  buildMaintenanceConfig,
  buildTriggerDeferredConfig,
  buildVerifiedArtifactConfig,
  parsePendingD1Migrations,
  pendingDurableObjectMigrations,
  runRelease,
} = release
const { hasDestructiveSchemaOperation } = migrationSafety
const { parseSecretsFile, runFirstStagingDeploy, validateBootstrapSecrets } =
  stagingFirstDeploy
const { readQueueDeliveryState } = queueDeliveryState

const validPasswordHash = `$pbkdf2-sha256$100000$${Buffer.alloc(16, 1).toString('base64url')}$${Buffer.alloc(32, 2).toString('base64url')}`
const validSessionSecret = 's'.repeat(32)
const validTaxonomyKey = Buffer.alloc(32, 3).toString('base64url')

const expected = { queue: 'test-taxonomy', dlq: 'test-taxonomy-dlq' }

function taxonomyConfig() {
  return {
    name: 'test-worker',
    secrets: { required: ['TAXONOMY_MASTER_KEY_V1'] },
    queues: {
      producers: [{ binding: 'TAXONOMY_QUEUE', queue: expected.queue }],
      consumers: [
        {
          queue: expected.queue,
          dead_letter_queue: expected.dlq,
          max_retries: 5,
        },
      ],
    },
    triggers: { crons: ['*/5 * * * *'] },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'test-db',
        database_id: 'test-db-id',
      },
    ],
    r2_buckets: [{ binding: 'THUMBNAILS', bucket_name: 'test-thumbnails' }],
  }
}

test('taxonomy resource config requires isolated queues, cron, D1, R2, and secret metadata', () => {
  assert.deepEqual(validateTaxonomyConfig(taxonomyConfig(), expected), [])
  const invalid = taxonomyConfig()
  invalid.queues.producers[0].queue = expected.dlq
  invalid.queues.consumers[0].dead_letter_queue = expected.queue
  invalid.triggers.crons = []
  invalid.secrets.required = []
  invalid.d1_databases = []
  invalid.r2_buckets = []
  assert.deepEqual(validateTaxonomyConfig(invalid, expected), [
    'TAXONOMY_QUEUE must produce to the explicit queue test-taxonomy',
    'the taxonomy consumer DLQ must be test-taxonomy-dlq',
    'the taxonomy maintenance cron must run every five minutes',
    'TAXONOMY_MASTER_KEY_V1 must be declared as a required secret',
    'the DB binding must declare a D1 database name and ID',
    'the THUMBNAILS binding must declare an R2 bucket name',
  ])
})

test('remote resource preflight fails clearly when Cloudflare auth is unavailable', () => {
  const result = remoteResourcePreflight(
    'test.jsonc',
    taxonomyConfig(),
    expected,
    () => {
      throw new Error('not authenticated')
    },
  )
  assert.match(result.failures[0], /authentication is unavailable/i)
})

test('staging predeploy validation checks provisioned resources without requiring a Worker', () => {
  const calls: string[][] = []
  const execute = (_command: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'whoami') return 'authenticated'
    if (args[0] === 'queues') return `Queue Name: ${args[2]}`
    if (args[0] === 'd1' && args[1] === 'info') {
      return JSON.stringify({ uuid: 'test-db-id' })
    }
    if (args[0] === 'd1') return JSON.stringify([{ success: true }])
    if (args[0] === 'r2') return 'bucket exists'
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  }

  const result = remoteResourcePreflight(
    'test.jsonc',
    taxonomyConfig(),
    expected,
    execute,
  )
  assert.deepEqual(result, { failures: [], warnings: [] })
  assert.ok(calls.some((args) => args[0] === 'r2'))
  assert.ok(
    calls.some((args) => args.some((value) => value.includes('SELECT 1'))),
  )
  assert.ok(
    calls.every(
      (args) => !['secret', 'deployments', 'versions'].includes(args[0]),
    ),
  )
})

test('postdeploy validation checks consumers, DLQ, secrets, handlers, and bindings', () => {
  const calls: string[][] = []
  const execute = (_command: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'whoami') return 'authenticated'
    if (args[0] === 'queues') {
      return JSON.stringify([
        {
          type: 'worker',
          script: 'test-worker',
          dead_letter_queue: expected.dlq,
          settings: { max_retries: 5 },
        },
      ])
    }
    if (args[0] === 'secret') {
      return JSON.stringify([
        { name: 'TAXONOMY_MASTER_KEY_V1', type: 'secret_text' },
      ])
    }
    if (args[0] === 'deployments') {
      return JSON.stringify({
        versions: [{ version_id: 'version-id', percentage: 100 }],
      })
    }
    if (args[0] === 'versions') {
      return JSON.stringify({
        resources: {
          script: { handlers: ['fetch', 'queue', 'scheduled'] },
          bindings: [
            { name: 'DB', database_id: 'test-db-id', type: 'd1' },
            {
              name: 'TAXONOMY_QUEUE',
              queue_name: expected.queue,
              type: 'queue',
            },
            {
              name: 'THUMBNAILS',
              bucket_name: 'test-thumbnails',
              type: 'r2_bucket',
            },
          ],
        },
      })
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  }

  const result = remoteHandlerValidation(
    'test.jsonc',
    taxonomyConfig(),
    expected,
    execute,
  )
  assert.deepEqual(result.failures, [])
  assert.equal(result.warnings.length, 1)
  assert.ok(
    calls.some(
      (args) =>
        args.slice(0, 5).join(' ') ===
        'queues consumer worker list test-taxonomy',
    ),
  )
  assert.ok(
    calls.every(
      (args) => !args.some((value) => value.includes('secret-value')),
    ),
  )
})

test('postdeploy validation reports an invalid consumer and missing handlers', () => {
  const execute = (_command: string, args: string[]) => {
    if (args[0] === 'whoami') return 'authenticated'
    if (args[0] === 'queues') {
      return JSON.stringify([
        {
          type: 'worker',
          script: 'test-worker',
          dead_letter_queue: 'wrong-dlq',
          settings: { max_retries: 5 },
        },
      ])
    }
    if (args[0] === 'secret') {
      return JSON.stringify([{ name: 'TAXONOMY_MASTER_KEY_V1' }])
    }
    if (args[0] === 'deployments') {
      return JSON.stringify({
        versions: [{ version_id: 'version-id', percentage: 100 }],
      })
    }
    if (args[0] === 'versions') {
      return JSON.stringify({ resources: { script: { handlers: ['fetch'] } } })
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  }

  const result = remoteHandlerValidation(
    'test.jsonc',
    taxonomyConfig(),
    expected,
    execute,
  )
  assert.ok(
    result.failures.some((failure: string) => /does not use DLQ/.test(failure)),
  )
  assert.ok(
    result.failures.some((failure: string) => /queue handler/.test(failure)),
  )
  assert.ok(
    result.failures.some((failure: string) =>
      /scheduled handler/.test(failure),
    ),
  )
})

test('combined production preflight runs both resource and handler validation', () => {
  const calls: string[][] = []
  const execute = (_command: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'whoami') return 'authenticated'
    if (args[0] === 'queues' && args[1] === 'info') return 'queue exists'
    if (args[0] === 'queues') {
      return JSON.stringify([
        {
          type: 'worker',
          script: 'test-worker',
          dead_letter_queue: expected.dlq,
          settings: { max_retries: 5 },
        },
      ])
    }
    if (args[0] === 'd1' && args[1] === 'info') {
      return JSON.stringify({ uuid: 'test-db-id' })
    }
    if (args[0] === 'd1') return JSON.stringify([{ success: true }])
    if (args[0] === 'r2') return 'bucket exists'
    if (args[0] === 'secret') {
      return JSON.stringify([{ name: 'TAXONOMY_MASTER_KEY_V1' }])
    }
    if (args[0] === 'deployments') {
      return JSON.stringify({
        versions: [{ version_id: 'version-id', percentage: 100 }],
      })
    }
    if (args[0] === 'versions') {
      return JSON.stringify({
        resources: {
          script: { handlers: ['fetch', 'queue', 'scheduled'] },
          bindings: [
            { name: 'DB', id: 'test-db-id' },
            { name: 'TAXONOMY_QUEUE', queue: expected.queue },
            { name: 'THUMBNAILS', bucket_name: 'test-thumbnails' },
          ],
        },
      })
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  }

  const result = remotePreflight(
    'test.jsonc',
    taxonomyConfig(),
    expected,
    execute,
  )
  assert.deepEqual(result.failures, [])
  assert.ok(calls.some((args) => args[0] === 'd1'))
  assert.ok(calls.some((args) => args[0] === 'versions'))
})

test('release migration checks recognize SQLite table and column rename syntax', () => {
  assert.equal(
    hasDestructiveSchemaOperation(
      'ALTER TABLE "sites" RENAME TO "directory_sites";',
    ),
    true,
  )
  assert.equal(
    hasDestructiveSchemaOperation(
      'ALTER TABLE sites RENAME COLUMN title TO display_title;',
    ),
    true,
  )
  assert.equal(
    hasDestructiveSchemaOperation(
      'ALTER TABLE sites ADD COLUMN subtitle text;',
    ),
    false,
  )
})

test('pending migration parsers distinguish D1 files and applied lifecycle history', () => {
  assert.deepEqual(
    parsePendingD1Migrations(
      'Migrations to be applied:\n0009_test.sql\n0009_test.sql\n0010_more.sql',
    ),
    ['0009_test.sql', '0010_more.sql'],
  )
  const migrations = [
    { tag: 'v1', new_sqlite_classes: ['One'] },
    { tag: 'v2', new_sqlite_classes: ['Two'] },
  ]
  assert.deepEqual(pendingDurableObjectMigrations(migrations, 'v2'), [])
  assert.deepEqual(pendingDurableObjectMigrations(migrations, 'v1'), [
    migrations[1],
  ])
  assert.throws(
    () => pendingDurableObjectMigrations(migrations, 'unknown'),
    /refusing to guess/,
  )
})

test('generated safety configs clear crons and preserve only applied lifecycle migrations', () => {
  const config = productionConfig(['v1', 'v2'])
  const maintenance = buildMaintenanceConfig(config, 'v1')
  assert.deepEqual(maintenance.triggers.crons, [])
  assert.deepEqual(
    maintenance.migrations.map((migration: { tag: string }) => migration.tag),
    ['v1'],
  )
  assert.deepEqual(maintenance.observability, config.observability)
  const identifiedMaintenance = buildMaintenanceConfig(config, 'v1', {
    releaseSha: '1'.repeat(40),
    releaseTime: '2026-08-16T00:00:00.000Z',
  })
  assert.equal(identifiedMaintenance.vars.RELEASE_SHA, '1'.repeat(40))
  assert.equal(
    identifiedMaintenance.vars.RELEASE_TIME,
    '2026-08-16T00:00:00.000Z',
  )
  assert.equal(identifiedMaintenance.vars.MAINTENANCE_MODE, '1')
  const generated = generatedConfig(config)
  const paths = artifactPaths('/repo/.wrangler/release.jsonc')
  const production = buildVerifiedArtifactConfig(generated, {
    ...paths,
    targetConfigPath: '/repo/.wrangler/production.jsonc',
  })
  const deferred = buildTriggerDeferredConfig(generated, paths)
  assert.deepEqual(deferred.triggers.crons, [])
  assert.equal(production.main, 'release-artifact/server/index.js')
  assert.equal(production.assets.directory, 'release-artifact/client')
  assert.equal(deferred.main, 'release-artifact/server/index.js')
  assert.equal(deferred.assets.directory, 'release-artifact/client')
  assert.equal(deferred.d1_databases[0].migrations_dir, '../drizzle')
  assert.equal(deferred.$schema, '../node_modules/wrangler/config-schema.json')
  assert.equal(Object.hasOwn(deferred, 'configPath'), false)
  assert.equal(Object.hasOwn(deferred, 'userConfigPath'), false)
})

test('queue consumer validation compares every configured delivery setting', () => {
  assert.deepEqual(
    validateQueueConsumerSettings(
      {
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: 5,
        max_concurrency: 2,
        retry_delay: 3,
      },
      {
        settings: {
          batch_size: 10,
          max_wait_time_ms: 5000,
          max_retries: 4,
          max_concurrency: 2,
          retry_delay: 3,
        },
      },
    ),
    ['max_retries is 4, expected 5'],
  )
  assert.deepEqual(
    validateQueueConsumerSettings(
      {},
      { settings: { max_concurrency: 4, retry_delay: 10 } },
    ),
    [
      'max_concurrency is 4, expected automatic/default',
      'retry_delay is 10, expected automatic/default',
    ],
  )
  assert.deepEqual(
    validateQueueConsumerSettings(
      {},
      { settings: { max_concurrency: null, retry_delay: 0 } },
    ),
    [],
  )
})

test('code-only release pauses asynchronous delivery before promotion and skips export', () => {
  const harness = releaseHarness()
  assert.throws(() => harness.execute(), /remains incomplete/)

  assert.equal(harness.has('d1 export'), false)
  assert.ok(harness.has('queues pause-delivery'))
  assert.ok(
    harness.has(
      'wrangler versions upload --config /repo/.wrangler/production.jsonc',
    ),
  )
  assert.ok(
    harness.hasExact(
      'copy /repo/dist/server /repo/.wrangler/release-artifact-abcdef123456-2026-08-15T12-00-00-000Z/server',
    ),
  )
  assert.ok(
    harness.hasExact(
      'copy /repo/dist/client /repo/.wrangler/release-artifact-abcdef123456-2026-08-15T12-00-00-000Z/client',
    ),
  )
  assert.equal(
    harness.has('wrangler deploy --config /repo/.wrangler/release.jsonc'),
    false,
  )
  assertOrder(harness.events, [
    'npm run release:check',
    'npm run verify',
    'npm run release:check',
    'wrangler d1 migrations list oddweb --remote',
    'wrangler deploy --config /repo/.wrangler/production.jsonc --dry-run',
    'npm run release:check',
    'wrangler versions upload --config /repo/.wrangler/production.jsonc',
    'queues pause-delivery oddweb-taxonomy',
    'wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
    'smoke-test.mjs --application-only',
    'wrangler triggers deploy --config /repo/.wrangler/production.jsonc',
    'check-taxonomy-resources.mjs --remote-handlers',
    'smoke-test.mjs --triggers-only --read-only-triggers',
  ])
  assert.equal(harness.readOnlyTriggerQueueState(), 'paused')
  const recovery = harness.writtenJson('.recovery.json')
  assert.equal(recovery.strategy, 'worker-rollback-and-d1-time-travel')
  assert.equal(recovery.timeTravelBookmark, 'bookmark-before-release')
  assert.deepEqual(
    recovery.phaseHistory.map((entry: { phase: string }) => entry.phase),
    [
      'prepared',
      'application_staged',
      'async_triggers_paused',
      'recovery_point_created',
      'migrations_not_required',
      'application_promoted',
      'application_verified',
      'triggers_restored',
      'queue_left_paused',
      'incomplete_queue_paused',
    ],
  )
})

test('an initially paused queue is never paused or resumed by release', () => {
  const harness = releaseHarness({ initialQueueDeliveryState: 'paused' })
  assert.throws(() => harness.execute(), /remains incomplete/)
  assert.equal(harness.has('queues pause-delivery'), false)
  assert.equal(harness.has('queues resume-delivery'), false)
  const recovery = harness.writtenJson('.recovery.json')
  assert.equal(recovery.initialQueueDeliveryState, 'paused')
  assert.ok(
    recovery.phaseHistory.some(
      (entry: { phase: string }) => entry.phase === 'incomplete_queue_paused',
    ),
  )
})

test('release derives queue state remotely instead of trusting operator input', () => {
  const harness = releaseHarness({ initialQueueDeliveryState: 'running' })
  assert.throws(
    () => harness.execute({ RELEASE_TAXONOMY_QUEUE_INITIAL_STATE: 'paused' }),
    /remains incomplete/,
  )
  assert.ok(harness.has('scripts/queue-delivery-state.mjs'))
  assert.ok(harness.has('queues pause-delivery'))
})

test('release never automatically resumes queue delivery', () => {
  const harness = releaseHarness({
    queueModifiedStates: ['1', '1', '1', '2', '2', '3'],
  })
  assert.throws(() => harness.execute(), /remains incomplete/)
  assert.equal(harness.has('queues resume-delivery'), false)
})

test('verified artifact drift aborts before the first remote mutation', () => {
  const harness = releaseHarness({ artifactDigests: ['verified', 'changed'] })
  assert.throws(() => harness.execute(), /artifact changed/)
  assert.equal(harness.has('wrangler versions upload'), false)
  assert.equal(harness.has('queues pause-delivery'), false)
})

test('concurrent release lease blocks remote mutations', () => {
  const harness = releaseHarness({ loseReleaseLeaseAtRenewal: 1 })
  assert.throws(() => harness.execute(), /release lease ownership/)
  assert.equal(harness.has('wrangler versions upload'), false)
  assert.equal(harness.has('queues pause-delivery'), false)
})

test('stale rollback is fenced after release lease ownership changes', () => {
  const harness = releaseHarness({
    failRun: (label) => label.includes('smoke-test.mjs --application-only'),
    stealLeaseOnRunFailure: true,
  })
  assert.throws(
    () => harness.execute(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.ok(
        error.errors.some((entry) =>
          String(entry).includes('release lease ownership'),
        ),
      )
      return true
    },
  )
  assert.equal(harness.has('versions deploy previous-version@100'), false)
})

test('lease ownership is checked after every child command', () => {
  const harness = releaseHarness({
    stealLeaseAfterRun: (label) => label.includes('wrangler versions upload'),
  })
  assert.throws(() => harness.execute(), /release lease ownership/)
  assert.equal(harness.has('queues pause-delivery'), false)
})

test('operational artifact drift blocks maintenance deployment and export', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    artifactDigests: ['verified', 'verified', 'verified', 'changed'],
  })
  assert.throws(() => harness.execute(), /artifact changed/)
  assert.ok(harness.has('queues pause-delivery'))
  assert.equal(harness.maintenanceDeployCount(), 0)
  assert.equal(harness.has('d1 export'), false)
})

test('unreconstructable prior routes and crons abort before mutation', () => {
  const harness = releaseHarness({ previousReleaseSha: null })
  assert.throws(() => harness.execute(), /cannot be reconstructed safely/)
  assert.equal(harness.has('wrangler versions upload'), false)
  assert.equal(harness.has('queues pause-delivery'), false)
})

test('a fix-forward release recognizes an active maintenance Worker', () => {
  const harness = releaseHarness({
    previousMaintenanceActive: true,
    initialQueueDeliveryState: 'paused',
  })
  assert.throws(() => harness.execute(), /remains incomplete/)

  assert.ok(
    harness.has('wrangler deploy --config /repo/.wrangler/maintenance.jsonc'),
  )
  assertOrder(harness.events, [
    "VALUES ('release:maintenance', '1')",
    'smoke-test.mjs --application-only',
    "DELETE FROM app_state WHERE key = 'release:maintenance'",
  ])
  assert.equal(harness.has('queues resume-delivery'), false)
})

test('pending D1 migration enters maintenance before export and restores async work last', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    migrationSources: {
      '0009_test.sql':
        '-- release: maintenance-required\nALTER TABLE sites RENAME TO sites_old;',
    },
  })
  assert.throws(() => harness.execute(), /remains incomplete/)

  assertOrder(harness.events, [
    'queues pause-delivery oddweb-taxonomy',
    'wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
    'wrangler deploy --config /repo/.wrangler/maintenance.jsonc',
    "VALUES ('release:maintenance', '1')",
    'wrangler d1 execute oddweb --config /repo/.wrangler/production.jsonc --remote --json --command SELECT',
    'wrangler d1 export oddweb',
    'npm run db:migrate:remote',
    'smoke-test.mjs --application-only',
    "DELETE FROM app_state WHERE key = 'release:maintenance'",
    'wrangler triggers deploy --config /repo/.wrangler/production.jsonc',
    'check-taxonomy-resources.mjs --remote-handlers',
    'smoke-test.mjs --triggers-only --read-only-triggers',
  ])
  const recovery = harness.writtenJson('.sql.json')
  assert.equal(recovery.strategy, 'd1-export-and-time-travel')
  assert.deepEqual(recovery.contractMigrations, ['0009_test.sql'])
  assert.equal(recovery.maintenanceBarrier, false)
  assert.equal(recovery.releaseDrain.consecutiveZero, 3)
})

test('migration release requires the active invocation fence protocol', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    previousReleaseFenceVersion: null,
  })
  assert.throws(() => harness.execute(), /release fence version 1/)
  assert.equal(harness.has('wrangler versions upload'), false)
  assert.equal(harness.has('queues pause-delivery'), false)
})

test('migration release waits for active taxonomy leases before export', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    leaseCounts: [
      { leasedJobs: 1, leasedOutbox: 1 },
      { leasedJobs: 0, leasedOutbox: 0 },
    ],
  })
  assert.throws(() => harness.execute(), /remains incomplete/)
  assert.equal(harness.count('leased_jobs'), 4)
  const recovery = harness.writtenJson('.sql.json')
  assert.deepEqual(recovery.releaseDrain, {
    activeInvocations: 0,
    activeLeasedJobs: 0,
    expiredLeasedJobs: 0,
    activeLeasedOutbox: 0,
    expiredLeasedOutbox: 0,
    latestExpiredLease: 0,
    observedAt: 1000,
    attempts: 4,
    consecutiveZero: 3,
  })
  assert.ok(
    harness.events.some(
      (event) =>
        event.label.includes("status = 'leased'") &&
        event.label.includes('lease_token IS NOT NULL'),
    ),
  )
})

test('migration drain requires sustained zero including active invocations', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    leaseCounts: [
      { leasedJobs: 0, leasedOutbox: 0, activeInvocations: 0 },
      { leasedJobs: 0, leasedOutbox: 0, activeInvocations: 1 },
      { leasedJobs: 0, leasedOutbox: 0, activeInvocations: 0 },
    ],
  })
  assert.throws(() => harness.execute(), /remains incomplete/)
  const recovery = harness.writtenJson('.sql.json')
  assert.equal(recovery.releaseDrain.attempts, 5)
  assert.equal(recovery.releaseDrain.consecutiveZero, 3)
})

test('migration drain waits through the execution window of expired leases', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    expiredLeaseCounts: [
      { jobs: 1, outbox: 1, latest: 900, observedAt: 1000 },
      { jobs: 1, outbox: 1, latest: 900, observedAt: 2100 },
      { jobs: 1, outbox: 1, latest: 900, observedAt: 2101 },
    ],
  })
  assert.throws(() => harness.execute(), /remains incomplete/)
  const recovery = harness.writtenJson('.sql.json')
  assert.equal(recovery.releaseDrain.attempts, 4)
  assert.equal(recovery.releaseDrain.expiredLeasedJobs, 1)
})

test('migration release fails closed when any lease remains', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    leaseCounts: [{ leasedJobs: 1, leasedOutbox: 1 }],
  })
  assert.throws(() => harness.execute(), /did not sustain a drain/)
  assert.equal(harness.count('active_leased_jobs'), 253)
  assert.equal(harness.has('d1 export'), false)
  assert.equal(harness.has('db:migrate:remote'), false)
  assert.equal(harness.has('queues resume-delivery'), false)
})

test('a genuinely pending Durable Object migration uses trigger-deferred direct deploy', () => {
  const harness = releaseHarness({
    config: productionConfig(['v1', 'v2']),
    activeMigrationTag: 'v1',
  })
  assert.throws(() => harness.execute(), /remains incomplete/)

  assert.equal(harness.has('wrangler versions upload'), false)
  assert.equal(harness.has('d1 export'), false)
  assertOrder(harness.events, [
    'wrangler deploy --config /repo/.wrangler/release.jsonc --dry-run',
    'npm run release:check',
    'queues pause-delivery oddweb-taxonomy',
    'wrangler deploy --config /repo/.wrangler/maintenance.jsonc',
    'wrangler deploy --config /repo/.wrangler/release.jsonc',
    'smoke-test.mjs --application-only',
    'wrangler triggers deploy --config /repo/.wrangler/production.jsonc',
    'check-taxonomy-resources.mjs --remote-handlers',
    'smoke-test.mjs --triggers-only --read-only-triggers',
  ])
  const deferred = harness.writtenJson('/repo/.wrangler/release.jsonc')
  assert.deepEqual(deferred.triggers.crons, [])
  assert.equal(
    deferred.main,
    'release-artifact-abcdef123456-2026-08-15T12-00-00-000Z/server/index.js',
  )
  assert.equal(
    deferred.assets.directory,
    'release-artifact-abcdef123456-2026-08-15T12-00-00-000Z/client',
  )
  assert.equal(deferred.d1_databases[0].migrations_dir, '../drizzle')
  assert.equal(deferred.$schema, '../node_modules/wrangler/config-schema.json')
})

test('final trigger reconciliation removes a consumer from the previous queue', () => {
  const previousConfig = productionConfig(['v1'])
  previousConfig.queues.producers[0].queue = 'oddweb-taxonomy-old'
  previousConfig.queues.consumers[0].queue = 'oddweb-taxonomy-old'
  const harness = releaseHarness({ previousConfig })
  assert.throws(() => harness.execute(), /remains incomplete/)
  assert.ok(
    harness.has('queues consumer worker remove oddweb-taxonomy-old oddweb'),
  )
})

test('failed lifecycle direct deploy re-reads the active migration tag before maintenance', () => {
  const harness = releaseHarness({
    config: productionConfig(['v1', 'v2']),
    activeMigrationTags: ['v1', 'v2'],
    failRun: (label) =>
      label.includes(
        'wrangler deploy --config /repo/.wrangler/release.jsonc',
      ) && !label.includes('--dry-run'),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.equal(
    harness.count('wrangler versions view previous-version --json'),
    2,
  )
  assert.equal(harness.count('queues pause-delivery oddweb-taxonomy'), 1)
  assert.equal(harness.maintenanceDeployCount(), 2)
  const maintenance = harness.writtenJson(
    '/repo/.wrangler/maintenance-v2.jsonc',
  )
  assert.deepEqual(
    maintenance.migrations.map((migration: { tag: string }) => migration.tag),
    ['v1', 'v2'],
  )
})

test('maintenance activation stops after a failed cron clear and leaves delivery paused', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    failRun: (label) =>
      label ===
      'npx wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.ok(harness.has('queues pause-delivery oddweb-taxonomy'))
  assert.equal(harness.maintenanceDeployCount(), 0)
  assert.equal(harness.has('d1 export'), false)
  assert.ok(
    harness.errors.some((message) =>
      /pause or cron clearing failed/.test(message),
    ),
  )
})

test('maintenance recovery-point failure does not resume queue delivery', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    failOutput: (label) => label.includes('d1 time-travel info'),
  })
  assert.throws(() => harness.execute(), /simulated output failure/)
  assert.ok(
    harness.has('wrangler deploy --config /repo/.wrangler/maintenance.jsonc'),
  )
  assert.equal(harness.has('queues resume-delivery'), false)
  assert.ok(
    harness.errors.some((message) =>
      /Recovery preparation failed/.test(message),
    ),
  )
})

test('database migration failure leaves the deployed maintenance Worker active', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    failRun: (label) => label === 'npm run db:migrate:remote',
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.equal(harness.maintenanceDeployCount(), 1)
  assert.equal(harness.has('smoke-test.mjs --application-only'), false)
  assert.equal(harness.has('queues resume-delivery'), false)
  assert.ok(harness.errors.some((message) => /migration failed/.test(message)))
})

test('code-only application smoke failure restores the prior version before trigger changes', () => {
  const harness = releaseHarness({
    failRun: (label) => label.includes('smoke-test.mjs --application-only'),
    liveConsumers: [
      deployedConsumer('oddweb', {
        queue: 'oddweb-taxonomy',
        dead_letter_queue: 'oddweb-taxonomy-live-dlq',
        max_batch_size: 4,
        max_batch_timeout: 8,
        max_retries: 7,
        max_concurrency: 3,
        retry_delay: 11,
      }),
    ],
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.ok(harness.has('wrangler versions deploy previous-version@100'))
  assert.ok(
    harness.has(
      'wrangler triggers deploy --config /repo/.wrangler/previous-triggers.jsonc',
    ),
  )
  assert.ok(harness.has('queues pause-delivery'))
  assert.equal(harness.has('queues resume-delivery'), false)
  const restored = harness.writtenJson(
    '/repo/.wrangler/previous-triggers.jsonc',
  )
  assert.deepEqual(restored.queues.consumers, [
    {
      queue: 'oddweb-taxonomy',
      dead_letter_queue: 'oddweb-taxonomy-live-dlq',
      max_batch_size: 4,
      max_batch_timeout: 8,
      max_retries: 7,
      max_concurrency: 3,
      retry_delay: 11,
    },
  ])
})

test('code-only recovery preserves an initially paused queue', () => {
  const harness = releaseHarness({
    initialQueueDeliveryState: 'paused',
    failRun: (label) => label.includes('smoke-test.mjs --application-only'),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.ok(harness.has('wrangler versions deploy previous-version@100'))
  assert.equal(harness.has('queues resume-delivery'), false)
})

test('code-only trigger smoke failure holds delivery and crons without claiming rollback', () => {
  const harness = releaseHarness({
    failRun: (label) => label.includes('smoke-test.mjs --triggers-only'),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assertOrder(harness.events, [
    'wrangler triggers deploy --config /repo/.wrangler/production.jsonc',
    'smoke-test.mjs --triggers-only --read-only-triggers',
    'wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
  ])
  assert.equal(harness.has('versions deploy previous-version@100'), false)
  assert.ok(harness.errors.some((message) => /explicit recovery/.test(message)))
})

test('partial trigger deployment failure uses the same safe code-only containment', () => {
  const harness = releaseHarness({
    failRun: (label) =>
      label ===
      'npx wrangler triggers deploy --config /repo/.wrangler/production.jsonc',
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.ok(harness.has('queues pause-delivery oddweb-taxonomy'))
  assert.ok(
    harness.has(
      'wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
    ),
  )
  assert.equal(harness.has('versions deploy previous-version@100'), false)
})

test('postdeploy handler validation failure uses trigger-gate containment', () => {
  const harness = releaseHarness({
    failRun: (label) =>
      label.includes('check-taxonomy-resources.mjs --remote-handlers'),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.ok(harness.has('queues pause-delivery oddweb-taxonomy'))
  assert.ok(
    harness.has(
      'wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
    ),
  )
  assert.equal(harness.has('versions deploy previous-version@100'), false)
})

test('maintenance application smoke failure reasserts paused fetch-only maintenance', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    failRun: (label) => label.includes('smoke-test.mjs --application-only'),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.equal(harness.count('queues pause-delivery oddweb-taxonomy'), 1)
  assert.equal(harness.maintenanceDeployCount(), 2)
  assert.equal(
    harness.has(
      'wrangler triggers deploy --config /repo/.wrangler/production.jsonc',
    ),
    false,
  )
})

test('maintenance trigger failure pauses delivery again and redeploys maintenance', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    failRun: (label) => label.includes('smoke-test.mjs --triggers-only'),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assertOrder(harness.events, [
    'smoke-test.mjs --triggers-only --read-only-triggers',
    'wrangler triggers deploy --config /repo/.wrangler/maintenance.jsonc',
    "VALUES ('release:maintenance', '1')",
    'wrangler deploy --config /repo/.wrangler/maintenance.jsonc',
  ])
  assert.equal(harness.maintenanceDeployCount(), 2)
})

test('maintenance containment keeps the already paused queue fail closed', () => {
  const harness = releaseHarness({
    pendingD1: ['0009_test.sql'],
    failRun: (label, occurrence) =>
      label.includes('smoke-test.mjs --triggers-only') ||
      (label === 'npx wrangler queues pause-delivery oddweb-taxonomy' &&
        occurrence === 2),
  })
  assert.throws(() => harness.execute(), /simulated command failure/)
  assert.equal(harness.count('queues pause-delivery oddweb-taxonomy'), 1)
  assert.equal(harness.maintenanceDeployCount(), 2)
})

test('staging scripts and documentation cover first-deploy queue and secret bootstrap', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  const stagingEnv = readFileSync(
    new URL('../../staging.env.example', import.meta.url),
    'utf8',
  )
  const readme = readFileSync(
    new URL('../../README.md', import.meta.url),
    'utf8',
  )
  const stagingConfig = readFileSync(
    new URL('../../scripts/staging-config.mjs', import.meta.url),
    'utf8',
  )
  const firstDeploy = readFileSync(
    new URL('../../scripts/staging-first-deploy.mjs', import.meta.url),
    'utf8',
  )
  assert.match(packageJson.scripts['staging:preflight'], /--remote-resources/)
  assert.match(packageJson.scripts['staging:postdeploy'], /--remote-handlers/)
  assert.match(
    packageJson.scripts['taxonomy:preflight:remote'],
    /--remote-resources/,
  )
  assert.match(packageJson.scripts['taxonomy:postdeploy'], /--remote-handlers/)
  assert.match(stagingEnv, /^STAGING_TAXONOMY_QUEUE=/m)
  assert.match(stagingEnv, /^STAGING_TAXONOMY_DLQ=/m)
  assert.match(stagingEnv, /^STAGING_SECRETS_FILE=\/absolute\//m)
  assert.match(readme, /wrangler queues create oddweb-staging-taxonomy/)
  assert.match(readme, /--secrets-file/)
  assert.match(readme, /npm run staging:deploy:first/)
  assert.match(
    packageJson.scripts['staging:deploy:first'],
    /staging-first-deploy/,
  )
  assert.match(firstDeploy, /'--secrets-file'/)
  assert.match(firstDeploy, /'--dry-run'/)
  assert.match(firstDeploy, /status.*--porcelain/s)
  assert.doesNotMatch(stagingConfig, /staging-dry-run/)
  assert.match(stagingConfig, /git', \['rev-parse', 'HEAD'\]/)
})

test('staging secret parser requires all bootstrap keys', () => {
  assert.deepEqual(
    parseSecretsFile(
      'ADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH="hash"\nADMIN_SESSION_SECRET=secret\nTAXONOMY_MASTER_KEY_V1=key\n',
      'secrets.env',
    ),
    {
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD_HASH: 'hash',
      ADMIN_SESSION_SECRET: 'secret',
      TAXONOMY_MASTER_KEY_V1: 'key',
    },
  )
})

test('staging bootstrap validates runtime-compatible secret formats', () => {
  const valid = `ADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH=${validPasswordHash}\nADMIN_SESSION_SECRET=${validSessionSecret}\nTAXONOMY_MASTER_KEY_V1=${validTaxonomyKey}\n`
  assert.equal(validateBootstrapSecrets(valid).ADMIN_USERNAME, 'admin')
  for (const [name, value, pattern] of [
    ['ADMIN_PASSWORD_HASH', '$pbkdf2-sha256$99999$bad$bad', /100000/],
    ['ADMIN_SESSION_SECRET', 'short', /32 characters/],
    [
      'TAXONOMY_MASTER_KEY_V1',
      Buffer.alloc(31).toString('base64url'),
      /32 bytes/,
    ],
  ] as const) {
    assert.throws(
      () =>
        validateBootstrapSecrets(
          valid.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`),
        ),
      pattern,
    )
  }
})

test('queue state helper reads the authoritative API field and fails closed', async () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'token',
  }
  let calls = 0
  const request = async () => {
    calls += 1
    return new Response(
      JSON.stringify(
        calls === 1
          ? { success: true, result: [{ queue_name: 'queue', queue_id: 'id' }] }
          : {
              success: true,
              result: {
                modified_on: '2026-08-16T00:00:00Z',
                settings: { delivery_paused: true },
              },
            },
      ),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  assert.deepEqual(await readQueueDeliveryState('queue', env, request), {
    state: 'paused',
    modifiedOn: '2026-08-16T00:00:00Z',
  })
  await assert.rejects(
    readQueueDeliveryState('queue', {}, request),
    /ACCOUNT_ID.*API_TOKEN/,
  )
})

test('queue state helper requires an operator state when the API omits optional state fields', async () => {
  let calls = 0
  const request = async () => {
    calls += 1
    return new Response(
      JSON.stringify({
        success: true,
        result:
          calls % 2 === 1
            ? [{ queue_name: 'queue', queue_id: 'id' }]
            : { queue_name: 'queue', queue_id: 'id', settings: {} },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'token',
    RELEASE_TAXONOMY_QUEUE_INITIAL_STATE: 'running',
  }
  assert.deepEqual(await readQueueDeliveryState('queue', env, request), {
    state: 'running',
    modifiedOn: null,
    source: 'operator',
  })
  await assert.rejects(
    readQueueDeliveryState(
      'queue',
      {
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_API_TOKEN: 'token',
      },
      request,
    ),
    /RELEASE_TAXONOMY_QUEUE_INITIAL_STATE/,
  )
})

test('first staging deploy validates and dry-runs before applying migrations', () => {
  const harness = stagingHarness()
  harness.execute()
  assertOrder(harness.events, [
    'read /secure/staging.env',
    'npm run staging:verify',
    'git status --porcelain',
    'wrangler deploy --config /repo/.wrangler/staging.jsonc --strict --secrets-file /secure/staging.env --dry-run',
    'wrangler d1 migrations list oddweb-staging --remote',
    'git status --porcelain',
    'wrangler d1 migrations apply oddweb-staging --remote',
    'git status --porcelain',
    'wrangler deploy --config /repo/.wrangler/staging.jsonc --strict --secrets-file /secure/staging.env',
  ])
})

test('first staging deploy rejects missing secrets before any command', () => {
  const harness = stagingHarness({
    secrets: 'ADMIN_USERNAME=admin\n',
  })
  assert.throws(() => harness.execute(), /missing required keys/)
  assert.equal(
    harness.events.some((event) => event.kind === 'run'),
    false,
  )
})

test('first staging deploy rejects artifact drift before migration apply', () => {
  const harness = stagingHarness({ artifactDigests: ['verified', 'changed'] })
  assert.throws(() => harness.execute(), /changed before remote mutation/)
  assert.ok(harness.has('wrangler d1 migrations list oddweb-staging'))
  assert.equal(
    harness.has('wrangler d1 migrations apply oddweb-staging'),
    false,
  )
})

test('first staging deploy refuses an existing deployment before migrations', () => {
  const harness = stagingHarness({ existingDeployment: true })
  assert.throws(() => harness.execute(), /already has a deployment/)
  assert.equal(harness.has('d1 migrations list'), false)
  assert.equal(harness.has('d1 migrations apply'), false)
})

test('first staging deploy refuses an existing queue consumer before migrations', () => {
  const harness = stagingHarness({ existingConsumer: true })
  assert.throws(() => harness.execute(), /already has consumer/)
  assert.equal(harness.has('d1 migrations list'), false)
  assert.equal(harness.has('d1 migrations apply'), false)
})

interface ReleaseHarnessOptions {
  pendingD1?: string[]
  activeMigrationTag?: string
  activeMigrationTags?: string[]
  config?: ReturnType<typeof productionConfig>
  previousConfig?: ReturnType<typeof productionConfig>
  migrationSources?: Record<string, string>
  artifactDigests?: string[]
  leaseCounts?: Array<{
    leasedJobs: number
    leasedOutbox: number
    activeInvocations?: number
  }>
  initialQueueDeliveryState?: 'running' | 'paused'
  queueStates?: Array<'running' | 'paused'>
  queueModifiedStates?: string[]
  loseReleaseLeaseAtRenewal?: number
  stealLeaseOnRunFailure?: boolean
  stealLeaseAfterRun?: (label: string) => boolean
  expiredLeaseCounts?: Array<{
    jobs: number
    outbox: number
    latest: number
    observedAt: number
  }>
  previousReleaseSha?: string | null
  previousMaintenanceActive?: boolean
  previousReleaseFenceVersion?: string | null
  liveConsumers?: Array<ReturnType<typeof deployedConsumer>>
  failRun?: (label: string, occurrence: number) => boolean
  failOutput?: (label: string, occurrence: number) => boolean
}

interface HarnessEvent {
  kind: 'run' | 'output' | 'write' | 'copy'
  label: string
}

function releaseHarness(options: ReleaseHarnessOptions = {}) {
  const events: HarnessEvent[] = []
  const writes = new Map<string, string | Uint8Array>()
  const errors: string[] = []
  let readOnlyTriggerQueueState: string | undefined
  const occurrences = new Map<string, number>()
  const config = options.config ?? productionConfig(['v1'])
  const previousConfig = options.previousConfig ?? productionConfig(['v1'])
  const activeMigrationTags = options.activeMigrationTags ?? [
    options.activeMigrationTag ?? 'v1',
  ]
  const pendingD1 = options.pendingD1 ?? []
  const migrationSources = options.migrationSources ?? {}
  const artifactDigests = options.artifactDigests ?? ['verified-artifact']
  let hashCall = 0
  const leaseCounts = options.leaseCounts ?? [
    { leasedJobs: 0, leasedOutbox: 0 },
  ]
  let leaseCall = 0
  let releaseOwner = ''
  let releaseLeaseRenewals = 0
  const queueStates = options.queueStates
  let queueState = options.initialQueueDeliveryState ?? 'running'
  let queueModified = 1
  let queueStateCall = 0
  const initialConsumers =
    options.liveConsumers ??
    previousConfig.queues.consumers.map((consumer) =>
      deployedConsumer(previousConfig.name, consumer),
    )
  const remoteConsumers = new Map<string, typeof initialConsumers>()
  for (const consumer of initialConsumers) {
    const queue = consumer.queue_name
    remoteConsumers.set(queue, [
      ...(remoteConsumers.get(queue) ?? []),
      consumer,
    ])
  }

  function record(kind: HarnessEvent['kind'], label: string) {
    events.push({ kind, label })
    const occurrence = (occurrences.get(label) ?? 0) + 1
    occurrences.set(label, occurrence)
    return occurrence
  }

  const io = {
    run(command: string, args: string[], env?: Record<string, string>) {
      const label = [command, ...args].join(' ')
      if (
        label.includes('smoke-test.mjs --triggers-only --read-only-triggers')
      ) {
        readOnlyTriggerQueueState = env?.RELEASE_TAXONOMY_QUEUE_INITIAL_STATE
      }
      const occurrence = record('run', label)
      if (options.failRun?.(label, occurrence)) {
        if (options.stealLeaseOnRunFailure) releaseOwner = 'newer-release'
        throw new Error(`simulated command failure: ${label}`)
      }
      if (label.includes('wrangler queues pause-delivery')) {
        queueState = 'paused'
        queueModified += 1
      }
      if (label.includes('wrangler queues resume-delivery')) {
        queueState = 'running'
        queueModified += 1
      }
      if (options.stealLeaseAfterRun?.(label)) releaseOwner = 'newer-release'
      if (
        command === 'npx' &&
        args.slice(0, 5).join(' ') === 'wrangler queues consumer worker remove'
      ) {
        const queue = args[5]
        const worker = args[6]
        remoteConsumers.set(
          queue,
          (remoteConsumers.get(queue) ?? []).filter(
            (consumer) => consumer.script !== worker,
          ),
        )
      }
      if (
        command === 'npx' &&
        args[0] === 'wrangler' &&
        args[1] === 'triggers' &&
        args[2] === 'deploy' &&
        !args.includes('--dry-run')
      ) {
        const configIndex = args.indexOf('--config')
        const targetPath =
          configIndex === -1 ? undefined : args[configIndex + 1]
        const target = targetPath ? writes.get(targetPath) : undefined
        if (target) {
          const triggerConfig = JSON.parse(String(target))
          for (const consumer of triggerConfig.queues?.consumers ?? []) {
            remoteConsumers.set(consumer.queue, [
              deployedConsumer(triggerConfig.name, consumer),
            ])
          }
        }
      }
    },
    output(command: string, args: string[]) {
      const label = [command, ...args].join(' ')
      const occurrence = record('output', label)
      if (options.failOutput?.(label, occurrence)) {
        throw new Error(`simulated output failure: ${label}`)
      }
      if (label === 'git rev-parse HEAD') return 'abcdef1234567890'
      if (label.includes('scripts/queue-delivery-state.mjs')) {
        const stateIndex = queueStateCall
        const state = queueStates
          ? queueStates[Math.min(stateIndex, queueStates.length - 1)]
          : queueState
        queueStateCall += 1
        const modifiedOn = options.queueModifiedStates
          ? options.queueModifiedStates[
              Math.min(stateIndex, options.queueModifiedStates.length - 1)
            ]
          : String(queueModified)
        return JSON.stringify({ state, modifiedOn })
      }
      if (
        label.includes(
          'git show 1111111111111111111111111111111111111111:wrangler.jsonc',
        )
      ) {
        return JSON.stringify(previousConfig)
      }
      if (label.includes('wrangler d1 migrations list oddweb --remote')) {
        return pendingD1.join('\n')
      }
      if (label.includes('wrangler deployments status --json')) {
        return JSON.stringify({
          versions: [{ version_id: 'previous-version', percentage: 100 }],
        })
      }
      if (label.includes('wrangler versions view previous-version --json')) {
        const migrationTag =
          activeMigrationTags[
            Math.min(occurrence - 1, activeMigrationTags.length - 1)
          ]
        return JSON.stringify({
          resources: {
            script_runtime: { migration_tag: migrationTag },
            bindings: [
              {
                name: 'RELEASE_SHA',
                type: 'plain_text',
                text:
                  options.previousReleaseSha === undefined
                    ? '1111111111111111111111111111111111111111'
                    : options.previousReleaseSha,
              },
              {
                name: 'TAXONOMY_QUEUE',
                type: 'queue',
                queue_name: previousConfig.queues.producers[0].queue,
              },
              ...((
                options.previousReleaseFenceVersion === undefined
                  ? '1'
                  : options.previousReleaseFenceVersion
              )
                ? [
                    {
                      name: 'RELEASE_FENCE_VERSION',
                      type: 'plain_text',
                      text:
                        options.previousReleaseFenceVersion === undefined
                          ? '1'
                          : options.previousReleaseFenceVersion,
                    },
                  ]
                : []),
              ...(options.previousMaintenanceActive
                ? [
                    {
                      name: 'MAINTENANCE_MODE',
                      type: 'plain_text',
                      text: '1',
                    },
                  ]
                : []),
            ],
          },
        })
      }
      if (label.includes('wrangler queues consumer worker list')) {
        const queue = args[5]
        return JSON.stringify(remoteConsumers.get(queue) ?? [])
      }
      if (
        label.includes('wrangler d1 execute oddweb') &&
        label.includes('active_invocations')
      ) {
        const counts = leaseCounts[Math.min(leaseCall, leaseCounts.length - 1)]
        const expired =
          options.expiredLeaseCounts?.[
            Math.min(leaseCall, options.expiredLeaseCounts.length - 1)
          ]
        leaseCall += 1
        return JSON.stringify([
          {
            success: true,
            results: [
              {
                active_invocations: counts.activeInvocations ?? 0,
                active_leased_jobs: counts.leasedJobs,
                expired_leased_jobs: expired?.jobs ?? 0,
                active_leased_outbox: counts.leasedOutbox,
                expired_leased_outbox: expired?.outbox ?? 0,
                latest_expired_lease: expired?.latest ?? 0,
                observed_at: expired?.observedAt ?? 1000,
              },
            ],
          },
        ])
      }
      if (
        label.includes('wrangler d1 execute oddweb') &&
        label.includes("VALUES ('release:lease'")
      ) {
        const owner = label.match(/'owner', '([^']+)'/)?.[1] ?? 'release-owner'
        if (!releaseOwner) releaseOwner = owner
        return JSON.stringify([
          { success: true, results: [] },
          {
            success: true,
            results: [
              {
                value: JSON.stringify({
                  owner: releaseOwner,
                  acquiredAt: 1,
                  expiresAt: 9999999999,
                }),
              },
            ],
          },
        ])
      }
      if (
        label.includes('wrangler d1 execute oddweb') &&
        label.includes("json_set(value, '$.expiresAt'")
      ) {
        releaseLeaseRenewals += 1
        if (releaseLeaseRenewals === options.loseReleaseLeaseAtRenewal) {
          releaseOwner = 'newer-release'
        }
        return JSON.stringify([
          { success: true, results: [] },
          {
            success: true,
            results: [
              {
                value: JSON.stringify({
                  owner: releaseOwner,
                  acquiredAt: 1,
                  expiresAt: 9999999999,
                }),
              },
            ],
          },
        ])
      }
      if (
        label.includes('wrangler d1 execute oddweb') &&
        label.includes('DELETE FROM app_state') &&
        label.includes("key = 'release:lease'")
      ) {
        releaseOwner = ''
        return JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [{ count: 0 }] },
        ])
      }
      if (
        label.includes('wrangler d1 execute oddweb') &&
        label.includes("VALUES ('release:maintenance', '1')")
      ) {
        return JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [{ value: '1' }] },
        ])
      }
      if (
        label.includes('wrangler d1 execute oddweb') &&
        label.includes(
          "DELETE FROM app_state WHERE key = 'release:maintenance'",
        )
      ) {
        return JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [{ count: 0 }] },
        ])
      }
      if (label.includes('wrangler d1 time-travel info oddweb --json')) {
        return JSON.stringify({ bookmark: 'bookmark-before-release' })
      }
      throw new Error(`Unexpected output command: ${label}`)
    },
    mkdir() {},
    copy(source: string, target: string) {
      record('copy', `copy ${source} ${target}`)
    },
    realpath(path: string) {
      return path
    },
    read(path: string, encoding?: BufferEncoding) {
      if (path === '/repo/dist/server/wrangler.json') {
        return JSON.stringify(generatedConfig(config))
      }
      if (path.startsWith('/repo/drizzle/')) {
        const name = path.split('/').at(-1) ?? ''
        return migrationSources[name] ?? '-- additive migration'
      }
      if (path.startsWith('/backups/')) {
        return encoding ? 'database backup' : Buffer.from('database backup')
      }
      throw new Error(`Unexpected read: ${path}`)
    },
    write(path: string, value: string | Uint8Array) {
      record('write', path)
      writes.set(path, value)
    },
    writeAtomic(path: string, value: string | Uint8Array) {
      record('write', path)
      writes.set(path, value)
    },
    hash() {
      const value =
        artifactDigests[Math.min(hashCall, artifactDigests.length - 1)]
      hashCall += 1
      return value
    },
    sleep() {},
    log() {},
    error(message: string) {
      errors.push(message)
    },
  }

  return {
    events,
    errors,
    readOnlyTriggerQueueState: () => readOnlyTriggerQueueState,
    execute(envOverrides: Record<string, string> = {}) {
      return runRelease({
        root: '/repo',
        env: {
          BACKUP_DIR: '/backups',
          CLOUDFLARE_ACCOUNT_ID: 'account',
          CLOUDFLARE_API_TOKEN: 'token',
          ...envOverrides,
        },
        config,
        now: () => new Date('2026-08-15T12:00:00.000Z'),
        io,
      })
    },
    has(fragment: string) {
      return events.some((event) => event.label.includes(fragment))
    },
    hasExact(label: string) {
      return events.some((event) => event.label === label)
    },
    count(fragment: string) {
      return events.filter((event) => event.label.includes(fragment)).length
    },
    maintenanceDeployCount() {
      return events.filter(
        (event) =>
          event.kind === 'run' &&
          event.label.includes(
            'wrangler deploy --config /repo/.wrangler/maintenance',
          ) &&
          !event.label.includes('--dry-run'),
      ).length
    },
    writtenJson(pathFragment: string) {
      const entry = [...writes].find(([path]) => path.includes(pathFragment))
      assert.ok(entry, `Expected a write containing ${pathFragment}`)
      return JSON.parse(String(entry[1]))
    },
  }
}

interface StagingHarnessOptions {
  secrets?: string
  artifactDigests?: string[]
  existingDeployment?: boolean
  existingConsumer?: boolean
}

function stagingHarness(options: StagingHarnessOptions = {}) {
  const events: HarnessEvent[] = []
  const digests = options.artifactDigests ?? ['verified']
  let hashCall = 0
  const secrets =
    options.secrets ??
    `ADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH=${validPasswordHash}\nADMIN_SESSION_SECRET=${validSessionSecret}\nTAXONOMY_MASTER_KEY_V1=${validTaxonomyKey}\n`
  const config = {
    name: 'oddweb-staging',
    vars: { RELEASE_SHA: 'abcdef1234567890' },
    d1_databases: [{ binding: 'DB', database_name: 'oddweb-staging' }],
    queues: { consumers: [{ queue: 'oddweb-staging-taxonomy' }] },
  }
  const io = {
    run(command: string, args: string[]) {
      events.push({ kind: 'run' as const, label: [command, ...args].join(' ') })
    },
    output(command: string, args: string[]) {
      const label = [command, ...args].join(' ')
      events.push({ kind: 'output' as const, label })
      if (label === 'git status --porcelain') return ''
      if (label.includes('wrangler deployments status --json')) {
        if (options.existingDeployment) {
          return JSON.stringify({ versions: [{ version_id: 'existing' }] })
        }
        throw new Error('Worker not found')
      }
      if (label.includes('wrangler queues consumer worker list')) {
        return JSON.stringify(
          options.existingConsumer
            ? [{ type: 'worker', script: 'oddweb-staging' }]
            : [],
        )
      }
      throw new Error(`Unexpected output: ${label}`)
    },
    read(path: string) {
      events.push({ kind: 'output' as const, label: `read ${path}` })
      if (path === '/secure/staging.env') return secrets
      if (path === '/repo/.wrangler/staging.jsonc') {
        return JSON.stringify(config)
      }
      throw new Error(`Unexpected read: ${path}`)
    },
    realpath(path: string) {
      return path
    },
    stat() {
      return { isFile: () => true, mode: 0o100600 }
    },
    hash() {
      const digest = digests[Math.min(hashCall, digests.length - 1)]
      hashCall += 1
      return digest
    },
  }
  return {
    events,
    execute() {
      return runFirstStagingDeploy({
        root: '/repo',
        env: { STAGING_SECRETS_FILE: '/secure/staging.env' },
        io,
      })
    },
    has(fragment: string) {
      return events.some((event) => event.label.includes(fragment))
    },
  }
}

function productionConfig(tags: string[]) {
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'oddweb',
    main: 'src/server.ts',
    compatibility_date: '2026-08-03',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: 'oddweb.page', custom_domain: true }],
    vars: {
      ENVIRONMENT: 'production',
      PUBLIC_SITE_URL: 'https://oddweb.page',
    },
    secrets: { required: ['TAXONOMY_MASTER_KEY_V1'] },
    queues: {
      producers: [{ binding: 'TAXONOMY_QUEUE', queue: 'oddweb-taxonomy' }],
      consumers: [
        {
          queue: 'oddweb-taxonomy',
          dead_letter_queue: 'oddweb-taxonomy-dlq',
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
        },
      ],
    },
    triggers: { crons: ['*/5 * * * *'] },
    durable_objects: {
      bindings: [{ name: 'REALTIME_HUB', class_name: 'RealtimeHub' }],
    },
    migrations: tags.map((tag, index) => ({
      tag,
      new_sqlite_classes: [`RealtimeHub${index + 1}`],
    })),
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'oddweb',
        database_id: 'database-id',
        migrations_dir: 'drizzle',
      },
    ],
    r2_buckets: [{ binding: 'THUMBNAILS', bucket_name: 'oddweb-thumbnails' }],
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.1 },
    },
  }
}

function generatedConfig(config: ReturnType<typeof productionConfig>) {
  const generated = structuredClone(config)
  return {
    ...generated,
    configPath: '/repo/wrangler.jsonc',
    userConfigPath: '/repo/wrangler.jsonc',
    topLevelName: config.name,
    definedEnvironments: [],
    main: 'index.js',
    assets: { directory: '../client' },
    d1_databases: generated.d1_databases.map((binding) => ({
      ...binding,
      migrations_dir: '../../drizzle',
    })),
  }
}

function artifactPaths(targetConfigPath: string) {
  return {
    sourceConfigPath: '/repo/dist/server/wrangler.json',
    targetConfigPath,
    mappings: [
      {
        from: '/repo/dist/server',
        to: '/repo/.wrangler/release-artifact/server',
      },
      {
        from: '/repo/dist/client',
        to: '/repo/.wrangler/release-artifact/client',
      },
    ],
  }
}

function deployedConsumer(
  worker: string,
  consumer: {
    queue: string
    dead_letter_queue?: string
    max_batch_size?: number
    max_batch_timeout?: number
    max_retries?: number
    max_concurrency?: number
    retry_delay?: number
  },
) {
  return {
    type: 'worker',
    script: worker,
    queue_name: consumer.queue,
    dead_letter_queue: consumer.dead_letter_queue,
    settings: {
      ...(consumer.max_batch_size === undefined
        ? {}
        : { batch_size: consumer.max_batch_size }),
      ...(consumer.max_batch_timeout === undefined
        ? {}
        : { max_wait_time_ms: consumer.max_batch_timeout * 1000 }),
      ...(consumer.max_retries === undefined
        ? {}
        : { max_retries: consumer.max_retries }),
      ...(consumer.max_concurrency === undefined
        ? {}
        : { max_concurrency: consumer.max_concurrency }),
      ...(consumer.retry_delay === undefined
        ? {}
        : { retry_delay: consumer.retry_delay }),
    },
  }
}

function assertOrder(events: HarnessEvent[], fragments: string[]) {
  let position = -1
  for (const fragment of fragments) {
    const next = events.findIndex(
      (event, index) => index > position && event.label.includes(fragment),
    )
    assert.ok(next > position, `Expected ${fragment} after event ${position}`)
    position = next
  }
}
