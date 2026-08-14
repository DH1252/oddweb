import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  readAdminGuestbook,
  readAdminOverview,
  readAdminSite,
  readAdminSites,
  readAdminSubmissions,
  readAdminTags,
} from '../db/admin-repository'
import { adminAuthMiddleware } from './auth'

const page = z.number().int().nonnegative()
const tagList = z.array(z.string().trim().min(1).max(80)).max(20)

export const getAdminOverview = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .handler(readAdminOverview)

export const getAdminSubmissions = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) =>
    z
      .object({
        page,
        status: z.enum(['pending', 'approved', 'rejected', 'all']),
      })
      .parse(data),
  )
  .handler(({ data }) => readAdminSubmissions(data))

export const getAdminSites = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) =>
    z
      .object({
        page,
        status: z.enum(['active', 'archived', 'all']),
        search: z.string().trim().max(200),
        includeTags: tagList,
        excludeTags: tagList,
      })
      .parse(data),
  )
  .handler(({ data }) => readAdminSites(data))

export const getAdminSite = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) =>
    z.object({ id: z.number().int().positive() }).parse(data),
  )
  .handler(async ({ data }) => {
    const site = await readAdminSite(data.id)
    if (!site) throw new Error('Site not found.')
    return site
  })

export const getAdminTags = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) =>
    z.object({ page, search: z.string().trim().max(200) }).parse(data),
  )
  .handler(({ data }) => readAdminTags(data))

export const getAdminGuestbook = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => z.object({ page }).parse(data))
  .handler(({ data }) => readAdminGuestbook(data))
