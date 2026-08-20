import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldCleanupVisitLimits,
  visitAccountingTimestamp,
  visitWindowSeconds,
} from '../src/db/visit-repository'

test('visit limiter uses a 24-hour window', () => {
  assert.equal(visitWindowSeconds, 86_400)
})

test('visit timestamps use whole Unix seconds', () => {
  assert.equal(visitAccountingTimestamp(1_765_432_109_987), 1_765_432_109)
})

test('cleanup sampling is deterministic and approximately one in 64', () => {
  const samples = Array.from({ length: 256 }, (_, value) =>
    value.toString(16).padStart(2, '0').repeat(32),
  )
  assert.deepEqual(samples.filter(shouldCleanupVisitLimits), [
    '00'.repeat(32),
    '40'.repeat(32),
    '80'.repeat(32),
    'c0'.repeat(32),
  ])
  assert.equal(shouldCleanupVisitLimits('not-a-key'), false)
})
