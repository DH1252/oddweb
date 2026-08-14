import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const password = 'correct horse battery staple'
const pattern = /^\$pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/

test('admin password hashes stay within the Workers PBKDF2 limit', () => {
  const encoded = execFileSync('node', ['scripts/hash-admin-password.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    input: password,
  }).trim()
  const match = pattern.exec(encoded)
  assert.ok(match)
  assert.equal(Number(match[1]), 100_000)

  const actual = Buffer.from(match[3], 'base64url')
  const expected = pbkdf2Sync(
    password,
    Buffer.from(match[2], 'base64url'),
    100_000,
    32,
    'sha256',
  )
  assert.deepEqual(actual, expected)
})

test('runtime rejects hashes that exceed the Workers PBKDF2 limit', async () => {
  const source = await readFile(
    new URL('../src/server/auth.server.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /const passwordHashIterations = 100_000/)
  assert.match(source, /iterations !== passwordHashIterations/)
})
