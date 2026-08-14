import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeReconciliationCursor,
  emptyReconciliationProgress,
  encodeReconciliationCursor,
  mergeReconciliationProgress,
} from '../src/server/thumbnail-reconciliation'

const secret = 'a sufficiently long test-only reconciliation secret'

test('signed reconciliation cursor round trips', async () => {
  const state = {
    version: 1 as const,
    phase: 'd1' as const,
    d1AfterKey: 'last.webp',
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    ...emptyReconciliationProgress(),
  }
  const cursor = await encodeReconciliationCursor(state, secret)

  assert.deepEqual(await decodeReconciliationCursor(cursor, secret), state)
})

test('reconciliation cursor rejects tampering and expiry', async () => {
  const state = {
    version: 1 as const,
    phase: 'r2' as const,
    expiresAt: 100,
    ...emptyReconciliationProgress(),
  }
  const cursor = await encodeReconciliationCursor(state, secret)
  const [payload, signature] = cursor.split('.')

  await assert.rejects(
    decodeReconciliationCursor(`${payload}x.${signature}`, secret, 50_000),
    /Invalid or expired/,
  )
  await assert.rejects(
    decodeReconciliationCursor(cursor, secret, 100_000),
    /Invalid or expired/,
  )
})

test('progress merge accumulates counters and caps samples', () => {
  const progress = mergeReconciliationProgress(
    {
      referenced: 4,
      stored: 7,
      orphaned: 1,
      missing: 1,
      orphanKeys: ['old-orphan'],
      missingKeys: ['old-missing'],
    },
    {
      referenced: 3,
      stored: 2,
      orphaned: 2,
      missing: 2,
      orphanKeys: ['new-orphan-1', 'new-orphan-2'],
      missingKeys: ['new-missing-1', 'new-missing-2'],
    },
    2,
  )

  assert.deepEqual(progress, {
    referenced: 7,
    stored: 9,
    orphaned: 3,
    missing: 3,
    orphanKeys: ['old-orphan', 'new-orphan-1'],
    missingKeys: ['old-missing', 'new-missing-1'],
  })
})
