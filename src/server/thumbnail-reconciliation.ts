import { Buffer } from 'node:buffer'

export const reconciliationSampleLimit = 20
export const reconciliationCursorMaxAgeSeconds = 24 * 60 * 60

export type ReconciliationPhase = 'r2' | 'd1' | 'complete'

export type ReconciliationProgress = {
  referenced: number
  stored: number
  orphaned: number
  missing: number
  orphanKeys: string[]
  missingKeys: string[]
}

export type ReconciliationCursorState = ReconciliationProgress & {
  version: 1
  phase: Exclude<ReconciliationPhase, 'complete'>
  r2Cursor?: string
  d1AfterKey?: string
  expiresAt: number
}

export type ReconciliationDelta = Partial<
  Pick<ReconciliationProgress, 'referenced' | 'stored' | 'orphaned' | 'missing'>
> & {
  orphanKeys?: string[]
  missingKeys?: string[]
}

export function emptyReconciliationProgress(): ReconciliationProgress {
  return {
    referenced: 0,
    stored: 0,
    orphaned: 0,
    missing: 0,
    orphanKeys: [],
    missingKeys: [],
  }
}

export function mergeReconciliationProgress(
  progress: ReconciliationProgress,
  delta: ReconciliationDelta,
  sampleLimit = reconciliationSampleLimit,
): ReconciliationProgress {
  return {
    referenced: progress.referenced + (delta.referenced ?? 0),
    stored: progress.stored + (delta.stored ?? 0),
    orphaned: progress.orphaned + (delta.orphaned ?? 0),
    missing: progress.missing + (delta.missing ?? 0),
    orphanKeys: mergeSamples(
      progress.orphanKeys,
      delta.orphanKeys,
      sampleLimit,
    ),
    missingKeys: mergeSamples(
      progress.missingKeys,
      delta.missingKeys,
      sampleLimit,
    ),
  }
}

export async function encodeReconciliationCursor(
  state: ReconciliationCursorState,
  secret: string,
) {
  requireSecret(secret)
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  const signature = await sign(payload, secret)
  return `${payload}.${Buffer.from(signature).toString('base64url')}`
}

export async function decodeReconciliationCursor(
  cursor: string,
  secret: string,
  now = Date.now(),
): Promise<ReconciliationCursorState> {
  requireSecret(secret)
  const [payload, encodedSignature, extra] = cursor.split('.')
  if (!payload || !encodedSignature || extra) throw invalidCursor()

  let signature: ArrayBuffer
  try {
    signature = Uint8Array.from(
      Buffer.from(encodedSignature, 'base64url'),
    ).buffer
  } catch {
    throw invalidCursor()
  }

  const key = await importSigningKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(payload),
  )
  if (!valid) throw invalidCursor()

  let state: unknown
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    throw invalidCursor()
  }
  if (!isCursorState(state) || state.expiresAt <= Math.floor(now / 1000)) {
    throw invalidCursor()
  }
  return state
}

function mergeSamples(
  current: string[],
  additions: string[] | undefined,
  limit: number,
) {
  if (limit <= 0) return []
  return [...current, ...(additions ?? [])].slice(0, limit)
}

async function sign(value: string, secret: string) {
  const key = await importSigningKey(secret)
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
}

function importSigningKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function requireSecret(secret: string) {
  if (!secret) throw new Error('Thumbnail reconciliation is not configured.')
}

function invalidCursor() {
  return new Error('Invalid or expired thumbnail reconciliation cursor.')
}

function isCursorState(value: unknown): value is ReconciliationCursorState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return (
    state.version === 1 &&
    (state.phase === 'r2' || state.phase === 'd1') &&
    isOptionalString(state.r2Cursor) &&
    isOptionalString(state.d1AfterKey) &&
    isNonNegativeInteger(state.referenced) &&
    isNonNegativeInteger(state.stored) &&
    isNonNegativeInteger(state.orphaned) &&
    isNonNegativeInteger(state.missing) &&
    isStringArray(state.orphanKeys) &&
    isStringArray(state.missingKeys) &&
    isNonNegativeInteger(state.expiresAt)
  )
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string'
}

function isNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  )
}
