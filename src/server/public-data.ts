import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'

import {
  normalizeFilterTagList,
  publicDirectorySearchMaxLength,
  publicFilterTagLimit,
  publicTagSearchMaxLength,
  tagInputMaxLength,
} from '../data/tags'

import {
  readPublicDirectoryPage,
  readPublicPopularPage,
  readPublicSiteDetail,
  readPublicSurprise,
  readPublicSupportData,
  readPublicTagPage,
  readTagSuggestions,
} from '../db/public-repository'

const filterTagInput = z
  .string()
  .max(tagInputMaxLength + 1)
  .refine(
    (tag) =>
      (tag.startsWith('~') ? tag.slice(1) : tag).length <= tagInputMaxLength,
    `Tag values must be ${tagInputMaxLength} characters or fewer.`,
  )
const tagsInput = z
  .array(filterTagInput)
  .max(publicFilterTagLimit)
  .transform(normalizeFilterTagList)
  .default([])
const directoryInput = z.object({
  query: z.string().max(publicDirectorySearchMaxLength).default(''),
  include: tagsInput,
  exclude: tagsInput,
  sort: z
    .enum(['popular', 'views', 'newest', 'oldest', 'tags', 'az', 'za'])
    .default('popular'),
  page: z.number().int().min(0).max(10_000).default(0),
})
const tagPageInput = z.object({
  query: z.string().max(publicTagSearchMaxLength).default(''),
  include: tagsInput,
  exclude: tagsInput,
  page: z.number().int().min(0).max(10_000).default(0),
})
const surpriseInput = directoryInput.pick({
  query: true,
  include: true,
  exclude: true,
})
const tagSuggestionInput = z.object({
  query: z.string().max(tagInputMaxLength).default(''),
  selected: tagsInput,
  limit: z.number().int().min(1).max(20).default(8),
})

export const getPublicDirectoryPage = createServerFn({ method: 'POST' })
  .validator((data) => directoryInput.parse(data))
  .handler(({ data }) => readPublicDirectoryPage(data))

export const getPublicSurprise = createServerFn({ method: 'POST' })
  .validator((data) => surpriseInput.parse(data))
  .handler(({ data }) => readPublicSurprise(data))

export const getPublicPopularPage = createServerFn({ method: 'POST' })
  .validator((data) => z.number().int().min(0).max(10_000).parse(data))
  .handler(({ data }) => readPublicPopularPage(data))

export const getPublicSupportData = createServerFn({ method: 'GET' }).handler(
  () => readPublicSupportData(),
)

export const getTurnstileConfig = createServerFn({ method: 'GET' }).handler(
  () => {
    const hostname = new URL(getRequest().url).hostname.toLowerCase()
    const configuredHostnames: unknown = Reflect.get(env, 'TURNSTILE_HOSTNAMES')
    const configuredSitekey: unknown = Reflect.get(env, 'TURNSTILE_SITEKEY')
    const approvedHostnames =
      typeof configuredHostnames === 'string'
        ? configuredHostnames
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
        : []
    return {
      sitekey:
        approvedHostnames.includes(hostname) &&
        typeof configuredSitekey === 'string'
          ? configuredSitekey
          : '',
    }
  },
)

export const getPublicTagPage = createServerFn({ method: 'GET' })
  .validator((data) => tagPageInput.parse(data))
  .handler(({ data }) => readPublicTagPage(data))

export const getPublicSiteDetail = createServerFn({ method: 'POST' })
  .validator((data) => z.string().min(1).max(100).parse(data))
  .handler(({ data }) => readPublicSiteDetail(data))

export const getTagSuggestions = createServerFn({ method: 'GET' })
  .validator((data) => tagSuggestionInput.parse(data))
  .handler(({ data }) => readTagSuggestions(data))
