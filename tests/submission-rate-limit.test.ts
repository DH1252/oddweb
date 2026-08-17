import assert from 'node:assert/strict'
import test from 'node:test'

import { consumeSubmissionRateLimit } from '../src/db/submission-rate-limit'
import { migratedTaxonomyDb } from './taxonomy-test-db'

test('submission limits slide over the preceding three hours', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const key = 'submission-key'
  const limit = 15
  const windowSeconds = 3 * 60 * 60
  const startedAt = 1_000_000

  for (let index = 0; index < limit; index += 1) {
    assert.deepEqual(
      await consumeSubmissionRateLimit(
        db,
        key,
        limit,
        windowSeconds,
        startedAt + index,
      ),
      { allowed: true, retryAfter: 0 },
    )
  }

  assert.deepEqual(
    await consumeSubmissionRateLimit(
      db,
      key,
      limit,
      windowSeconds,
      startedAt + limit,
    ),
    { allowed: false, retryAfter: windowSeconds - limit },
  )

  assert.deepEqual(
    await consumeSubmissionRateLimit(
      db,
      key,
      limit,
      windowSeconds,
      startedAt + windowSeconds + 1,
    ),
    { allowed: true, retryAfter: 0 },
  )
})

test('submission limits isolate client keys and remove expired attempts', async (context) => {
  const db = await migratedTaxonomyDb(context)
  const limit = 1
  const windowSeconds = 3 * 60 * 60

  assert.equal(
    (await consumeSubmissionRateLimit(db, 'first', limit, windowSeconds, 100))
      .allowed,
    true,
  )
  assert.equal(
    (await consumeSubmissionRateLimit(db, 'second', limit, windowSeconds, 100))
      .allowed,
    true,
  )
  assert.equal(
    (
      await consumeSubmissionRateLimit(
        db,
        'first',
        limit,
        windowSeconds,
        100 + windowSeconds + 1,
      )
    ).allowed,
    true,
  )

  const staleAttempts = await db
    .prepare(
      'SELECT count(*) AS count FROM public_submission_attempts WHERE attempted_at <= ?',
    )
    .bind(100 + windowSeconds)
    .first<{ count: number }>()
  assert.equal(staleAttempts?.count, 0)
})
