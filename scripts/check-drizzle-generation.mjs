import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), 'oddweb-drizzle-check-'))
const output = resolve(temporaryRoot, 'drizzle')

try {
  cpSync(resolve(root, 'drizzle'), output, { recursive: true })
  const journal = JSON.parse(
    readFileSync(resolve(root, 'drizzle/meta/_journal.json'), 'utf8'),
  )
  const missingSnapshots = journal.entries
    .map((entry) => entry.tag)
    .filter((tag) => {
      const match = /^(\d+)_/.exec(tag)
      return (
        !match ||
        !existsSync(resolve(root, `drizzle/meta/${match[1]}_snapshot.json`))
      )
    })
  if (missingSnapshots.length) {
    throw new Error(
      `Drizzle metadata is incomplete; missing snapshots for ${missingSnapshots.join(', ')}`,
    )
  }
  execFileSync(
    'npx',
    [
      'drizzle-kit',
      'generate',
      '--dialect',
      'sqlite',
      '--schema',
      resolve(root, 'src/db/schema.ts'),
      '--out',
      output,
      '--name',
      'generation_check',
    ],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  )
  const unexpected = readdirSync(output).filter((name) =>
    /generation_check\.sql$/.test(name),
  )
  if (unexpected.length) {
    throw new Error(
      `Drizzle metadata is stale; generation produced ${unexpected.join(', ')}`,
    )
  }
  console.log('Drizzle generation metadata is current.')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
