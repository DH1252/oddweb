import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanupPublicAttempts,
  releasePublicAttempts,
  reservePublicAttempts,
} from '../src/db/public-attempts'
import { migratedTaxonomyDb } from './taxonomy-test-db'

test('layered reservations are all-or-nothing and refund by reservation id', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const scopes = [
    { scope: 'identity', key: 'identity-a', limit: 1, windowSeconds: 3600 },
    { scope: 'global', key: 'global', limit: 2, windowSeconds: 3600 },
  ]
  assert.deepEqual(
    await reservePublicAttempts(
      db,
      {
        action: 'submission',
        reservationId: 'reservation-1',
        scopes,
      },
      100,
    ),
    { allowed: true, retryAfter: 0 },
  )
  assert.deepEqual(
    await reservePublicAttempts(
      db,
      {
        action: 'submission',
        reservationId: 'reservation-2',
        scopes,
      },
      101,
    ),
    { allowed: false, retryAfter: 3599 },
  )
  await releasePublicAttempts(db, 'reservation-1')
  assert.deepEqual(
    await reservePublicAttempts(
      db,
      {
        action: 'submission',
        reservationId: 'reservation-3',
        scopes,
      },
      102,
    ),
    { allowed: true, retryAfter: 0 },
  )
  await cleanupPublicAttempts(db, 102 + 24 * 60 * 60 + 1)
  const remaining = await db
    .prepare(
      'SELECT count(*) AS count FROM public_attempts WHERE attempted_at <= ?',
    )
    .bind(102 + 24 * 60 * 60 + 1 - 24 * 60 * 60)
    .first<{ count: number }>()
  assert.equal(remaining?.count, 0)
})
