import { env } from 'cloudflare:workers'
import { createMiddleware, createServerFn } from '@tanstack/react-start'
import {
  getRequest,
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server'
import { z } from 'zod'

import {
  addGuestbookEntry,
  consumePublicRateLimit,
  createSite,
  createSubmission,
  deleteGuestbookEntry,
  incrementSiteVisits,
  isActiveSite,
  isThumbnailReferenced,
  mergeTagAsAlias,
  moderateSubmission,
  readAdminData,
  readDirectoryData,
  setSiteStatus,
  saveTagDefinition,
  updateSite,
} from '../db/repository'
import { adminAuthMiddleware } from './auth'
import {
  reconcileThumbnails,
  removeThumbnail,
  storeThumbnail,
} from './thumbnails'
import { tagSlug } from '../data/tags'
import { normalizeWebsiteUrl } from '../lib/website-url'

const daySeconds = 24 * 60 * 60
const visitWindowSeconds = 6 * 60 * 60
const maxUploadRequestBytes = 9 * 1024 * 1024

const uploadSizeMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const contentLength = getRequest().headers.get('content-length')
    if (contentLength) {
      const bytes = Number(contentLength)
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        setResponseStatus(400)
        throw new Error('Invalid Content-Length header.')
      }
      if (bytes > maxUploadRequestBytes) {
        setResponseStatus(413)
        throw new Error('Upload request is too large.')
      }
    }
    return next()
  },
)

const guestbookInput = z.object({
  name: z.string().trim().min(1).max(24),
  message: z.string().trim().min(1).max(120),
})

const visitInput = z.object({ slug: z.string().min(1).max(100) })

const moderationInput = z.object({
  id: z.number().int().positive(),
  status: z.enum(['pending', 'approved', 'rejected']),
})

const siteStatusInput = z.object({
  id: z.number().int().positive(),
  status: z.enum(['active', 'archived']),
})

const recordIdInput = z.object({ id: z.number().int().positive() })
const reconcileInput = z.object({ deleteOrphans: z.boolean().default(false) })

const tagDefinitionInput = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30),
  parents: z.array(z.string().trim().min(1).max(80)).max(20),
})

const tagMergeInput = z.object({
  sourceId: z.number().int().positive(),
  targetSlug: z.string().trim().min(1).max(80),
})

export const getDirectoryData = createServerFn({ method: 'GET' }).handler(
  readDirectoryData,
)

export const getAdminData = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .handler(readAdminData)

export const submitSite = createServerFn({ method: 'POST' })
  .middleware([uploadSizeMiddleware])
  .validator(validateSiteForm)
  .handler(async ({ data }) => {
    await enforcePublicRateLimit('submission', 3, daySeconds)
    const thumbnail = await storeThumbnail(data.image)
    try {
      const result = await createSubmission({
        name: data.name,
        url: data.url,
        description: data.description,
        tags: data.tags,
        thumbnailKey: thumbnail.key,
        thumbnailAlt: `Preview of ${data.name}`,
      })
      if (
        result.previousThumbnailKey &&
        result.previousThumbnailKey !== thumbnail.key
      ) {
        try {
          if (!(await isThumbnailReferenced(result.previousThumbnailKey))) {
            await removeThumbnail(result.previousThumbnailKey)
          }
        } catch (error) {
          console.error({
            event: 'resubmission_thumbnail_cleanup_failed',
            key: result.previousThumbnailKey,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { thumbnailKey: thumbnail.key, reused: result.reused }
    } catch (error) {
      await removeThumbnail(thumbnail.key)
      throw error
    }
  })

export const createDirectorySite = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => {
    const site = validateSiteForm(data)
    if (!(data instanceof FormData)) throw new Error('Expected a site form.')
    const status: 'active' | 'archived' =
      data.get('status') === 'archived' ? 'archived' : 'active'
    return { ...site, status }
  })
  .handler(async ({ data }) => {
    const thumbnail = await storeThumbnail(data.image)
    try {
      const id = await createSite({
        name: data.name,
        url: data.url,
        description: data.description,
        tags: data.tags,
        thumbnailKey: thumbnail.key,
        thumbnailAlt: `Preview of ${data.name}`,
        status: data.status,
        source: 'Manual',
      })
      return { id, thumbnailKey: thumbnail.key }
    } catch (error) {
      await removeThumbnail(thumbnail.key)
      throw error
    }
  })

export const signGuestbook = createServerFn({ method: 'POST' })
  .validator((data) => guestbookInput.parse(data))
  .handler(async ({ data }) => {
    await enforcePublicRateLimit('guestbook', 5, daySeconds)
    await addGuestbookEntry(data)
  })

export const recordSiteVisit = createServerFn({ method: 'POST' })
  .validator((data) => visitInput.parse(data))
  .handler(async ({ data }) => {
    if (!(await isActiveSite(data.slug))) {
      setResponseStatus(404)
      throw new Error('Site not found.')
    }
    const allowed = await enforcePublicRateLimit(
      `visit:${data.slug}`,
      1,
      visitWindowSeconds,
      true,
    )
    if (!allowed) return { recorded: false as const }
    await incrementSiteVisits(data.slug)
    return { recorded: true as const }
  })

export const reviewSubmission = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => moderationInput.parse(data))
  .handler(async ({ data }) => {
    await moderateSubmission(data.id, data.status)
  })

export const updateSiteStatus = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => siteStatusInput.parse(data))
  .handler(async ({ data }) => {
    await setSiteStatus(data.id, data.status)
  })

export const removeGuestbookEntry = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => recordIdInput.parse(data))
  .handler(async ({ data }) => {
    await deleteGuestbookEntry(data.id)
  })

