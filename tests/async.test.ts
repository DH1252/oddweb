import assert from 'node:assert/strict'
import test from 'node:test'

import { mapSeries, mapSettledSeries } from '../src/lib/async'

test('mapSeries stops before starting later work after a rejection', async () => {
  const started: number[] = []
  let active = 0
  let maxActive = 0

  await assert.rejects(
    mapSeries([1, 2, 3], async (value) => {
      started.push(value)
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      if (value === 2) throw new Error('write failed')
      return value
    }),
    /write failed/,
  )

  assert.deepEqual(started, [1, 2])
  assert.equal(maxActive, 1)
})

test('mapSettledSeries checks every item serially and keeps result order', async () => {
  const started: number[] = []
  let active = 0
  let maxActive = 0

  const results = await mapSettledSeries([1, 2, 3], async (value) => {
    started.push(value)
    active += 1
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    active -= 1
    if (value === 2) throw new Error('preparation failed')
    return value * 10
  })

  assert.deepEqual(started, [1, 2, 3])
  assert.equal(maxActive, 1)
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'rejected', 'fulfilled'],
  )
  assert.equal(results[0]?.status === 'fulfilled' && results[0].value, 10)
  assert.match(
    String(results[1]?.status === 'rejected' && results[1].reason),
    /preparation failed/,
  )
  assert.equal(results[2]?.status === 'fulfilled' && results[2].value, 30)
})
