import { env } from 'cloudflare:workers'
import { createServerFn } from '@tanstack/react-start'
import {
  getRequest,
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server'
import { z } from 'zod'

import {
  addGuestbookEntry,
  createSite,
  createSubmission,
  setGuestbookVisibility,
  moderateSubmission,
  setSiteStatus,
  updateSite,
} from '../db/repository'
import {
  reservePublicAttempts,
  releasePublicAttempts,
} from '../db/public-attempts'
import {
  toggleSiteVote as toggleStoredSiteVote,
  hasOtherActiveVoteOnSite,
  readVisitorVotedSlugs,
} from '../db/vote-repository'
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
import { publishRealtimeEvent } from './realtime'
import {
  getPublicIdentity,
  publicScopeKeys,
  touchPublicIdentity,
} from './public-identity'
import { requireTurnstile, turnstileActions } from './turnstile'

const daySeconds = 24 * 60 * 60
const submissionWindowSeconds = 3 * 60 * 60

const publicRateLimits = {
  submission: {
    identity: 6,
    exactIp: 24,
    network: 120,
    global: 300,
    windowSeconds: submissionWindowSeconds,
  },
  guestbook: {
    identity: 3,
    exactIp: 12,
    network: 80,
    global: 500,
    windowSeconds: daySeconds,
  },
  vote: {
    identity: 30,
    identityDaily: 200,
    exactIp: 120,
    network: 600,
    global: 5000,
    windowSeconds: 60 * 60,
  },
} as const

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
  .validator(validateSiteForm)
  .handler(async ({ data }) => {
    await requireTurnstile(data.turnstileToken, turnstileActions.submission)
    const releaseRateLimit = await enforcePublicRateLimit('submission')
    let thumbnail: Awaited<ReturnType<typeof storeThumbnail>> | undefined
    let result: Awaited<ReturnType<typeof createSubmission>>
    try {
      thumbnail = data.image ? await storeThumbnail(data.image) : undefined
      result = await createSubmission({
        name: data.name,
        url: data.url,
        description: data.description,
        tags: data.tags,
        thumbnailKey: thumbnail?.key ?? null,
        thumbnailAlt: thumbnail ? `Preview of ${data.name}` : null,
      })
      if (
        result.previousThumbnailKey &&
        result.previousThumbnailKey !== thumbnail?.key
      ) {
        console.info({
          event: 'thumbnail_retained_for_recovery',
          key: result.previousThumbnailKey,
        })
      }
    } catch (error) {
      if (thumbnail) await removeThumbnail(thumbnail.key)
      await releaseRateLimit()
      throw error
    }
    try {
      await publishRealtimeEvent({ type: 'submission.changed' })
    } catch (error) {
      console.error({
        event: 'submission_realtime_publish_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return {
      submitted: true as const,
      thumbnailKey: thumbnail?.key ?? null,
      reused: result.reused,
    }
  })

export const createDirectorySite = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => {
    const site = validateSiteForm(data)
    if (!(data instanceof FormData)) throw new Error('Expected a site form.')
    const status = z.enum(['active', 'archived']).parse(data.get('status'))
    return { ...site, status }
  })
  .handler(async ({ data }) => {
    const thumbnail = data.image ? await storeThumbnail(data.image) : undefined
    try {
      const id = await createSite({
        name: data.name,
        url: data.url,
        description: data.description,
        tags: data.tags,
        thumbnailKey: thumbnail?.key ?? null,
        thumbnailAlt: thumbnail ? `Preview of ${data.name}` : null,
        status: data.status,
        source: 'Manual',
      })
      await publishRealtimeEvent({ type: 'directory.changed' })
      return {
        created: true as const,
        id,
        thumbnailKey: thumbnail?.key ?? null,
      }
    } catch (error) {
      if (thumbnail) await removeThumbnail(thumbnail.key)
      throw error
    }
  })

export const signGuestbook = createServerFn({ method: 'POST' })
  .validator((data) => {
    if (!data || typeof data !== 'object')
      throw new Error('Invalid guestbook entry.')
    const input = data as {
      name?: unknown
      message?: unknown
      turnstileToken?: unknown
    }
    return {
      ...guestbookInput.parse({ name: input.name, message: input.message }),
      turnstileToken: input.turnstileToken,
    }
  })
  .handler(async ({ data }) => {
    await requireTurnstile(data.turnstileToken, turnstileActions.guestbook)
    const releaseRateLimit = await enforcePublicRateLimit('guestbook')
    try {
      await addGuestbookEntry({ name: data.name, message: data.message })
    } catch (error) {
      await releaseRateLimit()
      throw error
    }
    try {
      await publishRealtimeEvent({ type: 'guestbook.changed' })
    } catch (error) {
      console.error({
        event: 'guestbook_realtime_publish_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

export const recordSiteVisit = createServerFn({ method: 'POST' })
  .validator((data) => visitInput.parse(data))
  .handler(({ data }) =>
    deferVisitAccounting({ request: getRequest(), slug: data.slug }),
  )

export const getMyVotedSlugs = createServerFn({ method: 'GET' }).handler(
  async () => {
    const identity = await getPublicIdentity()
    const keys = await publicScopeKeys('vote', identity, getRequest())
    return { slugs: await readVisitorVotedSlugs(env.DB, keys.voteIdentity) }
  },
)

const voteInput = z.object({
  slug: z.string().min(1).max(100),
  requestId: z.string().uuid().optional(),
  turnstileToken: z.string().max(2048).optional(),
})

export const toggleSiteVote = createServerFn({ method: 'POST' })
  .validator((data) => voteInput.parse(data))
  .handler(async ({ data }) => {
    const identity = await getPublicIdentity()
    const requestId = data.requestId ?? crypto.randomUUID()
    const keys = await publicScopeKeys('vote', identity, getRequest())
    const identityScheme = `cookie-v1:${keys.exactIp}`
    const isRepeatIpVote = await hasOtherActiveVoteOnSite(
      env.DB,
      data.slug,
      identityScheme,
      keys.voteIdentity,
    )
    if (isRepeatIpVote && env.TURNSTILE_SECRET) {
      if (!data.turnstileToken) {
        return {
          requireChallenge: true as const,
          voted: false,
          votes: undefined,
        }
      }
      await requireTurnstile(data.turnstileToken, turnstileActions.vote)
    }
    const releaseRateLimit = await enforcePublicRateLimit(
      'vote',
      identity,
      keys,
    )
    let result: Awaited<ReturnType<typeof toggleStoredSiteVote>>
    try {
      result = await toggleStoredSiteVote(env.DB, {
        slug: data.slug,
        visitorKey: keys.voteIdentity,
        requestId,
        identityScheme,
      })
      if (!result.siteFound)
        throw new Error('That site is not available to vote on.')
    } catch (error) {
      await releaseRateLimit()
      throw error
    }
    try {
      await publishRealtimeEvent({
        type: 'site.voted',
        slug: data.slug,
        votes: result.votes ?? 0,
      })
    } catch (error) {
      console.error({
        event: 'vote_realtime_publish_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await touchPublicIdentity(identity.key, result.updated)
    return {
      requireChallenge: false as const,
      voted: result.voted,
      votes: result.votes,
    }
  })

export const reviewSubmission = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => moderationInput.parse(data))
  .handler(async ({ data }) => {
    await moderateSubmission(data.id, data.status)
    await publishRealtimeEvent({ type: 'directory.changed' })
  })

export const updateSiteStatus = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => siteStatusInput.parse(data))
  .handler(async ({ data }) => {
    await setSiteStatus(data.id, data.status)
    await publishRealtimeEvent({ type: 'directory.changed' })
  })

export const setGuestbookEntryVisibility = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => guestbookVisibilityInput.parse(data))
  .handler(async ({ data }) => {
    const result = await setGuestbookVisibility(data.id, data.hidden)
    await publishRealtimeEvent({ type: 'guestbook.changed' })
    return result
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
    await publishRealtimeEvent({ type: 'directory.changed' })
    return { id: data.id, thumbnailKey: result.thumbnailKey }
  })

export const saveTag = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => tagDefinitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await createTaxonomyService(env).correctTag({
      ...data,
      actorId: context.admin.username,
    })
    await publishRealtimeEvent({ type: 'directory.changed' })
    return result
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
    const result = await createTaxonomyService(env).correctMerge({
      sourceId: data.sourceId,
      targetId: target.id,
      actorId: context.admin.username,
    })
    await publishRealtimeEvent({ type: 'directory.changed' })
    return result
  })

function validateSiteForm(data: unknown) {
  if (!(data instanceof FormData)) throw new Error('Expected a site form.')
  const image = optionalFormFile(data, 'image')

  return {
    name: formText(data, 'name', 60),
    url: validHttpUrl(formText(data, 'url', 500)),
    description: formText(data, 'description', 220),
    tags: formTags(data),
    image,
    turnstileToken: data.get('turnstileToken'),
  }
}

function optionalFormFile(data: FormData, name: string) {
  const value = data.get(name)
  if (value === null || value === '') return undefined
  if (!(value instanceof File))
    throw new Error('Thumbnail image must be a file.')
  return value.size > 0 ? value : undefined
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
  const image = optionalFormFile(data, 'image')

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
  action: keyof typeof publicRateLimits,
  identity?: Awaited<ReturnType<typeof getPublicIdentity>>,
  keys?: Awaited<ReturnType<typeof publicScopeKeys>>,
) {
  identity ??= await getPublicIdentity()
  keys ??= await publicScopeKeys(action, identity, getRequest())
  const limits = publicRateLimits[action]
  const reservationId = crypto.randomUUID()
  const scopes = [
    {
      scope: 'identity',
      key: keys.identity,
      limit: limits.identity,
      windowSeconds: limits.windowSeconds,
    },
    ...(action === 'vote'
      ? [
          {
            scope: 'identity_daily',
            key: keys.identity,
            limit: publicRateLimits.vote.identityDaily,
            windowSeconds: daySeconds,
          },
        ]
      : []),
    {
      scope: 'exact_ip',
      key: keys.exactIp,
      limit: limits.exactIp,
      windowSeconds: limits.windowSeconds,
    },
    {
      scope: 'network',
      key: keys.network,
      limit: limits.network,
      windowSeconds: limits.windowSeconds,
    },
    {
      scope: 'global',
      key: keys.global,
      limit: limits.global,
      windowSeconds: limits.windowSeconds,
    },
  ]
  const result = await reservePublicAttempts(env.DB, {
    action,
    reservationId,
    scopes,
  })
  if (!result.allowed) {
    setResponseStatus(429)
    setResponseHeader('Retry-After', String(result.retryAfter))
    throw new Error('Too many requests. Try again later.')
  }
  return async () => {
    try {
      await releasePublicAttempts(env.DB, reservationId)
    } catch (error) {
      console.error({
        event: 'rate_limit_refund_failed',
        action,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
