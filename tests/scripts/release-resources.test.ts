import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The release helper is plain JavaScript so it can run before TypeScript tooling.
const { remotePreflight, validateTaxonomyConfig } =
  // @ts-expect-error JavaScript release helper intentionally has no declaration file.
  await import('../../scripts/check-taxonomy-resources.mjs')

const expected = { queue: 'test-taxonomy', dlq: 'test-taxonomy-dlq' }

function config() {
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
  }
}

test('taxonomy resource config requires isolated queues, cron, D1, and secret metadata', () => {
  assert.deepEqual(validateTaxonomyConfig(config(), expected), [])
  const invalid = config()
  invalid.queues.producers[0].queue = expected.dlq
  invalid.queues.consumers[0].dead_letter_queue = expected.queue
  invalid.triggers.crons = []
  invalid.secrets.required = []
  invalid.d1_databases = []
  assert.deepEqual(validateTaxonomyConfig(invalid, expected), [
    'TAXONOMY_QUEUE must produce to the explicit queue test-taxonomy',
    'the taxonomy consumer DLQ must be test-taxonomy-dlq',
    'the taxonomy maintenance cron must run every five minutes',
    'TAXONOMY_MASTER_KEY_V1 must be declared as a required secret',
    'the DB binding must declare a D1 database name and ID',
  ])
})

test('remote taxonomy preflight fails clearly when Cloudflare auth is unavailable', () => {
  const result = remotePreflight('test.jsonc', config(), expected, () => {
    throw new Error('not authenticated')
  })
  assert.match(result.failures[0], /authentication is unavailable/i)
})

test('remote taxonomy preflight validates deployed resources without secret values', () => {
  const calls: string[][] = []
  const execute = (_command: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'whoami') return 'authenticated'
    if (args[0] === 'queues') {
      return args[2] === expected.queue
        ? `Queue: ${expected.queue}\nConsumer: test-worker\nDead letter queue: ${expected.dlq}`
        : `Queue: ${expected.dlq}`
    }
    if (args[0] === 'd1' && args[1] === 'info') {
      return JSON.stringify({ uuid: 'test-db-id' })
    }
    if (args[0] === 'd1') return JSON.stringify([{ success: true }])
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
            { name: 'DB', id: 'test-db-id', type: 'd1' },
            {
              name: 'TAXONOMY_QUEUE',
              queue_name: expected.queue,
              type: 'queue',
            },
          ],
        },
      })
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  }
  const result = remotePreflight('test.jsonc', config(), expected, execute)
  assert.deepEqual(result.failures, [])
  assert.equal(result.warnings.length, 1)
  assert.ok(
    calls.some((args) => args.some((value) => value.includes('SELECT 1'))),
  )
  assert.ok(
    calls.every(
      (args) => !args.some((value) => value.includes('secret-value')),
    ),
  )
})

test('production release runs remote taxonomy preflight before upload', () => {
  const release = readFileSync(
    new URL('../../scripts/release.mjs', import.meta.url),
    'utf8',
  )
  const preflight = release.indexOf("['run', 'taxonomy:preflight:remote']")
  const upload = release.indexOf("'upload'")
  assert.ok(preflight >= 0)
  assert.ok(upload > preflight)
  assert.doesNotMatch(
    release.slice(0, upload),
    /queues', 'create|secret', 'put/,
  )
})
