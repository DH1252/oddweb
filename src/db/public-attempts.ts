export type PublicAttemptScope = {
  scope: string
  key: string
  limit: number
  windowSeconds: number
}

export type PublicAttemptReservation = {
  reservationId: string
  action: string
  scopes: PublicAttemptScope[]
}

export async function reservePublicAttempts(
  db: D1Database,
  reservation: PublicAttemptReservation,
  now = Math.floor(Date.now() / 1000),
) {
  if (!reservation.scopes.length)
    throw new Error('At least one limit is required.')
  const values = reservation.scopes
    .map((_, index) => {
      const base = index * 4 + 4
      return `SELECT ?${base} AS scope, ?${base + 1} AS key, ?${base + 2} AS max_count, ?${base + 3} AS cutoff`
    })
    .join(' UNION ALL ')
  const bindings: unknown[] = []
  for (const scope of reservation.scopes) {
    bindings.push(
      scope.scope,
      scope.key,
      scope.limit,
      now - scope.windowSeconds,
    )
  }
  const result = await db
    .prepare(
      `WITH limits(scope, key, max_count, cutoff) AS (${values})
       INSERT INTO public_attempts (action, scope, key, reservation_id, attempted_at)
       SELECT ?1, limits.scope, limits.key, ?2, ?3
       FROM limits
       WHERE NOT EXISTS (
         SELECT 1 FROM limits blocked
         WHERE (SELECT count(*) FROM public_attempts attempt
                WHERE attempt.action = ?1 AND attempt.scope = blocked.scope
                  AND attempt.key = blocked.key
                  AND attempt.attempted_at > blocked.cutoff) >= blocked.max_count
       )`,
    )
    .bind(reservation.action, reservation.reservationId, now, ...bindings)
    .run()

  await cleanupPublicAttempts(db, now)
  if (result.meta.changes === reservation.scopes.length) {
    return { allowed: true as const, retryAfter: 0 }
  }

  const retryRows = await Promise.all(
    reservation.scopes.map(async (scope) => {
      const cutoff = now - scope.windowSeconds
      const oldest = await db
        .prepare(
          `SELECT min(attempted_at) AS attemptedAt
           FROM public_attempts
           WHERE action = ?1 AND scope = ?2 AND key = ?3 AND attempted_at > ?4`,
        )
        .bind(reservation.action, scope.scope, scope.key, cutoff)
        .first<{ attemptedAt: number | null }>()
      return oldest?.attemptedAt == null
        ? 0
        : Math.max(1, oldest.attemptedAt + scope.windowSeconds - now)
    }),
  )
  return {
    allowed: false as const,
    retryAfter: Math.max(...retryRows, 1),
  }
}

export async function releasePublicAttempts(
  db: D1Database,
  reservationId: string,
) {
  await db
    .prepare('DELETE FROM public_attempts WHERE reservation_id = ?1')
    .bind(reservationId)
    .run()
}

export async function cleanupPublicAttempts(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
) {
  await db
    .prepare('DELETE FROM public_attempts WHERE attempted_at <= ?1')
    .bind(now - 24 * 60 * 60)
    .run()
  await db
    .prepare('DELETE FROM turnstile_failures WHERE attempted_at <= ?1')
    .bind(now - 7 * 24 * 60 * 60)
    .run()
  await db
    .prepare('DELETE FROM vote_toggle_actions WHERE created_at <= ?1')
    .bind(now - 7 * 24 * 60 * 60)
    .run()
  await db
    .prepare('DELETE FROM public_identity_activity WHERE last_seen <= ?1')
    .bind(now - 90 * 24 * 60 * 60)
    .run()
}
