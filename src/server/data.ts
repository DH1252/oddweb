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
  setGuestbookVisibility,
  moderateSubmission,
  setSiteStatus,
  updateSite,
} from '../db/repository'
import { createTaxonomyService } from '../taxonomy'
import { adminAuthMiddleware } from './auth'
import {
  reconcileThumbnails,
  removeThumbnail,
  storeThumbnail,
} from './thumbnails'
import { tagSlug } from '../data/tags'
import { normalizeWebsiteUrl } from '../lib/website-url'
import { deferVisitAccounting } from './visit-accounting'

const daySeconds = 24 * 60 * 60
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

const guestbookVisibilityInput = z.object({
  id: z.number().int().positive(),
  hidden: z.boolean(),
})
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
        console.info({
          event: 'thumbnail_retained_for_recovery',
          key: result.previousThumbnailKey,
        })
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
  .handler(({ data }) =>
    deferVisitAccounting({ request: getRequest(), slug: data.slug }),
  )

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

export const setGuestbookEntryVisibility = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => guestbookVisibilityInput.parse(data))
  .handler(async ({ data }) => {
    await setGuestbookVisibility(data.id, data.hidden)
  })

export const reconcileThumbnailStorage = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) =>
    z
      .object({
        cursor: z.string().max(8_192).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .optional()
      .parse(data),
  )
  .handler(({ data }) => reconcileThumbnails(data))

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
        summary: data.summary,
        categories: data.categories,
        poster: data.poster,
        notes: data.notes,
        facts: data.facts,
        accent: data.accent,
        tags: data.tags,
        status: data.status,
        thumbnailKey: thumbnail?.key,
        thumbnailAlt: data.thumbnailAlt,
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
      console.info({
        event: 'thumbnail_retained_for_recovery',
        key: result.previousThumbnailKey,
      })
    }
    return { id: data.id, thumbnailKey: result.thumbnailKey }
  })

export const saveTag = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => tagDefinitionInput.parse(data))
  .handler(async ({ data, context }) => {
    return createTaxonomyService(env).correctTag({
      ...data,
      actorId: context.admin.username,
    })
  })

export const mergeTag = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => tagMergeInput.parse(data))
  .handler(async ({ data, context }) => {
    const target = await env.DB.prepare(
      'SELECT id FROM tags WHERE slug = ? AND canonical = 1',
    )
      .bind(data.targetSlug)
      .first<{ id: number }>()
    if (!target) throw new Error('Valid source and target tags are required.')
    return createTaxonomyService(env).correctMerge({
      sourceId: data.sourceId,
      targetId: target.id,
      actorId: context.admin.username,
    })
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

function formList(
  data: FormData,
  key: string,
  maxItems: number,
  maxItemLength: number,
) {
  const values = formText(data, key, maxItems * (maxItemLength + 1))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!values.length || values.length > maxItems)
    throw new Error(`${key} must contain 1-${maxItems} values.`)
  if (values.some((value) => value.length > maxItemLength))
    throw new Error(
      `${key} values must be ${maxItemLength} characters or fewer.`,
    )
  return [...new Set(values)]
}

function formLines(
  data: FormData,
  key: string,
  maxItems: number,
  maxItemLength: number,
) {
  const values = formText(data, key, maxItems * (maxItemLength + 1))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (!values.length || values.length > maxItems)
    throw new Error(`${key} must contain 1-${maxItems} lines.`)
  if (values.some((value) => value.length > maxItemLength))
    throw new Error(
      `${key} lines must be ${maxItemLength} characters or fewer.`,
    )
  return values
}

function formFacts(data: FormData) {
  return formLines(data, 'facts', 12, 240).map((line) => {
    const separator = line.indexOf(':')
    if (separator < 1 || separator === line.length - 1)
      throw new Error('Each fact must use Label: Value format.')
    return {
      label: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    }
  })
}

const siteAccents = new Set([
  'from-[#63396d] to-[#d27a3e]',
  'from-[#315c51] to-[#79a381]',
  'from-[#38578d] to-[#eabc52]',
  'from-[#527797] to-[#d8a866]',
  'from-[#dc4f33] to-[#e9b640]',
  'from-[#586f44] to-[#c4a866]',
  'from-[#5b376b] to-[#b06970]',
  'from-[#704d3f] to-[#d28f61]',
  'from-[#42687c] to-[#8ca8aa]',
  'from-[#8d3b2b] to-[#d37237]',
])

function validAccent(value: string) {
  if (!siteAccents.has(value)) throw new Error('Choose a valid accent.')
  return value
}

function validateSiteUpdateForm(data: unknown) {
  if (!(data instanceof FormData)) throw new Error('Expected a site form.')
  const id = Number(data.get('id'))
  if (!Number.isInteger(id) || id < 1)
    throw new Error('A valid site ID is required.')
  const imageValue = data.get('image')
  const image =
    imageValue instanceof File && imageValue.size > 0 ? imageValue : undefined

  const statusValue = data.get('status')
  if (statusValue !== 'active' && statusValue !== 'archived') {
    throw new Error('A valid site status is required.')
  }
  const status: 'active' | 'archived' = statusValue
  return {
    id,
    name: formText(data, 'name', 60),
    url: validHttpUrl(formText(data, 'url', 500)),
    description: formText(data, 'description', 220),
    summary: formText(data, 'summary', 400),
    categories: formList(data, 'categories', 12, 60),
    poster: formText(data, 'poster', 120),
    notes: formLines(data, 'notes', 12, 600),
    facts: formFacts(data),
    accent: validAccent(formText(data, 'accent', 80)),
    thumbnailAlt: formText(data, 'thumbnailAlt', 180),
    tags: formTags(data),
    status,
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