export const reconcileThumbnailStorage = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => reconcileInput.parse(data))
  .handler(({ data }) => reconcileThumbnails(data.deleteOrphans))

export const updateDirectorySite = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator(validateSiteUpdateForm)
  .handler(async ({ data }) => {
    const thumbnail = data.image ? await storeThumbnail(data.image) : undefined
    let result: Awaited<ReturnType<typeof updateSite>>
    try {
      result = await updateSite({
        id: data.id,
        name: data.name,
        url: data.url,
        description: data.description,
        tags: data.tags,
        status: data.status,
        thumbnailKey: thumbnail?.key,
        thumbnailAlt: thumbnail ? `Preview of ${data.name}` : undefined,
      })
    } catch (error) {
      if (thumbnail) await removeThumbnail(thumbnail.key)
      throw error
    }

    if (
      thumbnail &&
      result.previousThumbnailKey &&
      result.previousThumbnailKey !== thumbnail.key
    ) {
      try {
        if (!(await isThumbnailReferenced(result.previousThumbnailKey))) {
          await removeThumbnail(result.previousThumbnailKey)
        }
      } catch (error) {
        console.error({
          event: 'thumbnail_cleanup_failed',
          key: result.previousThumbnailKey,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { id: data.id, thumbnailKey: result.thumbnailKey }
  })

export const saveTag = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => tagDefinitionInput.parse(data))
  .handler(async ({ data }) => {
    await saveTagDefinition(data)
  })

export const mergeTag = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => tagMergeInput.parse(data))
  .handler(async ({ data }) => {
    await mergeTagAsAlias(data.sourceId, data.targetSlug)
  })

function validateSiteForm(data: unknown) {
  if (!(data instanceof FormData)) throw new Error('Expected a site form.')
  const image = data.get('image')
  if (!(image instanceof File)) throw new Error('Choose a thumbnail image.')

  return {
    name: formText(data, 'name', 60),
    url: validHttpUrl(formText(data, 'url', 500)),
    description: formText(data, 'description', 220),
    tags: formTags(data),
    image,
  }
}

function validateSiteUpdateForm(data: unknown) {
  if (!(data instanceof FormData)) throw new Error('Expected a site form.')
  const id = Number(data.get('id'))
  if (!Number.isInteger(id) || id < 1)
    throw new Error('A valid site ID is required.')
  const imageValue = data.get('image')
  const image =
    imageValue instanceof File && imageValue.size > 0 ? imageValue : undefined

  return {
    id,
    name: formText(data, 'name', 60),
    url: validHttpUrl(formText(data, 'url', 500)),
    description: formText(data, 'description', 220),
    tags: formTags(data),
    status:
      data.get('status') === 'archived'
        ? ('archived' as const)
        : ('active' as const),
    image,
  }
}

function formText(data: FormData, key: string, maxLength: number) {
  const value = data.get(key)
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required.`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new Error(`${key} must be ${maxLength} characters or fewer.`)
  }
  return trimmed
}

function validHttpUrl(value: string) {
  return normalizeWebsiteUrl(value)
}

function formTags(data: FormData) {
  const tags = [
    ...new Set(
      formText(data, 'tags', 600)
        .split(',')
        .map((tag) => tag.trim().toLowerCase().replace(/^~+/, '').trim())
        .filter(Boolean),
    ),
  ]
  if (tags.length > 20) throw new Error('tags must contain 20 values or fewer.')
  const overlong = tags.find((tag) => tag.length > 80)
  if (overlong) throw new Error('Each tag must be 80 characters or fewer.')
  const emptySlug = tags.find((tag) => !tagSlug(tag))
  if (emptySlug) {
    throw new Error(`Tag must contain a letter or number: ${emptySlug}`)
  }
  return tags
}

async function enforcePublicRateLimit(
  action: string,
  limit: number,
  windowSeconds: number,
  silentlyIgnore = false,
) {
  const secret = env.ADMIN_SESSION_SECRET
  if (!secret) {
    setResponseStatus(503)
    throw new Error(
      'Public mutations are unavailable until rate limiting is configured.',
    )
  }
  const request = getRequest()
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  const key = await hmacKey(secret, `public:${action}:ip:${ip}`)
  const result = await consumePublicRateLimit(key, limit, windowSeconds)
  if (!result.allowed) {
    if (silentlyIgnore) return false
    setResponseStatus(429)
    setResponseHeader('Retry-After', String(result.retryAfter))
    throw new Error('Too many requests. Try again later.')
  }
  return true
}

async function hmacKey(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
