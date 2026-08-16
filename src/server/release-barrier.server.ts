import { releaseMaintenanceKey } from './release-barrier'

import type { ReleaseBarrierState } from './release-barrier'

const catalogSeedStateKey = 'catalog-seed-v2'
const invocationKeyPrefix = 'release:invocation:'
// Queue consumers can run for up to 15 minutes. Keep crashed invocation
// records bounded without letting active work disappear before that window.
const invocationLifetimeSeconds = 20 * 60
const invocationHeartbeatSeconds = 60

export type ReleaseInvocationKind = 'fetch' | 'queue' | 'scheduled' | 'deferred'

export async function readReleaseBarrierState(
  maintenanceKey: string,
  database: D1Database,
): Promise<ReleaseBarrierState> {
  const state = await database
    .prepare(
      `SELECT
         (SELECT value FROM app_state WHERE key = ?1) AS maintenanceValue,
         EXISTS(SELECT 1 FROM app_state WHERE key = ?2) AS seedReady`,
    )
    .bind(maintenanceKey, catalogSeedStateKey)
    .first<{ maintenanceValue: string | null; seedReady: number }>()

  if (!state) throw new Error('Release barrier state is unavailable.')
  return {
    maintenanceValue: state.maintenanceValue,
    seedReady: state.seedReady === 1,
  }
}

export async function beginReleaseInvocation(
  kind: ReleaseInvocationKind,
  options: {
    database?: D1Database
    now?: number
    id?: string
  } = {},
): Promise<
  | { admitted: false }
  | { admitted: true; invocation: null }
  | {
      admitted: true
      invocation: { key: string; id: string; database: D1Database }
    }
> {
  if (!options.database) {
    throw new Error('Release invocation admission requires a D1 database.')
  }
  const database = options.database
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const id = options.id ?? crypto.randomUUID()
  const key = `${invocationKeyPrefix}${id}`
  const inserted = await database
    .prepare(
      `INSERT INTO app_state (key, value)
       SELECT ?1, json_object(
         'id', ?2,
         'kind', ?3,
         'startedAt', ?4,
         'expiresAt', ?5
       )
       WHERE NOT EXISTS (
         SELECT 1 FROM app_state WHERE key = ?6 AND value <> '0'
       )
       RETURNING value`,
    )
    .bind(
      key,
      id,
      kind,
      now,
      now + invocationLifetimeSeconds,
      releaseMaintenanceKey,
    )
    .first<string>('value')

  if (inserted) {
    return { admitted: true, invocation: { key, id, database } }
  }
  return { admitted: false }
}

export async function finishReleaseInvocation(invocation: {
  key: string
  id: string
  database: D1Database
}) {
  await invocation.database
    .prepare(
      `DELETE FROM app_state
       WHERE key = ?1 AND json_extract(value, '$.id') = ?2`,
    )
    .bind(invocation.key, invocation.id)
    .run()
}

export async function renewReleaseInvocation(
  invocation: { key: string; id: string; database: D1Database },
  now = Math.floor(Date.now() / 1000),
) {
  const result = await invocation.database
    .prepare(
      `UPDATE app_state
       SET value = json_set(value, '$.expiresAt', ?3)
       WHERE key = ?1 AND json_extract(value, '$.id') = ?2`,
    )
    .bind(invocation.key, invocation.id, now + invocationLifetimeSeconds)
    .run()
  if (result.meta.changes !== 1) {
    throw new Error('Release invocation ownership was lost.')
  }
}

export async function runWithReleaseInvocation<TResult>(
  kind: ReleaseInvocationKind,
  operation: () => Promise<TResult>,
  options: Parameters<typeof beginReleaseInvocation>[1] = {},
): Promise<{ admitted: false } | { admitted: true; value: TResult }> {
  const admission = await beginReleaseInvocation(kind, options)
  if (!admission.admitted) return admission
  const invocation = admission.invocation
  const heartbeat = invocation
    ? setInterval(() => {
        void renewReleaseInvocation(invocation).catch((error) => {
          console.error({
            event: 'release_invocation_heartbeat_failed',
            invocationId: invocation.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }, invocationHeartbeatSeconds * 1000)
    : null
  try {
    return { admitted: true, value: await operation() }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (admission.invocation) {
      try {
        await finishReleaseInvocation(admission.invocation)
      } catch (error) {
        console.error({
          event: 'release_invocation_cleanup_failed',
          invocationId: admission.invocation.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
