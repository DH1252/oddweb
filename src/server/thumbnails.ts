import { env } from 'cloudflare:workers'

import { thumbnailUrl } from '../lib/thumbnails'
import {
  findReferencedThumbnailKeys,
  isThumbnailReferenced,
  listReferencedThumbnailKeyBatch,
} from '../db/repository'
import {
  decodeReconciliationCursor,
  emptyReconciliationProgress,
  encodeReconciliationCursor,
  mergeReconciliationProgress,
  reconciliationCursorMaxAgeSeconds,
} from './thumbnail-reconciliation'

import type { ThumbnailUpload } from '../lib/thumbnails'
import type {
  ReconciliationCursorState,
  ReconciliationPhase,
  ReconciliationProgress,
} from './thumbnail-reconciliation'

const maxThumbnailBytes = 8 * 1024 * 1024
const thumbnailTypes = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export async function storeThumbnail(image: File): Promise<ThumbnailUpload> {
  if (!Object.hasOwn(thumbnailTypes, image.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.')
  }

  const extension = thumbnailTypes[image.type as keyof typeof thumbnailTypes]

  if (image.size === 0 || image.size > maxThumbnailBytes) {
    throw new Error('Choose an image between 1 byte and 8 MB.')
  }
  if (image.name.length > 120) {
    throw new Error('Thumbnail filename must be 120 characters or fewer.')
  }

  const signature = new Uint8Array(await image.slice(0, 12).arrayBuffer())
  if (!hasImageSignature(signature, image.type)) {
    throw new Error('The uploaded file does not match its image type.')
  }

  const objectName = `${crypto.randomUUID()}.${extension}`
  const key = `thumbnails/${objectName}`

  await env.THUMBNAILS.put(key, image.stream(), {
    httpMetadata: {
      contentType: image.type,
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'inline',
    },
    customMetadata: {
      originalName: image.name,
    },
  })

  return {
    key: objectName,
    url: thumbnailUrl(objectName),
  }
}

export async function removeThumbnail(key: string) {
  await env.THUMBNAILS.delete(`thumbnails/${key}`)
}

export async function reconcileThumbnails(input?: {
  cursor?: string
  limit?: number
}) {
  const limit = normalizeReconciliationLimit(input?.limit)
  const secret = env.ADMIN_SESSION_SECRET
  const state = input?.cursor
    ? await decodeReconciliationCursor(input.cursor, secret)
    : initialReconciliationState()

  if (state.phase === 'r2') {
    return reconcileR2Page(state, limit, secret)
  }
  return reconcileD1Batch(state, limit, secret)
}

async function reconcileR2Page(
  state: ReconciliationCursorState,
  limit: number,
  secret: string,
) {
  const page = await env.THUMBNAILS.list({
    prefix: 'thumbnails/',
    cursor: state.r2Cursor,
    limit,
  })
  const keys = page.objects.map((object) =>
    object.key.slice('thumbnails/'.length),
  )
  const referenced = await findReferencedThumbnailKeys(keys)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const orphanKeys = page.objects
    .filter(
      (object, index) =>
        object.uploaded.getTime() < cutoff && !referenced.has(keys[index]),
    )
    .map((object) => object.key)
  const progress = mergeReconciliationProgress(state, {
    stored: page.objects.length,
    orphaned: orphanKeys.length,
    orphanKeys,
  })
  const nextState: ReconciliationCursorState = {
    ...state,
    ...progress,
    phase: page.truncated ? 'r2' : 'd1',
    r2Cursor: page.truncated ? page.cursor : undefined,
  }
  return reconciliationResult(
    progress,
    nextState.phase,
    await encodeReconciliationCursor(nextState, secret),
  )
}

async function reconcileD1Batch(
  state: ReconciliationCursorState,
  limit: number,
  secret: string,
) {
  const batch = await listReferencedThumbnailKeyBatch(state.d1AfterKey, limit)
  const present = await mapConcurrent(batch.keys, 20, async (key) => ({
    key,
    exists: (await env.THUMBNAILS.head(`thumbnails/${key}`)) !== null,
  }))
  const missingKeys = present
    .filter((entry) => !entry.exists)
    .map((entry) => entry.key)
  const progress = mergeReconciliationProgress(state, {
    referenced: batch.keys.length,
    missing: missingKeys.length,
    missingKeys,
  })
  if (!batch.hasMore) return reconciliationResult(progress, 'complete')

  const nextState: ReconciliationCursorState = {
    ...state,
    ...progress,
    d1AfterKey: batch.keys.at(-1),
  }
  return reconciliationResult(
    progress,
    'd1',
    await encodeReconciliationCursor(nextState, secret),
  )
}

function initialReconciliationState(): ReconciliationCursorState {
  return {
    version: 1,
    phase: 'r2',
    expiresAt:
      Math.floor(Date.now() / 1000) + reconciliationCursorMaxAgeSeconds,
    ...emptyReconciliationProgress(),
  }
}

function normalizeReconciliationLimit(limit: number | undefined) {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      'Thumbnail reconciliation limit must be a positive integer.',
    )
  }
  return Math.min(limit, 200)
}

function reconciliationResult(
  progress: ReconciliationProgress,
  phase: ReconciliationPhase,
  cursor?: string,
) {
  return { ...progress, phase, cursor, deleted: 0 as const }
}

async function mapConcurrent<T, TResult>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<TResult>,
) {
  const results = new Array<TResult>(values.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await callback(values[index])
      }
    }),
  )
  return results
}

export async function cleanupArchivedThumbnail(key: string) {
  try {
    if (await isThumbnailReferenced(key)) return false
    console.info({ event: 'archived_thumbnail_retained', key })
    return false
  } catch (error) {
    console.error({
      event: 'archived_thumbnail_check_failed',
      key,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

function hasImageSignature(bytes: Uint8Array, contentType: string) {
  if (contentType === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  }

  if (contentType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }

  if (contentType === 'image/webp') {
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    )
  }

  return false
}
