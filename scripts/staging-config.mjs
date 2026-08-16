import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const required = [
  'STAGING_WORKER_NAME',
  'STAGING_D1_DATABASE_NAME',
  'STAGING_D1_DATABASE_ID',
  'STAGING_R2_BUCKET',
  'STAGING_TAXONOMY_QUEUE',
  'STAGING_TAXONOMY_DLQ',
  'STAGING_URL',
]
const missing = required.filter((name) => !process.env[name])
if (missing.length)
  throw new Error(`Missing staging configuration: ${missing.join(', ')}`)
const forbidden = new Map([
  ['STAGING_WORKER_NAME', 'oddweb'],
  ['STAGING_D1_DATABASE_NAME', 'oddweb'],
  ['STAGING_D1_DATABASE_ID', '061176be-fed4-47e4-ac6f-b985588640e8'],
  ['STAGING_R2_BUCKET', 'oddweb-thumbnails'],
  ['STAGING_TAXONOMY_QUEUE', 'oddweb-taxonomy'],
  ['STAGING_TAXONOMY_DLQ', 'oddweb-taxonomy-dlq'],
])
for (const [name, productionValue] of forbidden) {
  if (process.env[name] === productionValue) {
    throw new Error(`${name} must not target the production resource.`)
  }
}
if (process.env.STAGING_TAXONOMY_QUEUE === process.env.STAGING_TAXONOMY_DLQ) {
  throw new Error('The staging taxonomy queue and DLQ must be distinct.')
}
if (
  !process.env.STAGING_TAXONOMY_QUEUE.startsWith(
    `${process.env.STAGING_WORKER_NAME}-`,
  ) ||
  !process.env.STAGING_TAXONOMY_DLQ.startsWith(
    `${process.env.STAGING_WORKER_NAME}-`,
  )
) {
  throw new Error(
    'Staging taxonomy queue names must be prefixed with STAGING_WORKER_NAME.',
  )
}
const stagingUrl = new URL(process.env.STAGING_URL)
if (
  stagingUrl.protocol !== 'https:' ||
  stagingUrl.origin === 'https://oddweb.page'
) {
  throw new Error('STAGING_URL must be an isolated HTTPS staging origin.')
}

const output = resolve('.wrangler/staging.jsonc')
const releaseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const releaseTime = new Date().toISOString()
mkdirSync(resolve('.wrangler'), { recursive: true })
writeFileSync(
  output,
  `${JSON.stringify(
    {
      $schema: '../node_modules/wrangler/config-schema.json',
      name: process.env.STAGING_WORKER_NAME,
      main: '../dist/server/index.js',
      no_bundle: true,
      rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
      compatibility_date: '2026-08-03',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: true,
      preview_urls: false,
      upload_source_maps: true,
      assets: { directory: '../dist/client' },
      vars: {
        ENVIRONMENT: 'staging',
        PUBLIC_SITE_URL: stagingUrl.origin,
        RELEASE_SHA: releaseSha,
        RELEASE_TIME: releaseTime,
      },
      secrets: {
        required: [
          'ADMIN_USERNAME',
          'ADMIN_PASSWORD_HASH',
          'ADMIN_SESSION_SECRET',
          'TAXONOMY_MASTER_KEY_V1',
        ],
      },
      queues: {
        producers: [
          {
            binding: 'TAXONOMY_QUEUE',
            queue: process.env.STAGING_TAXONOMY_QUEUE,
          },
        ],
        consumers: [
          {
            queue: process.env.STAGING_TAXONOMY_QUEUE,
            max_batch_size: 10,
            max_batch_timeout: 5,
            max_retries: 5,
            dead_letter_queue: process.env.STAGING_TAXONOMY_DLQ,
          },
        ],
      },
      triggers: { crons: ['*/5 * * * *'] },
      durable_objects: {
        bindings: [{ name: 'REALTIME_HUB', class_name: 'RealtimeHub' }],
      },
      migrations: [
        { tag: 'v1-realtime-hub', new_sqlite_classes: ['RealtimeHub'] },
      ],
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          head_sampling_rate: 1,
          invocation_logs: true,
          persist: true,
        },
        traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
      },
      r2_buckets: [
        { binding: 'THUMBNAILS', bucket_name: process.env.STAGING_R2_BUCKET },
      ],
      d1_databases: [
        {
          binding: 'DB',
          database_name: process.env.STAGING_D1_DATABASE_NAME,
          database_id: process.env.STAGING_D1_DATABASE_ID,
          migrations_dir: '../drizzle',
        },
      ],
    },
    null,
    2,
  )}\n`,
)
console.log(`Wrote ${output} from explicit staging resource settings.`)
