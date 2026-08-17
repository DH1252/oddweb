import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  productionTaxonomyResources,
  readJsonc,
  validateTaxonomyConfig,
} from './check-taxonomy-resources.mjs'
import { hasDestructiveSchemaOperation } from './release-migration-safety.mjs'

const localOnly = process.argv.includes('--local')
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
)
const packageLock = JSON.parse(
  readFileSync(resolve(root, 'package-lock.json'), 'utf8'),
)
const failures = []
const wranglerConfig = readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8')
const parsedWranglerConfig = readJsonc(resolve(root, 'wrangler.jsonc'))

failures.push(
  ...validateTaxonomyConfig(parsedWranglerConfig, productionTaxonomyResources),
)
if (parsedWranglerConfig.main !== 'src/server.ts') {
  failures.push(
    'production Worker main must use the custom src/server.ts entry',
  )
}
const realtimeBinding = parsedWranglerConfig.durable_objects?.bindings?.find(
  (binding) => binding.name === 'REALTIME_HUB',
)
if (realtimeBinding?.class_name !== 'RealtimeHub') {
  failures.push('production Worker must bind REALTIME_HUB to RealtimeHub')
}
if (
  !parsedWranglerConfig.migrations?.some(
    (migration) =>
      migration.tag === 'v1-realtime-hub' &&
      migration.new_sqlite_classes?.includes('RealtimeHub'),
  )
) {
  failures.push(
    'production Worker must declare the RealtimeHub SQLite migration',
  )
}

if (!wranglerConfig.includes('"PUBLIC_SITE_URL": "https://oddweb.page"')) {
  failures.push('production PUBLIC_SITE_URL must be https://oddweb.page')
}
if (
  JSON.stringify(parsedWranglerConfig.routes) !==
  JSON.stringify([{ pattern: 'oddweb.page', custom_domain: true }])
) {
  failures.push(
    'production routes must contain only the oddweb.page custom domain',
  )
}
if (parsedWranglerConfig.workers_dev !== false) {
  failures.push('production workers_dev must be disabled')
}
const serverEntry = readFileSync(resolve(root, 'src/server.ts'), 'utf8')
if (!serverEntry.includes("export { RealtimeHub } from './realtime/hub'")) {
  failures.push('src/server.ts must export RealtimeHub')
}
for (const handler of ['processTaxonomyMessage', 'runTaxonomyMaintenance']) {
  if (!serverEntry.includes(handler)) {
    failures.push(`src/server.ts must wire ${handler}`)
  }
}

if (packageJson.packageManager !== 'npm@11.9.0') {
  failures.push('packageManager must remain pinned to npm@11.9.0')
}
const npmVersion = exec('npm', ['--version'])
if (npmVersion !== '11.9.0') {
  failures.push(`npm 11.9.0 is required; found ${npmVersion}`)
}
if (packageLock.packages?.['']?.engines?.node !== packageJson.engines.node) {
  failures.push('package-lock.json release tool metadata is out of sync')
}

const nodeVersion = process.versions.node.split('.').map(Number)
if (nodeVersion[0] !== 24 || nodeVersion[1] < 14) {
  failures.push(
    `Node 24.14.x or newer Node 24 is required; found ${process.versions.node}`,
  )
}

const journal = JSON.parse(
  readFileSync(resolve(root, 'drizzle/meta/_journal.json'), 'utf8'),
)
const journalMigrations = new Set(
  journal.entries.map((entry) => `${entry.tag}.sql`),
)
const latestJournalIndex = Math.max(
  ...journal.entries.map((entry) => entry.idx),
)
if (
  !readdirSync(resolve(root, 'drizzle/meta')).includes(
    `${String(latestJournalIndex).padStart(4, '0')}_snapshot.json`,
  )
) {
  failures.push(`Drizzle snapshot ${latestJournalIndex} is missing`)
}
const sqlMigrations = readdirSync(resolve(root, 'drizzle')).filter((name) =>
  /^\d{4}_.+\.sql$/.test(name),
)
for (const name of sqlMigrations) {
  if (!journalMigrations.has(name))
    failures.push(`${name} is missing from the Drizzle journal`)
  const sql = readFileSync(resolve(root, 'drizzle', name), 'utf8')
  if (
    hasDestructiveSchemaOperation(sql) &&
    !sql.includes('release: maintenance-required')
  ) {
    failures.push(
      `${name} contains a destructive schema operation; split it into an expand/migrate/contract release`,
    )
  }
}
for (const name of journalMigrations) {
  if (!sqlMigrations.includes(name))
    failures.push(`${name} is journaled but missing`)
}

if (!localOnly) {
  const status = exec('git', ['status', '--porcelain'])
  if (status)
    failures.push(
      'the release worktree must be clean, including untracked files',
    )

  const upstream = tryExec('git', [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ])
  if (!upstream) {
    failures.push('the release branch must have an upstream remote')
  } else if (
    exec('git', ['rev-parse', 'HEAD']) !==
    exec('git', ['rev-parse', '@{upstream}'])
  ) {
    failures.push(
      `HEAD must exactly match ${upstream}; push the reviewed release commit first`,
    )
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log(
  `Release checks passed (${localOnly ? 'local' : 'clean and remotely backed up'} source).`,
)

function exec(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

function tryExec(command, args) {
  try {
    return exec(command, args)
  } catch {
    return ''
  }
}
