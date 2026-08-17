import { queryOptions } from '@tanstack/react-query'

import {
  getAdminGuestbook,
  getAdminOverview,
  getAdminSite,
  getAdminSites,
  getAdminSubmissions,
  getAdminTags,
} from '../server/admin-data'
import {
  getTaxonomyAttempts,
  getTaxonomyAuditEvents,
  getTaxonomyBatches,
  getTaxonomyCandidates,
  getTaxonomyDashboard,
  getTaxonomyJobs,
  getTaxonomyLocks,
  getTaxonomyPolicies,
  getTaxonomyProviders,
} from '../server/taxonomy-admin'
import {
  getPublicDirectoryPage,
  getPublicPopularPage,
  getPublicSiteDetail,
  getPublicSupportData,
  getPublicTagPage,
  getTagSuggestions,
} from '../server/public-data'

import type { PublicDirectoryInput } from '../db/public-repository'

const adminQueryFreshness = {
  staleTime: 0,
  gcTime: 5 * 60_000,
  refetchOnMount: true,
  refetchOnReconnect: true,
  refetchOnWindowFocus: true,
} as const

export const directoryQueryOptions = (input: PublicDirectoryInput) =>
  queryOptions({
    queryKey: ['oddweb', 'public', 'directory', input],
    queryFn: () => getPublicDirectoryPage({ data: input }),
    staleTime: 30_000,
  })

export const popularQueryOptions = (page: number) =>
  queryOptions({
    queryKey: ['oddweb', 'public', 'popular', page],
    queryFn: () => getPublicPopularPage({ data: page }),
    staleTime: 30_000,
  })

export const publicSupportQueryOptions = () =>
  queryOptions({
    queryKey: ['oddweb', 'public', 'support'],
    queryFn: () => getPublicSupportData(),
    staleTime: 30_000,
  })

export const tagPageQueryOptions = (input: {
  query: string
  include: string[]
  exclude: string[]
  page: number
}) =>
  queryOptions({
    queryKey: ['oddweb', 'public', 'tags', input],
    queryFn: () => getPublicTagPage({ data: input }),
    staleTime: 30_000,
  })

export const siteDetailQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ['oddweb', 'public', 'site', slug],
    queryFn: () => getPublicSiteDetail({ data: slug }),
    staleTime: 30_000,
  })

export const tagSuggestionsQueryOptions = (input: {
  query: string
  selected: string[]
  limit?: number
}) =>
  queryOptions({
    queryKey: ['oddweb', 'tags', 'suggestions', input],
    queryFn: () =>
      getTagSuggestions({ data: { ...input, limit: input.limit || 8 } }),
    staleTime: 30_000,
  })

export const adminOverviewQueryOptions = () =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'overview'],
    queryFn: () => getAdminOverview(),
    ...adminQueryFreshness,
  })

export const adminSubmissionsQueryOptions = (
  page: number,
  status: 'pending' | 'approved' | 'rejected' | 'all',
) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'submissions', { page, status }],
    queryFn: () => getAdminSubmissions({ data: { page, status } }),
    ...adminQueryFreshness,
  })

export const adminSitesQueryOptions = (input: {
  page: number
  status: 'active' | 'archived' | 'all'
  search: string
  includeTags: string[]
  excludeTags: string[]
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'sites', input],
    queryFn: () => getAdminSites({ data: input }),
    ...adminQueryFreshness,
  })

export const adminSiteQueryOptions = (id: number) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'site', id],
    queryFn: () => getAdminSite({ data: { id } }),
    ...adminQueryFreshness,
  })

export const adminTagsQueryOptions = (page: number, search: string) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'tags', { page, search }],
    queryFn: () => getAdminTags({ data: { page, search } }),
    ...adminQueryFreshness,
  })

export const adminGuestbookQueryOptions = (page: number) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'guestbook', { page }],
    queryFn: () => getAdminGuestbook({ data: { page } }),
    ...adminQueryFreshness,
  })

export const taxonomyDashboardQueryOptions = () =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'dashboard'],
    queryFn: () => getTaxonomyDashboard(),
    ...adminQueryFreshness,
  })

export const taxonomyProvidersQueryOptions = (input: {
  page: number
  pageSize: number
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'providers', input],
    queryFn: () => getTaxonomyProviders({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyPoliciesQueryOptions = (input: {
  page: number
  pageSize: number
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'policies', input],
    queryFn: () => getTaxonomyPolicies({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyJobsQueryOptions = (input: {
  page: number
  pageSize: number
  status:
    | 'pending'
    | 'leased'
    | 'retry_wait'
    | 'succeeded'
    | 'settled'
    | 'obsolete'
    | 'dead'
    | 'cancelled'
    | 'degraded'
    | null
  kind:
    'classify_site' | 'reassess_concept' | 'apply_ontology' | 'rollback' | null
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'jobs', input],
    queryFn: () => getTaxonomyJobs({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyAttemptsQueryOptions = (input: {
  page: number
  pageSize: number
  jobId: string | null
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'attempts', input],
    queryFn: () => getTaxonomyAttempts({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyCandidatesQueryOptions = (input: {
  page: number
  pageSize: number
  status: 'proposed' | 'accepted' | 'rejected' | 'deferred' | 'conflict' | null
  kind:
    'existing_tag' | 'novel_concept' | 'alias' | 'merge' | 'parent_edge' | null
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'candidates', input],
    queryFn: () => getTaxonomyCandidates({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyAuditQueryOptions = (input: {
  page: number
  pageSize: number
  batchId: string | null
  entityType: string | null
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'audit', input],
    queryFn: () => getTaxonomyAuditEvents({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyBatchesQueryOptions = (input: {
  page: number
  pageSize: number
  status:
    | 'planned'
    | 'applying'
    | 'applied'
    | 'failed'
    | 'rolling_back'
    | 'rolled_back'
    | 'partial'
    | null
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'batches', input],
    queryFn: () => getTaxonomyBatches({ data: input }),
    ...adminQueryFreshness,
  })

export const taxonomyLocksQueryOptions = (input: {
  page: number
  pageSize: number
  state: 'active' | 'released' | 'all'
}) =>
  queryOptions({
    queryKey: ['oddweb', 'admin', 'taxonomy', 'locks', input],
    queryFn: () => getTaxonomyLocks({ data: input }),
    ...adminQueryFreshness,
  })
