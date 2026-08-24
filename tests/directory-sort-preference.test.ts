import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  directorySortCookie,
  directorySortMigrationScript,
  readDirectorySortCookie,
} from '../src/lib/directory-sort'

test('directory sort cookie accepts only supported modes', () => {
  assert.deepEqual(
    readDirectorySortCookie(
      '__Host-oddweb-directory-sort=newest; unrelated=value',
    ),
    { status: 'valid', sort: 'newest' },
  )
  assert.deepEqual(readDirectorySortCookie('oddweb-directory-sort=invalid'), {
    status: 'invalid',
    sort: 'popular',
  })
  assert.deepEqual(readDirectorySortCookie(null), {
    status: 'missing',
    sort: 'popular',
  })
  assert.deepEqual(
    readDirectorySortCookie(
      '__Host-oddweb-directory-sort=invalid; oddweb-directory-sort=views',
    ),
    { status: 'invalid', sort: 'popular' },
  )
})

test('directory sort cookie is host-bound on HTTPS', () => {
  assert.equal(
    directorySortCookie('views', true),
    '__Host-oddweb-directory-sort=views; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
  )
  assert.equal(
    directorySortCookie('az', false),
    'oddweb-directory-sort=az; Path=/; Max-Age=31536000; SameSite=Lax',
  )
})

test('legacy migration reloads only after a verified cookie write', () => {
  const script = directorySortMigrationScript()
  assert.match(script, /location\.pathname==='\/'/)
  assert.match(script, /localStorage\.getItem\('oddweb-directory-sort'\)/)
  assert.match(script, /document\.cookie\.split[\s\S]*location\.reload\(\)/)
  assert.doesNotMatch(script, /location\.reload\(\)[\s\S]*document\.cookie/)
})

test('home loader and first render share the cookie-backed sort', async () => {
  const [route, publicData, sortHook] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/server/public-data.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/hooks/use-directory-sort.ts', import.meta.url),
      'utf8',
    ),
  ])

  assert.match(
    publicData,
    /getDirectorySortPreference = createServerFn\(\{[\s\S]*method: 'GET',[\s\S]*readDirectorySortCookie\(getRequest\(\)\.headers\.get\('cookie'\)\)/,
  )
  assert.match(
    route,
    /typeof document === 'undefined'[\s\S]*await getDirectorySortPreference\(\)[\s\S]*readBrowserDirectorySortPreference\(\)/,
  )
  assert.match(
    route,
    /directoryQueryOptions\(\{[\s\S]*sort: preference\.sort,[\s\S]*page: 0/,
  )
  assert.match(
    route,
    /useDirectorySortPreference\([\s\S]*initialDirectory\.preference,[\s\S]*\)/,
  )
  assert.doesNotMatch(
    route.match(
      /loader: async[\s\S]*?return \{ directory, preference \}/,
    )?.[0] ?? '',
    /sort: 'popular'/,
  )
  assert.doesNotMatch(sortHook, /location\.reload/)
  assert.match(
    sortHook,
    /write: \(sort: DirectorySortMode\) => \{[\s\S]*currentSort = sort[\s\S]*persistDirectorySort\(sort\)/,
  )
})
