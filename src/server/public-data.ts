import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  readPublicDirectoryPage,
  readPublicPopularPage,
  readPublicSiteDetail,
  readPublicSupportData,
  readPublicTagPage,
  readTagSuggestions,
} from '../db/public-repository'

const tagsInput = z.array(z.string().max(80)).max(20).default([])
const directoryInput = z.object({
  query: z.string().max(120).default(''),
  include: tagsInput,
  exclude: tagsInput,
  sort: z
    .enum(['popular', 'newest', 'oldest', 'tags', 'az', 'za'])
    .default('popular'),
  page: z.number().int().min(0).max(10_000).default(0),
})
const tagPageInput = z.object({
  query: z.string().max(80).default(''),
  include: tagsInput,
  exclude: tagsInput,
  page: z.number().int().min(0).max(10_000).default(0),
})
const tagSuggestionInput = z.object({
  query: z.string().max(80).default(''),
  selected: tagsInput,
  limit: z.number().int().min(1).max(20).default(8),
})

export const getPublicDirectoryPage = createServerFn({ method: 'GET' })
  .validator((data) => directoryInput.parse(data))
  .handler(({ data }) => readPublicDirectoryPage(data))

export const getPublicPopularPage = createServerFn({ method: 'GET' })
  .validator((data) => z.number().int().min(0).max(10_000).parse(data))
  .handler(({ data }) => readPublicPopularPage(data))

export const getPublicSupportData = createServerFn({ method: 'GET' }).handler(
  readPublicSupportData,
)

export const getPublicTagPage = createServerFn({ method: 'GET' })
  .validator((data) => tagPageInput.parse(data))
  .handler(({ data }) => readPublicTagPage(data))

export const getPublicSiteDetail = createServerFn({ method: 'GET' })
  .validator((data) => z.string().min(1).max(100).parse(data))
  .handler(({ data }) => readPublicSiteDetail(data))

export const getTagSuggestions = createServerFn({ method: 'GET' })
  .validator((data) => tagSuggestionInput.parse(data))
  .handler(({ data }) => readTagSuggestions(data))
