export async function consumeSlidingWindowRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000),
) {
  const cutoff = now - windowSeconds
  const inserted = await db
    .prepare(
      `INSERT INTO public_submission_attempts (key, attempted_at)
       SELECT ?1, ?2
       WHERE (
         SELECT count(*)
         FROM public_submission_attempts
         WHERE key = ?1 AND attempted_at > ?3
       ) < ?4
       RETURNING id`,
    )
    .bind(key, now, cutoff, limit)
    .first<{ id: number }>()

  if (inserted) {
    await db
      .prepare(
        'DELETE FROM public_submission_attempts WHERE attempted_at <= ?1',
      )
      .bind(cutoff)
      .run()
    return { allowed: true, retryAfter: 0 }
  }

  const oldestAttempt = await db
    .prepare(
      `SELECT min(attempted_at) AS attemptedAt
       FROM public_submission_attempts
       WHERE key = ?1 AND attempted_at > ?2`,
    )
    .bind(key, cutoff)
    .first<{ attemptedAt: number | null }>()
  if (oldestAttempt?.attemptedAt == null) {
    throw new Error('Could not evaluate rate limit.')
  }
  return {
    allowed: false,
    retryAfter: Math.max(1, oldestAttempt.attemptedAt + windowSeconds - now),
  }
}

export async function releaseSlidingWindowRateLimit(
  db: D1Database,
  key: string,
) {
  await db
    .prepare(
      `DELETE FROM public_submission_attempts
       WHERE id IN (
         SELECT id FROM public_submission_attempts
         WHERE key = ?1
         ORDER BY attempted_at DESC, id DESC
         LIMIT 1
       )`,
    )
    .bind(key)
    .run()
}
