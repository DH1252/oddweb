import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { readJsonc } from './check-taxonomy-resources.mjs'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim()
run('npm', ['run', 'release:check'])
run('npm', ['run', 'taxonomy:preflight:remote'])
run('npm', ['run', 'verify'])

const backupDirInput = process.env.BACKUP_DIR
if (!backupDirInput || !isAbsolute(backupDirInput)) {
  throw new Error(
    'Set BACKUP_DIR to an absolute directory outside the repository.',
  )
}
mkdirSync(backupDirInput, { recursive: true })
const backupDir = realpathSync(backupDirInput)
const relativeBackup = relative(root, backupDir)
if (
  relativeBackup === '' ||
  (!relativeBackup.startsWith('..') && !isAbsolute(relativeBackup))
) {
  throw new Error('BACKUP_DIR must be outside the repository.')
}

const sha = exec('git', ['rev-parse', 'HEAD'])
const releasedAt = new Date().toISOString()
const timestamp = releasedAt.replaceAll(/[:.]/g, '-')
const tag = `release-${sha.slice(0, 12)}-${timestamp}`
const backupPath = resolve(
  backupDir,
  `oddweb-${timestamp}-${sha.slice(0, 12)}.sql`,
)

run('npx', [
  'wrangler',
  'd1',
  'export',
  'oddweb',
  '--remote',
  '--skip-confirmation',
  '--output',
  backupPath,
])
const backup = readFileSync(backupPath)
if (backup.length === 0) throw new Error(`D1 backup is empty: ${backupPath}`)
const digest = createHash('sha256').update(backup).digest('hex')
writeFileSync(
  `${backupPath}.sha256`,
  `${digest}  ${backupPath.split('/').at(-1)}\n`,
)
writeFileSync(
  `${backupPath}.json`,
  `${JSON.stringify({ database: 'oddweb', releaseSha: sha, releasedAt, sha256: digest }, null, 2)}\n`,
)

const message = `Oddweb ${sha} ${releasedAt}`
const directDeployRequired = Boolean(
  readJsonc(resolve(root, 'wrangler.jsonc')).migrations?.length,
)
const pendingMigrations = exec('npx', [
  'wrangler',
  'd1',
  'migrations',
  'list',
  'oddweb',
  '--remote',
])
const maintenanceRequired = pendingMigrations
  .split('\n')
  .map((line) => line.match(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/)?.[0])
  .filter(Boolean)
  .some((name) =>
    readFileSync(resolve(root, 'drizzle', name), 'utf8').includes(
      'release: maintenance-required',
    ),
  )
const previousVersion = currentVersionId()
if (!directDeployRequired) {
  run('npx', [
    'wrangler',
    'versions',
    'upload',
    '--strict',
    '--tag',
    tag,
    '--message',
    message,
    '--var',
    `ENVIRONMENT:production`,
    '--var',
    `RELEASE_SHA:${sha}`,
    '--var',
    `RELEASE_TIME:${releasedAt}`,
  ])
}
if (maintenanceRequired) {
  deployMaintenance(`${message} maintenance`)
}

try {
  run('npm', ['run', 'db:migrations:remote:check'])
  run('npm', ['run', 'db:migrate:remote'])
} catch (error) {
  if (maintenanceRequired) {
    deployMaintenance(`${message} migration failed; maintenance remains active`)
    console.error(
      `The contract migration failed. Maintenance remains active because the previous application may no longer match the database. Inspect D1 and restore ${backupPath} before redeploying ${previousVersion}.`,
    )
  }
  throw error
}
try {
  if (directDeployRequired) {
    run('npx', [
      'wrangler',
      'deploy',
      '--strict',
      '--message',
      message,
      '--var',
      `ENVIRONMENT:production`,
      '--var',
      `RELEASE_SHA:${sha}`,
      '--var',
      `RELEASE_TIME:${releasedAt}`,
    ])
  } else {
    run('npx', [
      'wrangler',
      'versions',
      'deploy',
      '--version-tag',
      `${tag}@100`,
      '--yes',
      '--message',
      message,
    ])
  }
  run('npx', ['wrangler', 'triggers', 'deploy'])
  run('node', ['scripts/smoke-test.mjs'], { ...process.env, RELEASE_SHA: sha })
} catch (error) {
  if (maintenanceRequired) {
    deployMaintenance(
      `${message} promotion or smoke test failed; maintenance remains active`,
    )
    console.error(
      `The contract migration succeeded but the application failed verification. Maintenance remains active. Restore ${backupPath} before deploying ${previousVersion} if the new application cannot be fixed forward.`,
    )
  } else {
    run('npx', [
      'wrangler',
      'versions',
      'deploy',
      `${previousVersion}@100`,
      '--yes',
      '--message',
      `${message} promotion or smoke test failed; restored previous application`,
    ])
  }
  throw error
}
console.log(`Released ${sha}. Backup: ${backupPath}`)

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, env, stdio: 'inherit' })
}

function exec(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

function currentVersionId() {
  const output = exec('npx', ['wrangler', 'deployments', 'status'])
  const match = output.match(/\(100%\)\s+([0-9a-f-]{36})/i)
  if (!match) throw new Error('Could not determine the current Worker version.')
  return match[1]
}

function deployMaintenance(message) {
  const maintenanceConfig = resolve(root, '.wrangler/maintenance.jsonc')
  writeFileSync(
    maintenanceConfig,
    `${JSON.stringify(
      {
        $schema: 'node_modules/wrangler/config-schema.json',
        name: 'oddweb',
        main: 'scripts/maintenance-worker.mjs',
        compatibility_date: '2026-08-03',
        workers_dev: false,
        routes: [{ pattern: 'oddweb.page', custom_domain: true }],
        vars: {
          ENVIRONMENT: 'production',
          PUBLIC_SITE_URL: 'https://oddweb.page',
        },
      },
      null,
      2,
    )}\n`,
  )
  run('npx', [
    'wrangler',
    'deploy',
    'scripts/maintenance-worker.mjs',
    '--config',
    maintenanceConfig,
    '--message',
    message,
  ])
}
