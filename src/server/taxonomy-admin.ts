import { env } from 'cloudflare:workers'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  listTaxonomyAttempts,
  listTaxonomyAuditEvents,
  listTaxonomyBatches,
  listTaxonomyCandidates,
  listTaxonomyJobs,
  listTaxonomyLocks,
  listTaxonomyPolicies,
  listTaxonomyProviders,
  readTaxonomyDashboard,
} from '../db/taxonomy-admin-repository'
import { createTaxonomyService, dispatchTaxonomyOutbox } from '../taxonomy'
import { adminAuthMiddleware } from './auth'
import { publishRealtimeEvent } from './realtime'
import {
  taxonomyPolicyRevisionSchema,
  taxonomyProviderCreateSchema,
  taxonomyProviderHostAllowlist,
  taxonomyProviderUpdateSchema,
} from './taxonomy-admin-validation'

export {
  taxonomyPolicyCreateSchema,
  taxonomyPolicyRevisionSchema,
  taxonomyProviderCreateSchema,
  taxonomyProviderHostAllowlist,
  taxonomyProviderUpdateSchema,
} from './taxonomy-admin-validation'

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const boundedText = z.string().trim().min(1).max(500)
const opaqueId = z.string().trim().min(1).max(200)
const pagination = {
  page: z.number().int().min(0).max(100_000),
  pageSize: z.number().int().min(1).max(100),
}

const providerIdInput = z.strictObject({ providerConfigId: positiveId })
const policyIdInput = z.strictObject({ policyConfigId: positiveId })
const modeInput = z.strictObject({
  mode: z.enum(['disabled', 'shadow', 'gradual', 'autonomous', 'degraded']),
})
const backfillInput = z.strictObject({
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
})
const jobsInput = z.strictObject({
  ...pagination,
  status: z
    .enum([
      'pending',
      'leased',
      'retry_wait',
      'succeeded',
      'settled',
      'obsolete',
      'dead',
      'cancelled',
      'degraded',
    ])
    .nullable(),
  kind: z
    .enum(['classify_site', 'reassess_concept', 'apply_ontology', 'rollback'])
    .nullable(),
})
const candidatesInput = z.strictObject({
  ...pagination,
  status: z
    .enum(['proposed', 'accepted', 'rejected', 'deferred', 'conflict'])
    .nullable(),
  kind: z
    .enum(['existing_tag', 'novel_concept', 'alias', 'merge', 'parent_edge'])
    .nullable(),
})
const candidateDecisionInput = z.strictObject({
  candidateId: opaqueId,
  decision: z.enum(['accepted', 'rejected', 'deferred', 'conflict']),
  reason: boundedText,
})
const attemptsInput = z.strictObject({
  ...pagination,
  jobId: opaqueId.nullable(),
})
const auditInput = z.strictObject({
  ...pagination,
  batchId: opaqueId.nullable(),
  entityType: z.string().trim().min(1).max(100).nullable(),
})
const batchesInput = z.strictObject({
  ...pagination,
  status: z
    .enum([
      'planned',
      'applying',
      'applied',
      'failed',
      'rolling_back',
      'rolled_back',
      'partial',
    ])
    .nullable(),
})
const locksInput = z.strictObject({
  ...pagination,
  state: z.enum(['active', 'released', 'all']),
})
const lockCreateInput = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('site_assignment'),
    siteId: positiveId,
    tagId: positiveId,
    reason: boundedText,
  }),
  z.strictObject({
    scope: z.literal('tag'),
    tagId: positiveId,
    reason: boundedText,
  }),
  z.strictObject({
    scope: z.literal('alias'),
    tagId: positiveId,
    alias: z.string().trim().min(1).max(80),
    reason: boundedText,
  }),
  z.strictObject({
    scope: z.literal('merge'),
    tagId: positiveId,
    relatedTagId: positiveId,
    reason: boundedText,
  }),
  z.strictObject({
    scope: z.literal('parent_edge'),
    tagId: positiveId,
    relatedTagId: positiveId,
    reason: boundedText,
  }),
])
const lockReleaseInput = z.strictObject({ id: opaqueId, reason: boundedText })
const retryInput = z.strictObject({
  jobIds: z.array(opaqueId).min(1).max(100),
})
const rollbackEventInput = z.strictObject({ eventId: opaqueId })
const rollbackSiteInput = z.strictObject({ siteId: positiveId })
const rollbackBatchInput = z.strictObject({ batchId: opaqueId })

