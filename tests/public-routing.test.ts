import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { QueryClient, QueryObserver, queryOptions } from '@tanstack/react-query'

import {
  normalizePublicFilterSearch,
  publicFilterLoaderDeps,
} from '../src/data/tags'

test('filtered route loader dependencies preserve the exact validated query', async () => {
  const validated = normalizePublicFilterSearch({
    include: [' Listen ', '~Browser   Toy', 'listen'],
    exclude: ['LISTEN', ' Calm '],
  })
  const deps = publicFilterLoaderDeps(validated)

  assert.deepEqual(validated, {
    include: ['listen', '~browser toy'],
    exclude: ['calm'],
  })
  assert.deepEqual(deps, {
    include: ['listen', '~browser toy'],
    exclude: ['calm'],
  })
  assert.strictEqual(deps.include, validated.include)
  assert.strictEqual(deps.exclude, validated.exclude)

  const [directory, tags] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/tags.tsx', import.meta.url), 'utf8'),
  ])
  for (const source of [directory, tags]) {
    assert.match(
      source,
      /loaderDeps: \(\{ search \}\) => publicFilterLoaderDeps\(search\)/,
    )
    assert.match(source, /include: deps\.include/)
    assert.match(source, /exclude: deps\.exclude/)
  }
})

test('detail navigation fetches an invalidated cached null before deciding 404', async () => {
  type Detail = { name: string }
  const queryClient = new QueryClient()
  let current: Detail | null = null
  let fetches = 0
  const options = queryOptions({
    queryKey: ['site', 'new-site'],
    queryFn: async () => {
      fetches += 1
      return current
    },
    staleTime: 30_000,
  })

  assert.equal(await queryClient.fetchQuery(options), null)
  current = { name: 'New site' }
  await queryClient.invalidateQueries({
    queryKey: options.queryKey,
    refetchType: 'none',
  })

  assert.deepEqual(await queryClient.fetchQuery(options), current)
  assert.equal(fetches, 2)

  const source = await readFile(
    new URL('../src/routes/sites.$slug.tsx', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /Promise\.allSettled\(\[[\s\S]*fetchQuery\(siteDetailQueryOptions[\s\S]*fetchQuery\(myVotesQueryOptions/,
  )
  assert.match(
    source,
    /const data = detailResult\.value[\s\S]*if \(!data\) throw notFound[\s\S]*voterStateResult\.status === 'rejected'/,
  )
})

test('an active detail observer receives invalidated query data', async () => {
  type Detail = { name: string }
  const queryClient = new QueryClient()
  let current: Detail = { name: 'Before' }
  const options = queryOptions({
    queryKey: ['site', 'observed-site'],
    queryFn: async () => current,
    staleTime: 30_000,
  })
  await queryClient.fetchQuery(options)

  const observer = new QueryObserver(queryClient, options)
  const observed: string[] = []
  const unsubscribe = observer.subscribe((result) => {
    if (result.data) observed.push(result.data.name)
  })

  current = { name: 'After' }
  await queryClient.invalidateQueries({ queryKey: options.queryKey })

  assert.equal(observer.getCurrentResult().data?.name, 'After')
  assert.ok(observed.includes('After'))
  unsubscribe()

  const source = await readFile(
    new URL('../src/routes/sites.$slug.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /useSuspenseQuery\(siteDetailQueryOptions\(slug\)\)/)
})

test('realtime directory refresh invalidates query data without reloading routes', async () => {
  const source = await readFile(
    new URL('../src/components/realtime-sync.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    source,
    /await Promise\.all\([\s\S]*queryClient\.invalidateQueries/,
  )
  const resync = source.match(
    /const resync = async \(\) => \{[\s\S]*?\n {4}\}/,
  )?.[0]
  assert.ok(resync)
  assert.equal(resync.match(/refetchType: 'none'/g)?.length, 3)
  assert.equal(resync.match(/refetchQueries/g)?.length, 1)
  assert.match(source, /const refreshSiteView = async[\s\S]*await Promise\.all/)
  assert.doesNotMatch(source, /useRouter|router\.invalidate/)
  assert.match(source, /await refreshSiteView\(event\.slug\)/)
})

test('public route loaders fetch invalidated inactive query data', async () => {
  const queryClient = new QueryClient()
  let current = 'Before'
  const options = queryOptions({
    queryKey: ['oddweb', 'public', 'directory', { page: 0 }],
    queryFn: async () => current,
    staleTime: 30_000,
  })

  assert.equal(await queryClient.fetchQuery(options), 'Before')
  current = 'After'
  await queryClient.invalidateQueries({
    queryKey: ['oddweb', 'public'],
    refetchType: 'none',
  })
  assert.equal(await queryClient.fetchQuery(options), 'After')

  const [directory, tags] = await Promise.all([
    readFile(new URL('../src/routes/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/tags.tsx', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(directory, /ensureQueryData/)
  assert.doesNotMatch(tags, /ensureQueryData/)
  assert.match(directory, /queryClient\.fetchQuery/)
  assert.match(tags, /queryClient\.fetchQuery/)
})
