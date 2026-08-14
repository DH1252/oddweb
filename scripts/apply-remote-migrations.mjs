import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()
const database = 'oddweb'
const pendingOutput = execFileSync(
  'npx',
  ['wrangler', 'd1', 'migrations', 'list', database, '--remote'],
  { cwd: root, encoding: 'utf8' },
)
const pending = [
  ...pendingOutput.matchAll(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/g),
].map((match) => match[0])

if (!pending.length) {
  console.log('No remote D1 migrations are pending.')
  process.exit(0)
}

const workdir = mkdtempSync(resolve(tmpdir(), 'oddweb-remote-migrations-'))
try {
  for (const name of pending) {
    const sourcePath = resolve(root, 'drizzle', name)
    const source = readFileSync(sourcePath, 'utf8').trimEnd()
    const escapedName = name.replaceAll("'", "''")
    const importPath = resolve(workdir, basename(name))
    writeFileSync(
      importPath,
      `${source}\n\nINSERT INTO "d1_migrations" (name) VALUES ('${escapedName}');\n`,
      { mode: 0o600 },
    )
    console.log(`Applying ${name} through transactional D1 file import...`)
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', database, '--remote', '--file', importPath],
      { cwd: root, stdio: 'inherit' },
    )
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

const remaining = execFileSync(
  'npx',
  ['wrangler', 'd1', 'migrations', 'list', database, '--remote'],
  { cwd: root, encoding: 'utf8' },
)
if (/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/.test(remaining)) {
  throw new Error(`Remote D1 migrations remain pending:\n${remaining}`)
}
console.log('Remote D1 migrations applied through transactional file imports.')