function service() {
  return createTaxonomyService(env)
}

async function controlPlaneSnapshot() {
  const [dashboard, providers, policies] = await Promise.all([
    readTaxonomyDashboard(env.DB),
    listTaxonomyProviders({ page: 0, pageSize: 20 }, env.DB),
    listTaxonomyPolicies({ page: 0, pageSize: 20 }, env.DB),
  ])
  return { dashboard, providers, policies }
}

async function publishTaxonomyChange(directoryChanged = false) {
  await publishRealtimeEvent({ type: 'taxonomy.changed' })
  if (directoryChanged) {
    await publishRealtimeEvent({ type: 'directory.changed' })
  }
}

export const getTaxonomyDashboard = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .handler(() => readTaxonomyDashboard(env.DB))

export const getTaxonomyProviders = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => z.strictObject(pagination).parse(data))
  .handler(({ data }) => listTaxonomyProviders(data, env.DB))

export const createTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => taxonomyProviderCreateSchema.parse(data))
  .handler(async ({ data, context }) => {
    const id = await service().createProviderConfig({
      ...data,
      dialect: data.dialect ?? undefined,
      credential: data.apiKey,
      keyVersion: 1,
      enabled: false,
      actorId: context.admin.username,
    })
    const result = !data.enabled
      ? { id, enabled: false, enableError: null }
      : await (async () => {
          try {
            return {
              id,
              enabled: await service().enableProvider(
                id,
                context.admin.username,
              ),
              enableError: null,
            }
          } catch (error) {
            return {
              id,
              enabled: false,
              enableError:
                error instanceof Error
                  ? error.message
                  : 'Provider test failed; the revision remains disabled.',
            }
          }
        })()
    await publishTaxonomyChange()
    return { ...result, ...(await controlPlaneSnapshot()) }
  })

export const updateTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => taxonomyProviderUpdateSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { apiKey, providerConfigId, ...patch } = data
    const updated = await service().updateProviderConfig({
      providerConfigId,
      name: patch.name,
      endpoint: patch.endpoint,
      model: patch.model,
      dialect:
        data.providerKind === 'gemini' ? null : (patch.dialect ?? undefined),
      routingGroup: patch.routingGroup,
      routingRole: patch.routingRole,
      routingPriority: patch.routingPriority,
      timeoutMs: patch.timeoutMs,
      credential: apiKey,
      actorId: context.admin.username,
    })
    if (updated) await publishTaxonomyChange()
    return { updated, ...(await controlPlaneSnapshot()) }
  })

export const deleteTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => providerIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const deleted = await service().deleteProviderConfig(
      data.providerConfigId,
      context.admin.username,
    )
    if (deleted) await publishTaxonomyChange()
    return { deleted, ...(await controlPlaneSnapshot()) }
  })

export const testTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => providerIdInput.parse(data))
  .handler(({ data }) =>
    service().testProvider(
      data.providerConfigId,
      taxonomyProviderHostAllowlist,
    ),
  )

export const disableTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => providerIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const disabled = await service().disableProvider(
      data.providerConfigId,
      context.admin.username,
    )
    if (disabled) await publishTaxonomyChange()
    return { disabled, ...(await controlPlaneSnapshot()) }
  })

export const enableTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => providerIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const enabled = await service().enableProvider(
      data.providerConfigId,
      context.admin.username,
    )
    if (enabled) await publishTaxonomyChange()
    return { enabled, ...(await controlPlaneSnapshot()) }
  })

export const activateTaxonomyProvider = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => providerIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const activated = await service().activateProvider(
      data.providerConfigId,
      context.admin.username,
    )
    if (activated) await publishTaxonomyChange()
    return { activated, ...(await controlPlaneSnapshot()) }
  })

export const getTaxonomyPolicies = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => z.strictObject(pagination).parse(data))
  .handler(({ data }) => listTaxonomyPolicies(data, env.DB))

export const createTaxonomyPolicy = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => taxonomyPolicyRevisionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supersedesPolicyConfigId, ...policy } = data
    const id = await service().createPolicyRevision(
      policy,
      context.admin.username,
      supersedesPolicyConfigId,
    )
    await publishTaxonomyChange()
    return { id, ...(await controlPlaneSnapshot()) }
  })

