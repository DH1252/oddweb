import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const required = [
  'STAGING_WORKER_NAME',
  'STAGING_D1_DATABASE_NAME',
  'STAGING_D1_DATABASE_ID',
  'STAGING_R2_BUCKET',
]
const missing = required.filter((name) => !process.env[name])
if (missing.length)
  throw new Error(`Missing staging configuration: ${missing.join(', ')}`)
const forbidden = new Map([
  ['STAGING_WORKER_NAME', 'oddweb'],
  ['STAGING_D1_DATABASE_NAME', 'oddweb'],
  ['STAGING_D1_DATABASE_ID', '061176be-fed4-47e4-ac6f-b985588640e8'],
  ['STAGING_R2_BUCKET', 'oddweb-thumbnails'],
])
for (const [name, productionValue] of forbidden) {
  if (process.env[name] === productionValue) {
    throw new Error(`${name} must not target the production resource.`)
  }
}

const output = resolve('.wrangler/staging.jsonc')
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
        RELEASE_SHA: 'staging-dry-run',
        RELEASE_TIME: 'staging-dry-run',
      },
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
