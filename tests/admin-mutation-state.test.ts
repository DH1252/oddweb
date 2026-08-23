import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeAdminMutation,
  reduceAdminMutationState,
} from '../src/components/use-admin-mutation'
import type { AdminMutationState } from '../src/components/use-admin-mutation'

test('admin mutation state fences stale completions and tracks overlap', () => {
  let state: AdminMutationState<Error, string | undefined> = {
    error: null,
    latestRequestId: 0,
    pendingCount: 0,
    variables: undefined,
  }

  state = reduceAdminMutationState(state, {
    type: 'started',
    requestId: 1,
    variables: 'older',
  })
  state = reduceAdminMutationState(state, {
    type: 'started',
    requestId: 2,
    variables: 'latest',
  })
  state = reduceAdminMutationState(state, {
    type: 'failed',
    requestId: 1,
    error: new Error('stale failure'),
  })

  assert.equal(state.pendingCount, 1)
  assert.equal(state.variables, 'latest')
  assert.equal(state.error, null)

  const latestError = new Error('latest failure')
  state = reduceAdminMutationState(state, {
    type: 'failed',
    requestId: 2,
    error: latestError,
  })

  assert.equal(state.pendingCount, 0)
  assert.equal(state.variables, 'latest')
  assert.equal(state.error, latestError)
})

test('stale success cannot clear the latest request error', () => {
  const latestError = new Error('latest failure')
  const state = reduceAdminMutationState<Error, string>(
    {
      error: latestError,
      latestRequestId: 2,
      pendingCount: 1,
      variables: 'latest',
    },
    { type: 'succeeded', requestId: 1 },
  )

  assert.equal(state.pendingCount, 0)
  assert.equal(state.error, latestError)
  assert.equal(state.variables, 'latest')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

test('older success reconciles after a newer mutation fails', async () => {
  const older = deferred<string>()
  const reconciled: string[] = []
  const olderRequest = executeAdminMutation({
    mutation: () => older.promise,
    onSuccess: (value) => {
      reconciled.push(value)
    },
    isLatest: () => true,
    onSuccessState: () => undefined,
    onError: () => undefined,
  })
  const newerRequest = executeAdminMutation({
    mutation: () => Promise.reject(new Error('newer failed')),
    onSuccess: (value: string) => {
      reconciled.push(value)
    },
    isLatest: () => true,
    onSuccessState: () => undefined,
    onError: () => undefined,
  })

  await assert.rejects(newerRequest, /newer failed/)
  older.resolve('older')
  await olderRequest
  assert.deepEqual(reconciled, ['older'])
})

test('every successful overlap reconciles even when completion order reverses', async () => {
  const older = deferred<string>()
  const newer = deferred<string>()
  const reconciled: string[] = []
  const run = (request: Promise<string>) =>
    executeAdminMutation({
      mutation: () => request,
      onSuccess: (value) => {
        reconciled.push(value)
      },
      isLatest: () => true,
      onSuccessState: () => undefined,
      onError: () => undefined,
    })
  const olderRequest = run(older.promise)
  const newerRequest = run(newer.promise)

  newer.resolve('newer')
  await newerRequest
  older.resolve('older')
  await olderRequest
  assert.deepEqual(reconciled, ['newer', 'older'])
})

test('stale success reconciles without replacing latest-only UI state', async () => {
  const reconciled: string[] = []
  const presented: string[] = []

  await executeAdminMutation({
    mutation: () => Promise.resolve('older'),
    onSuccess: (value) => {
      reconciled.push(value)
    },
    onLatestSuccess: (value) => {
      presented.push(value)
    },
    isLatest: () => false,
    onSuccessState: () => undefined,
    onError: () => undefined,
  })

  assert.deepEqual(reconciled, ['older'])
  assert.deepEqual(presented, [])
})