export const activateTaxonomyPolicy = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => policyIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const activated = await service().activatePolicy(
      data.policyConfigId,
      context.admin.username,
    )
    if (activated) await publishTaxonomyChange()
    return { activated, ...(await controlPlaneSnapshot()) }
  })

export const transitionTaxonomyMode = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => modeInput.parse(data))
  .handler(async ({ data, context }) => {
    await service().setMode(data.mode, context.admin.username)
    await publishTaxonomyChange()
    return { mode: data.mode, dashboard: await readTaxonomyDashboard(env.DB) }
  })

export const triggerTaxonomyBackfill = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => backfillInput.parse(data))
  .handler(async ({ data }) => {
    const result = await service().backfill(data.cursor, data.limit)
    const dispatched = result.enqueued
      ? await dispatchTaxonomyOutbox(env, { limit: 100 })
      : 0
    if (result.enqueued || dispatched) await publishTaxonomyChange()
    return { ...result, dispatched }
  })

export const getTaxonomyJobs = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => jobsInput.parse(data))
  .handler(({ data }) => listTaxonomyJobs(data, env.DB))

export const getTaxonomyAttempts = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => attemptsInput.parse(data))
  .handler(({ data }) => listTaxonomyAttempts(data, env.DB))

export const getTaxonomyCandidates = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => candidatesInput.parse(data))
  .handler(({ data }) => listTaxonomyCandidates(data, env.DB))

export const decideTaxonomyCandidate = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => candidateDecisionInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await service().decideCandidate({
      ...data,
      actorId: context.admin.username,
    })
    if (result.decided) await publishTaxonomyChange()
    return result
  })

export const getTaxonomyAuditEvents = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => auditInput.parse(data))
  .handler(({ data }) => listTaxonomyAuditEvents(data, env.DB))

export const getTaxonomyBatches = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => batchesInput.parse(data))
  .handler(({ data }) => listTaxonomyBatches(data, env.DB))

export const getTaxonomyLocks = createServerFn({ method: 'GET' })
  .middleware([adminAuthMiddleware])
  .validator((data) => locksInput.parse(data))
  .handler(({ data }) => listTaxonomyLocks(data, env.DB))

export const createTaxonomyLock = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => lockCreateInput.parse(data))
  .handler(async ({ data, context }) => {
    const id = await service().createLock({
      ...data,
      actorId: context.admin.username,
    })
    await publishTaxonomyChange()
    return { id }
  })

export const releaseTaxonomyLock = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => lockReleaseInput.parse(data))
  .handler(async ({ data, context }) => {
    const released = await service().releaseLock(
      data.id,
      context.admin.username,
      data.reason,
    )
    if (released) await publishTaxonomyChange()
    return { released }
  })

export const retryTaxonomyJobs = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => retryInput.parse(data))
  .handler(async ({ data }) => {
    const retried = await service().retryJobs(data.jobIds)
    const dispatched = retried
      ? await dispatchTaxonomyOutbox(env, { limit: 100 })
      : 0
    if (retried || dispatched) await publishTaxonomyChange()
    return { retried, dispatched }
  })

export const dispatchTaxonomyOutboxNow = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .handler(async () => {
    const dispatched = await dispatchTaxonomyOutbox(env, { limit: 100 })
    if (dispatched) await publishTaxonomyChange()
    return { dispatched }
  })

export const resetTaxonomyCircuit = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .handler(async ({ context }) => {
    await service().resetCircuit(context.admin.username)
    await publishTaxonomyChange()
    return {
      mode: 'shadow' as const,
      circuitState: 'closed' as const,
      dashboard: await readTaxonomyDashboard(env.DB),
    }
  })

export const rollbackTaxonomyEvent = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => rollbackEventInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await service().rollbackEvent(
      data.eventId,
      context.admin.username,
    )
    await publishTaxonomyChange(true)
    return result
  })

export const rollbackTaxonomySite = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => rollbackSiteInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await service().rollbackSite(
      data.siteId,
      context.admin.username,
    )
    await publishTaxonomyChange(true)
    return result
  })

export const rollbackTaxonomyBatch = createServerFn({ method: 'POST' })
  .middleware([adminAuthMiddleware])
  .validator((data) => rollbackBatchInput.parse(data))
  .handler(async ({ data, context }) => {
    const result = await service().rollbackBatch(
      data.batchId,
      context.admin.username,
    )
    await publishTaxonomyChange(true)
    return result
  })
