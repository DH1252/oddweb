import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  enforceUploadRequestSize,
  maxUploadRequestBytes,
} from '../src/server/upload-request'

const uploadPath = '/_serverFn/upload-test'
const uploadPaths = new Set([uploadPath])

test('oversized multipart upload is rejected before body parsing', async () => {
  let parsed = false
  const request = uploadRequest(String(maxUploadRequestBytes + 1))
  Object.defineProperty(request, 'formData', {
    value: async () => {
      parsed = true
      return new FormData()
    },
  })

  const result = await enforceUploadRequestSize({
    request,
    pathname: uploadPath,
    handlerType: 'serverFn',
    uploadPaths,
    next: () => request.formData(),
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 413)
  assert.equal(parsed, false)
})

test('uploads require a valid nonzero Content-Length before parsing', async () => {
  for (const [contentLength, status] of [
    [undefined, 411],
    ['-1', 400],
    ['1.5', 400],
    ['0', 400],
    [String(Number.MAX_SAFE_INTEGER) + '0', 400],
  ] as const) {
    let nextCalled = false
    const result = await enforceUploadRequestSize({
      request: uploadRequest(contentLength),
      pathname: uploadPath,
      handlerType: 'serverFn',
      uploadPaths,
      next: () => {
        nextCalled = true
        return 'parsed'
      },
    })
    assert.ok(result instanceof Response)
    assert.equal(result.status, status)
    assert.equal(nextCalled, false)
  }
})

test('upload guard rejects unsupported media types before body parsing', async () => {
  for (const contentType of [undefined, 'application/json', 'text/plain']) {
    let nextCalled = false
    const headers = new Headers({
      'content-length': '2',
    })
    if (contentType) headers.set('content-type', contentType)
    const result = await enforceUploadRequestSize({
      request: new Request(`https://oddweb.test${uploadPath}`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
      pathname: uploadPath,
      handlerType: 'serverFn',
      uploadPaths,
      next: () => {
        nextCalled = true
        return 'parsed'
      },
    })

    assert.ok(result instanceof Response)
    assert.equal(result.status, 415)
    assert.equal(nextCalled, false)
  }
})

test('oversized JSON is rejected by size before media type validation', async () => {
  let nextCalled = false
  const result = await enforceUploadRequestSize({
    request: new Request(`https://oddweb.test${uploadPath}`, {
      method: 'POST',
      headers: {
        'content-length': String(maxUploadRequestBytes + 1),
        'content-type': 'application/json',
      },
      body: '{}',
    }),
    pathname: uploadPath,
    handlerType: 'serverFn',
    uploadPaths,
    next: () => {
      nextCalled = true
      return 'parsed'
    },
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 413)
  assert.equal(nextCalled, false)
})

test('chunked uploads are rejected before body parsing', async () => {
  let nextCalled = false
  const request = uploadRequest('16')
  request.headers.set('transfer-encoding', 'chunked')
  const result = await enforceUploadRequestSize({
    request,
    pathname: uploadPath,
    handlerType: 'serverFn',
    uploadPaths,
    next: () => {
      nextCalled = true
      return 'parsed'
    },
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 411)
  assert.equal(nextCalled, false)
})

test('uploads with a declared length but no body are rejected before parsing', async () => {
  let nextCalled = false
  const result = await enforceUploadRequestSize({
    request: new Request(`https://oddweb.test${uploadPath}`, {
      method: 'POST',
      headers: {
        'content-length': '16',
        'content-type': 'multipart/form-data; boundary=test',
      },
    }),
    pathname: uploadPath,
    handlerType: 'serverFn',
    uploadPaths,
    next: () => {
      nextCalled = true
      return 'parsed'
    },
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 400)
  assert.equal(nextCalled, false)
})

test('upload guard is scoped to configured server functions', () => {
  const validUpload = enforceUploadRequestSize({
    request: uploadRequest(String(maxUploadRequestBytes)),
    pathname: uploadPath,
    handlerType: 'serverFn',
    uploadPaths,
    next: () => 'allowed',
  })
  const otherServerFunction = enforceUploadRequestSize({
    request: uploadRequest(undefined),
    pathname: '/_serverFn/other',
    handlerType: 'serverFn',
    uploadPaths,
    next: () => 'other allowed',
  })

  assert.equal(validUpload, 'allowed')
  assert.equal(otherServerFunction, 'other allowed')
})

test('server function path suffixes cannot bypass the upload guard', async () => {
  let nextCalled = false
  const result = await enforceUploadRequestSize({
    request: uploadRequest(String(maxUploadRequestBytes + 1)),
    pathname: `${uploadPath}/ignored-suffix`,
    handlerType: 'serverFn',
    uploadPaths,
    next: () => {
      nextCalled = true
      return 'parsed'
    },
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 413)
  assert.equal(nextCalled, false)
})

test('canonical Start entry registers early upload and CSRF middleware', async () => {
  const source = await readFile(
    new URL('../src/start.ts', import.meta.url),
    'utf8',
  )

  assert.match(
    source,
    /new Set\(\[submitSite\.url, createDirectorySite\.url, updateDirectorySite\.url\]\)/,
  )
  assert.match(
    source,
    /requestMiddleware: \[\s*uploadRequestSizeMiddleware,\s*releaseWriteBarrierMiddleware,\s*csrfMiddleware,?\s*\]/,
  )
})

function uploadRequest(contentLength: string | undefined) {
  const headers = new Headers({
    'content-type': 'multipart/form-data; boundary=test-boundary',
  })
  if (contentLength !== undefined) headers.set('content-length', contentLength)
  return new Request(`https://oddweb.test${uploadPath}`, {
    method: 'POST',
    headers,
    body: '--test-boundary--',
  })
}
