import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INDEXNOW_DEFAULT_KEY,
  formatIndexNowPayload,
  resolveIndexNowKey,
  submitIndexNowUrls,
} from '../src/lib/indexnow'

test('resolveIndexNowKey returns configured key when valid and defaults safely', () => {
  assert.equal(resolveIndexNowKey('custom-key-12345678'), 'custom-key-12345678')
  assert.equal(resolveIndexNowKey(''), INDEXNOW_DEFAULT_KEY)
  assert.equal(resolveIndexNowKey(undefined), INDEXNOW_DEFAULT_KEY)
  assert.equal(resolveIndexNowKey(123), INDEXNOW_DEFAULT_KEY)
})

test('formatIndexNowPayload constructs a valid IndexNow JSON payload', () => {
  const payload = formatIndexNowPayload({
    host: 'oddweb.page',
    key: 'testkey123',
    urlList: ['https://oddweb.page/', 'https://oddweb.page/sites/radio-garden'],
  })

  assert.equal(payload.host, 'oddweb.page')
  assert.equal(payload.key, 'testkey123')
  assert.equal(payload.keyLocation, 'https://oddweb.page/testkey123.txt')
  assert.deepEqual(payload.urlList, [
    'https://oddweb.page/',
    'https://oddweb.page/sites/radio-garden',
  ])
})

test('submitIndexNowUrls sends a POST request with formatted payload to api.indexnow.org', async () => {
  let requestedUrl = ''
  let requestInit: RequestInit | undefined

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input)
    requestInit = init
    return new Response(null, { status: 200 })
  }

  const result = await submitIndexNowUrls({
    host: 'oddweb.page',
    urls: ['https://oddweb.page/sites/sample'],
    fetchFn: mockFetch,
  })

  assert.equal(result, true)
  assert.equal(requestedUrl, 'https://api.indexnow.org/indexnow')
  assert.ok(requestInit)
  assert.equal(requestInit.method, 'POST')
  assert.deepEqual(
    JSON.parse(String(requestInit.body)),
    formatIndexNowPayload({
      host: 'oddweb.page',
      urlList: ['https://oddweb.page/sites/sample'],
    }),
  )
})
