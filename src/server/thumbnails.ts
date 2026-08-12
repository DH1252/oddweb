import { env } from 'cloudflare:workers'

import { thumbnailUrl } from '../lib/thumbnails'
import {
  isThumbnailReferenced,
  listReferencedThumbnailKeys,
} from '../db/repository'

import type { ThumbnailUpload } from '../lib/thumbnails'

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

export async function reconcileThumbnails(deleteOrphans = false) {
  const referenced = await listReferencedThumbnailKeys()
  const storedKeys = new Set<string>()
  const orphanKeys: string[] = []
  let cursor: string | undefined
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  do {
    const page = await env.THUMBNAILS.list({
      prefix: 'thumbnails/',
      cursor,
      limit: 500,
    })
    for (const object of page.objects) {
      const key = object.key.slice('thumbnails/'.length)
      storedKeys.add(key)
      if (object.uploaded.getTime() < cutoff && !referenced.has(key)) {
        orphanKeys.push(object.key)
      }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  if (deleteOrphans) {
    for (let index = 0; index < orphanKeys.length; index += 1000) {
      await env.THUMBNAILS.delete(orphanKeys.slice(index, index + 1000))
    }
  }
  const missingKeys = [...referenced].filter((key) => !storedKeys.has(key))
  return {
    referenced: referenced.size,
    stored: storedKeys.size,
    orphanKeys,
    missingKeys,
    deleted: deleteOrphans ? orphanKeys.length : 0,
  }
}

export async function cleanupArchivedThumbnail(key: string) {
  return cleanupUnreferencedThumbnail(key)
}

async function cleanupUnreferencedThumbnail(key: string) {
  try {
    if (await isThumbnailReferenced(key)) return false
    await removeThumbnail(key)
    return true
  } catch (error) {
    console.error({
      event: 'archived_thumbnail_cleanup_failed',
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
