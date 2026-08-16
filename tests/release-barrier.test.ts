import assert from 'node:assert/strict'
import test from 'node:test'

import {
  enforceReleaseWriteBarrier,
  releaseBarrierRetrySeconds,
} from '../src/server/release-barrier'
import {
  beginReleaseInvocation,
  finishReleaseInvocation,
  renewReleaseInvocation,
} from '../src/server/release-barrier.server'

test('maintenance lock rejects writes before next or body parsing', async () => {
  const request = multipartRequest('POST')
  let nextCalled = false
  let parsed = false
  Object.defineProperty(request, 'formData', {
    value: async () => {
      parsed = true
      return new FormData()
    },
  })

  const result = await enforceReleaseWriteBarrier({
    request,
    handlerType: 'serverFn',
    readBarrierState: async () => ({
      maintenanceValue: '1',
      seedReady: false,
    }),
    next: async () => {
      nextCalled = true
      return request.formData()
    },
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 503)
  assert.equal(
    result.headers.get('Retry-After'),
    String(releaseBarrierRetrySeconds),
  )
  assert.equal(result.headers.get('Cache-Control'), 'no-store')
  assert.equal(nextCalled, false)
  assert.equal(parsed, false)
})

test('malformed maintenance values and state read failures fail closed', async () => {
  for (const readBarrierState of [
    async () => ({ maintenanceValue: '', seedReady: true }),
    async () => ({ maintenanceValue: 'true', seedReady: true }),
    async () => ({ maintenanceValue: ' 1 ', seedReady: true }),
    async (): Promise<never> => {
      throw new Error('D1 unavailable')
    },
  ]) {
    let nextCalled = false
    const result = await enforceReleaseWriteBarrier({
      request: multipartRequest('POST'),
      handlerType: 'serverFn',
      readBarrierState,
      next: () => {
        nextCalled = true
        return 'allowed'
      },
    })

    assert.ok(result instanceof Response)
    assert.equal(result.status, 503)
    assert.equal(nextCalled, false)
  }
})

test('malformed maintenance values also fail closed for seeded reads', async () => {
  let nextCalled = false
  const result = await enforceReleaseWriteBarrier({
    request: new Request('https://oddweb.test/_serverFn/read'),
    handlerType: 'serverFn',
    readBarrierState: async () => ({
      maintenanceValue: 'unexpected',
      seedReady: true,
    }),
    next: () => {
      nextCalled = true
      return 'read allowed'
    },
  })

  assert.ok(result instanceof Response)
  assert.equal(result.status, 503)
  assert.equal(nextCalled, false)
})

test('maintenance blocks server function GET invocations because they may mutate', async () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    let nextCalled = false
    const blocked = await enforceReleaseWriteBarrier({
      request: new Request('https://oddweb.test/_serverFn/read', { method }),
      handlerType: 'serverFn',
      readBarrierState: async () => ({
        maintenanceValue: '1',
        seedReady: false,
      }),
      next: () => {
        nextCalled = true
        return 'unsafe read'
      },
    })
    assert.ok(blocked instanceof Response)
    assert.equal(blocked.status, 503)
    assert.equal(nextCalled, false)

    const blockedSeeded = await enforceReleaseWriteBarrier({
      request: new Request('https://oddweb.test/_serverFn/read', { method }),
      handlerType: 'serverFn',
      readBarrierState: async () => ({
        maintenanceValue: '1',
        seedReady: true,
      }),
      next: () => 'seeded read allowed',
    })
    assert.ok(blockedSeeded instanceof Response)
    assert.equal(blockedSeeded.status, 503)
  }
})

test('router requests bypass the maintenance lock', async () => {
  let stateReads = 0
  assert.equal(
    await enforceReleaseWriteBarrier({
      request: multipartRequest('POST'),
      handlerType: 'router',
      readBarrierState: async () => {
        stateReads += 1
        return { maintenanceValue: '1', seedReady: false }
      },
      next: () => 'router allowed',
    }),
    'router allowed',
  )
  assert.equal(stateReads, 0)
})

test('missing or cleared maintenance locks allow writes', async () => {
  for (const value of [null, '0'] as const) {
    assert.equal(
      await enforceReleaseWriteBarrier({
        request: multipartRequest('POST'),
        handlerType: 'serverFn',
        readBarrierState: async () => ({
          maintenanceValue: value,
          seedReady: false,
        }),
        next: () => 'write allowed',
      }),
      'write allowed',
    )
  }
})

test('invocation admission atomically registers work only before maintenance', async () => {
  const database = invocationDatabase()
  const admitted = await beginReleaseInvocation('queue', {
    database,
    id: 'before',
    now: 10,
  })
  assert.equal(admitted.admitted, true)
  assert.equal(database.rows.has('release:invocation:before'), true)

  database.rows.set('release:maintenance', '1')
  const blocked = await beginReleaseInvocation('scheduled', {
    database,
    id: 'after',
    now: 11,
  })
  assert.deepEqual(blocked, { admitted: false })
  assert.equal(database.rows.has('release:invocation:after'), false)

  assert.ok(admitted.invocation)
  await renewReleaseInvocation(admitted.invocation, 20)
  assert.equal(
    JSON.parse(database.rows.get('release:invocation:before') ?? '{}')
      .expiresAt,
    1220,
  )
  await finishReleaseInvocation(admitted.invocation)
  assert.equal(database.rows.has('release:invocation:before'), false)
})

function multipartRequest(method: string) {
  return new Request('https://oddweb.test/_serverFn/write', {
    method,
    headers: { 'content-type': 'multipart/form-data; boundary=test' },
    body: '--test--',
  })
}

function invocationDatabase() {
  const rows = new Map<string, string>([['catalog-seed-v2', '1']])
  const database = {
    rows,
    prepare(sql: string) {
      let values: unknown[] = []
      return {
        bind(...bindings: unknown[]) {
          values = bindings
          return this
        },
        async first<T>() {
          if (sql.includes('INSERT INTO app_state')) {
            const key = String(values[0])
            if (rows.has('release:maintenance')) {
              return null
            }
            const value = JSON.stringify({
              id: values[1],
              expiresAt: values[4],
            })
            rows.set(key, value)
            return value as T
          }
          const maintenanceValue = rows.get('release:maintenance') ?? null
          return {
            maintenanceValue,
            seedReady: rows.has('catalog-seed-v2') ? 1 : 0,
          } as T
        },
        async run() {
          if (sql.includes('UPDATE app_state')) {
            const key = String(values[0])
            const value = JSON.parse(rows.get(key) ?? '{}')
            if (value.id !== values[1]) return { meta: { changes: 0 } }
            value.expiresAt = values[2]
            rows.set(key, JSON.stringify(value))
            return { meta: { changes: 1 } }
          }
          rows.delete(String(values[0]))
          return { success: true, meta: { changes: 1 } }
        },
      }
    },
  }
  return database as unknown as D1Database & { rows: Map<string, string> }
}
