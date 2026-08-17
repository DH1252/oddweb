import assert from 'node:assert/strict'
import test from 'node:test'

import { cachedPublicRead, publicCacheKey } from '../src/server/public-cache'

test('public read cache reuses a matching edge response', async () => {
  const entries = new Map<string, Response>()
  const cache = {
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      entries.set(request.url, response.clone())
    },
  }
  const request = new Request('https://oddweb.page/_serverFn/public')
  let reads = 0
  const input = {
    cache,
    request,
    name: 'directory',
    payload: { page: 0, sort: 'popular' },
    read: async () => ({ sites: ++reads }),
  }

  assert.deepEqual(await cachedPublicRead(input), { sites: 1 })
  assert.deepEqual(await cachedPublicRead(input), { sites: 1 })
  assert.equal(reads, 1)
  assert.equal(entries.size, 1)
})

test('public cache keys isolate endpoint names and payloads', () => {
  const request = new Request('https://oddweb.page/_serverFn/public')
  const directory = publicCacheKey(request, 'directory', { page: 0 })
  const nextDirectory = publicCacheKey(request, 'directory', { page: 1 })
  const popular = publicCacheKey(request, 'popular', { page: 0 })

  assert.notEqual(directory.url, nextDirectory.url)
  assert.notEqual(directory.url, popular.url)
  assert.match(directory.url, /__edge-cache\/public\/directory/)
})
