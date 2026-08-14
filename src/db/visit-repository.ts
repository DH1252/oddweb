export const visitWindowSeconds = 6 * 60 * 60

const cleanupAfterSeconds = 24 * 60 * 60
const cleanupBatchSize = 100
const cleanupSampleMask = 0x3f

export type RecordVisitInput = {
  slug: string
  visitorKey: string
  now?: number
}

export type RecordVisitResult = {
  recorded: boolean
  siteFound: boolean
  views?: number
}

export class VisitRepositoryError extends Error {
  readonly code = 'VISIT_ACCOUNTING_DATABASE_ERROR'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VisitRepositoryError'
  }
}

export function shouldCleanupVisitLimits(visitorKey: string) {
  const sample = Number.parseInt(visitorKey.slice(0, 2), 16)
  return Number.isFinite(sample) && (sample & cleanupSampleMask) === 0
}

export function visitAccountingTimestamp(now = Date.now()) {
  return Math.floor(now / 1000)
}

export async function recordAtomicVisit(
  database: D1Database,
  input: RecordVisitInput,
): Promise<RecordVisitResult> {
  const now = input.now ?? visitAccountingTimestamp()
  const windowCutoff = now - visitWindowSeconds
  const statements = [
    database
      .prepare(
        `INSERT INTO public_rate_limits (key, count, window_started)
         SELECT ?1, 1, ?2
         WHERE EXISTS (
           SELECT 1 FROM sites WHERE slug = ?3 AND status = 'active'
         )
         ON CONFLICT(key) DO UPDATE SET
           count = CASE
             WHEN window_started <= ?4 THEN 1
             ELSE 2
           END,
           window_started = CASE
             WHEN window_started <= ?4 THEN ?2
             ELSE window_started
           END
         RETURNING count, window_started AS windowStarted`,
      )
      .bind(input.visitorKey, now, input.slug, windowCutoff),
    database
      .prepare(
        `UPDATE sites
         SET visits = visits + 1
         WHERE slug = ?1
           AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM public_rate_limits
             WHERE key = ?2 AND count = 1 AND window_started = ?3
           )
         RETURNING visits`,
      )
      .bind(input.slug, input.visitorKey, now),
  ]

  if (shouldCleanupVisitLimits(input.visitorKey)) {
    statements.push(
      database
        .prepare(
          `DELETE FROM public_rate_limits
           WHERE key IN (
             SELECT key FROM public_rate_limits
             WHERE window_started < ?1 AND key <> ?2
             LIMIT ?3
           )`,
        )
        .bind(now - cleanupAfterSeconds, input.visitorKey, cleanupBatchSize),
    )
  }

  try {
    const [limitResult, incrementResult] = await database.batch(statements)
    return {
      recorded: incrementResult.results.length === 1,
      siteFound: limitResult.results.length === 1,
      views: (incrementResult.results[0] as { visits?: number } | undefined)
        ?.visits,
    }
  } catch (cause) {
    throw new VisitRepositoryError('Atomic visit accounting failed.', { cause })
  }
}
