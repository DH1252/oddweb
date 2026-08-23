import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useAdminMutation } from './use-admin-mutation'
import { automationPageSize } from './admin-automation-shared'
import {
  taxonomyAuditQueryOptions,
  taxonomyBatchesQueryOptions,
  taxonomyCandidatesQueryOptions,
  taxonomyDashboardQueryOptions,
  taxonomyAttemptsQueryOptions,
  taxonomyJobsQueryOptions,
  taxonomyLocksQueryOptions,
  taxonomyPoliciesQueryOptions,
  taxonomyProvidersQueryOptions,
} from '../queries/oddweb'
import {
  activateTaxonomyPolicy,
  activateTaxonomyProvider,
  createTaxonomyLock,
  createTaxonomyPolicy,
  createTaxonomyProvider,
  decideTaxonomyCandidate,
  deleteTaxonomyProvider,
  disableTaxonomyProvider,
  dispatchTaxonomyOutboxNow,
  enableTaxonomyProvider,
  releaseTaxonomyLock,
  resetTaxonomyCircuit,
  retryTaxonomyJobs,
  rollbackTaxonomyBatch,
  rollbackTaxonomyEvent,
  rollbackTaxonomySite,
  setSiteClassificationEnabled,
  testTaxonomyProvider,
  transitionTaxonomyMode,
  triggerTaxonomyBackfill,
  updateTaxonomyProvider,
} from '../server/taxonomy-admin'
import { humanize, modeLabel } from '../lib/admin-format'
import {
  isCandidateDecision,
  isProviderKind,
  isRoutingRole,
  numberFromForm,
  parseProviderDialect,
} from '../lib/admin-parsers'
import {
  defaultTaxonomyPolicy,
  policyInputFromForm,
  policyInputFromPolicy,
} from '../lib/taxonomy-policy-form'
import type {
  ProviderActionInput,
  ProviderActionResult,
  RollbackInput,
  TaxonomyBatchStatus,
  TaxonomyJobKind,
  TaxonomyJobStatus,
  TaxonomyLockInput,
  TaxonomyLockScope,
  TaxonomyMode,
} from '../lib/taxonomy-types'
import type {
  PolicyDraft,
  TaxonomyPolicyInput,
} from '../lib/taxonomy-policy-form'
import type {
  TaxonomyCandidateKind,
  TaxonomyCandidateStatus,
  TaxonomyPolicyAdminRecord,
} from '../db/taxonomy-admin-repository'
import type {
  TaxonomyProviderCreateInput,
  TaxonomyProviderUpdateInput,
} from '../server/taxonomy-admin-validation'

import type { FormEvent } from 'react'

function assertAdminResult(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message)
}

function assertProviderUpdated(result: { updated: boolean }) {
  if (!result.updated) throw new Error('Provider configuration was not updated')
}

function assertLockReleased(result: { released: boolean }) {
  if (!result.released) throw new Error('Automation lock was already released')
}

export function useAutomationController({
  showStatus,
  handleAdminError,
}: {
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
}) {
  const queryClient = useQueryClient()
  const [providerPage, setProviderPage] = useState(0)
  const [policyPage, setPolicyPage] = useState(0)
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft | null>(null)
  const [jobPage, setJobPage] = useState(0)
  const [jobStatus, setJobStatus] = useState<TaxonomyJobStatus | null>(null)
  const [jobKind, setJobKind] = useState<TaxonomyJobKind | null>(null)
  const [attemptPage, setAttemptPage] = useState(0)
  const [attemptJobId, setAttemptJobId] = useState('')
  const [candidatePage, setCandidatePage] = useState(0)
  const [candidateStatus, setCandidateStatus] =
    useState<TaxonomyCandidateStatus | null>('proposed')
  const [candidateKind, setCandidateKind] =
    useState<TaxonomyCandidateKind | null>(null)
  const [auditPage, setAuditPage] = useState(0)
  const [auditBatch, setAuditBatch] = useState('')
  const [auditEntity, setAuditEntity] = useState('')
  const [batchPage, setBatchPage] = useState(0)
  const [batchStatus, setBatchStatus] = useState<TaxonomyBatchStatus | null>(
    null,
  )
  const [lockPage, setLockPage] = useState(0)
  const [lockState, setLockState] = useState<'active' | 'released' | 'all'>(
    'active',
  )
  const [lockScope, setLockScope] =
    useState<TaxonomyLockScope>('site_assignment')
  const [providerKind, setProviderKind] = useState<
    'openai_compatible' | 'gemini'
  >('openai_compatible')
  const [backfillCursor, setBackfillCursor] = useState<number | null>(0)
  const [editingProviderId, setEditingProviderId] = useState<number | null>(
    null,
  )

  const { data: dashboard } = useSuspenseQuery(taxonomyDashboardQueryOptions())
  const { data: providers } = useSuspenseQuery(
    taxonomyProvidersQueryOptions({
      page: providerPage,
      pageSize: automationPageSize,
    }),
  )
  const { data: policies } = useSuspenseQuery(
    taxonomyPoliciesQueryOptions({
      page: policyPage,
      pageSize: automationPageSize,
    }),
  )
  const { data: policyDefaults } = useSuspenseQuery(
    taxonomyPoliciesQueryOptions({ page: 0, pageSize: 1 }),
  )
  const { data: jobs } = useSuspenseQuery(
    taxonomyJobsQueryOptions({
      page: jobPage,
      pageSize: automationPageSize,
      status: jobStatus,
      kind: jobKind,
    }),
  )
  const { data: attempts } = useSuspenseQuery(
    taxonomyAttemptsQueryOptions({
      page: attemptPage,
      pageSize: automationPageSize,
      jobId: attemptJobId.trim() || null,
    }),
  )
  const { data: candidates } = useSuspenseQuery(
    taxonomyCandidatesQueryOptions({
      page: candidatePage,
      pageSize: automationPageSize,
      status: candidateStatus,
      kind: candidateKind,
    }),
  )
  const { data: audit } = useSuspenseQuery(
    taxonomyAuditQueryOptions({
      page: auditPage,
      pageSize: automationPageSize,
      batchId: auditBatch.trim() || null,
      entityType: auditEntity.trim() || null,
    }),
  )
  const { data: batches } = useSuspenseQuery(
    taxonomyBatchesQueryOptions({
      page: batchPage,
      pageSize: automationPageSize,
      status: batchStatus,
    }),
  )
  const { data: locks } = useSuspenseQuery(
    taxonomyLocksQueryOptions({
      page: lockPage,
      pageSize: automationPageSize,
      state: lockState,
    }),
  )
  async function invalidateTaxonomy(...scopes: string[]) {
    await Promise.all(
      scopes.map(async (scope) => {
        const queryKey = ['oddweb', 'admin', 'taxonomy', scope]
        await queryClient.cancelQueries({ queryKey })
        await queryClient.invalidateQueries({
          queryKey,
          refetchType: 'active',
        })
      }),
    )
  }

  async function installDashboard(nextDashboard: typeof dashboard) {
    const queryKey = taxonomyDashboardQueryOptions().queryKey
    await queryClient.cancelQueries({ queryKey, exact: true })
    queryClient.setQueryData(queryKey, nextDashboard)
  }

  async function installControlPlaneSnapshot(snapshot: {
    dashboard: typeof dashboard
    providers: typeof providers
    policies: typeof policies
  }) {
    const dashboardKey = taxonomyDashboardQueryOptions().queryKey
    const providersKey = taxonomyProvidersQueryOptions({
      page: 0,
      pageSize: automationPageSize,
    }).queryKey
    const policiesKey = taxonomyPoliciesQueryOptions({
      page: 0,
      pageSize: automationPageSize,
    }).queryKey
    const policyDefaultsKey = taxonomyPoliciesQueryOptions({
      page: 0,
      pageSize: 1,
    }).queryKey
    await Promise.all([
      queryClient.cancelQueries({ queryKey: dashboardKey, exact: true }),
      queryClient.cancelQueries({ queryKey: providersKey, exact: true }),
      queryClient.cancelQueries({ queryKey: policiesKey, exact: true }),
      queryClient.cancelQueries({ queryKey: policyDefaultsKey, exact: true }),
    ])
    queryClient.setQueryData(dashboardKey, snapshot.dashboard)
    queryClient.setQueryData(providersKey, snapshot.providers)
    queryClient.setQueryData(policiesKey, snapshot.policies)
    queryClient.setQueryData(policyDefaultsKey, {
      ...snapshot.policies,
      items: snapshot.policies.items.slice(0, 1),
      pageSize: 1,
    })
  }

  const providerCreateMutation = useAdminMutation({
    mutationFn: (input: TaxonomyProviderCreateInput) =>
      createTaxonomyProvider({ data: input }),
  })
  const providerActionMutation = useAdminMutation<
    ProviderActionResult,
    Error,
    ProviderActionInput
  >({
    mutationFn: (input: ProviderActionInput) =>
      input.action === 'test'
        ? testTaxonomyProvider({
            data: { providerConfigId: input.providerConfigId },
          })
        : input.action === 'enable'
          ? enableTaxonomyProvider({
              data: { providerConfigId: input.providerConfigId },
            })
          : input.action === 'activate'
            ? activateTaxonomyProvider({
                data: { providerConfigId: input.providerConfigId },
              })
            : disableTaxonomyProvider({
                data: { providerConfigId: input.providerConfigId },
              }),
  })
  const providerUpdateMutation = useAdminMutation({
    mutationFn: (input: TaxonomyProviderUpdateInput) =>
      updateTaxonomyProvider({ data: input }),
  })
  const providerDeleteMutation = useAdminMutation({
    mutationFn: (providerConfigId: number) =>
      deleteTaxonomyProvider({ data: { providerConfigId } }),
  })
  const policyCreateMutation = useAdminMutation({
    mutationFn: (input: TaxonomyPolicyInput) =>
      createTaxonomyPolicy({ data: input }),
  })
  const policyActivateMutation = useAdminMutation({
    mutationFn: (policyConfigId: number) =>
      activateTaxonomyPolicy({ data: { policyConfigId } }),
  })
  const modeMutation = useAdminMutation({
    mutationFn: (mode: TaxonomyMode) =>
      transitionTaxonomyMode({ data: { mode } }),
  })
  const siteClassificationMutation = useAdminMutation({
    mutationFn: (enabled: boolean) =>
      setSiteClassificationEnabled({ data: { enabled } }),
  })
  const circuitMutation = useAdminMutation({
    mutationFn: () => resetTaxonomyCircuit(),
  })
  const backfillMutation = useAdminMutation({
    mutationFn: (input: { cursor: number; limit: number }) =>
      triggerTaxonomyBackfill({ data: input }),
  })
  const retryMutation = useAdminMutation({
    mutationFn: (jobIds: string[]) => retryTaxonomyJobs({ data: { jobIds } }),
  })
  const dispatchMutation = useAdminMutation({
    mutationFn: () => dispatchTaxonomyOutboxNow(),
  })
  const rollbackMutation = useAdminMutation({
    mutationFn: (input: RollbackInput) => {
      if (input.kind === 'event')
        return rollbackTaxonomyEvent({ data: { eventId: input.id } })
      if (input.kind === 'site')
        return rollbackTaxonomySite({ data: { siteId: Number(input.id) } })
      return rollbackTaxonomyBatch({ data: { batchId: input.id } })
    },
  })
  const lockCreateMutation = useAdminMutation({
    mutationFn: (input: TaxonomyLockInput) =>
      createTaxonomyLock({ data: input }),
  })
  const lockReleaseMutation = useAdminMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      releaseTaxonomyLock({ data: input }),
  })
  const candidateDecisionMutation = useAdminMutation({
    mutationFn: (input: {
      candidateId: string
      decision: 'accepted' | 'rejected' | 'deferred' | 'conflict'
      reason: string
    }) => decideTaxonomyCandidate({ data: input }),
  })
  const controlPlanePending =
    providerCreateMutation.isPending ||
    providerActionMutation.isPending ||
    providerUpdateMutation.isPending ||
    providerDeleteMutation.isPending ||
    policyCreateMutation.isPending ||
    policyActivateMutation.isPending ||
    modeMutation.isPending ||
    siteClassificationMutation.isPending ||
    circuitMutation.isPending

  async function submitProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (providerCreateMutation.isPending) return
    const form = event.currentTarget
    const data = new FormData(form)
    const apiKeyElement = form.elements.namedItem('apiKey')
    if (!(apiKeyElement instanceof HTMLInputElement)) {
      showStatus('Provider API key field is unavailable.', 'error')
      return
    }
    const apiKeyInput = apiKeyElement
    try {
      const kindValue = String(data.get('providerKind'))
      assertAdminResult(isProviderKind(kindValue), 'Invalid provider type')
      const routingRoleValue = String(data.get('routingRole'))
      assertAdminResult(
        isRoutingRole(routingRoleValue),
        'Invalid provider routing role',
      )
      const shared = {
        name: String(data.get('name') || '').trim(),
        endpoint: String(data.get('endpoint') || '').trim(),
        model: String(data.get('model') || '').trim(),
        routingGroup: String(data.get('routingGroup') || '').trim(),
        routingRole: routingRoleValue,
        routingPriority: numberFromForm(data, 'routingPriority'),
        timeoutMs: numberFromForm(data, 'timeoutMs'),
        enabled: data.get('enabled') === 'on',
      }
      let apiKey: string | null = apiKeyInput.value
      let input: TaxonomyProviderCreateInput | null =
        kindValue === 'openai_compatible'
          ? {
              ...shared,
              apiKey,
              providerKind: kindValue,
              dialect: parseProviderDialect(data.get('dialect')),
            }
          : { ...shared, apiKey, providerKind: kindValue, dialect: null }
      const request = providerCreateMutation.mutateAsync(input)
      input = null
      apiKey = null
      data.delete('apiKey')
      apiKeyInput.value = ''
      const result = await request
      form.reset()
      setProviderKind('openai_compatible')
      setProviderPage(0)
      setAuditPage(0)
      await installControlPlaneSnapshot(result)
      await invalidateTaxonomy('audit')
      if (result.enableError) {
        showStatus(
          `Provider configuration created disabled. Test failed: ${result.enableError}`,
          'error',
        )
      } else {
        showStatus(
          `Provider configuration created${result.enabled ? ' and enabled' : ''}. The API key was cleared.`,
          'success',
        )
      }
    } catch (error) {
      showStatus(
        await handleAdminError(
          error,
          'Could not create provider configuration.',
        ),
        'error',
      )
    }
    apiKeyInput.value = ''
  }

  async function runProviderAction(
    action: 'test' | 'enable' | 'activate' | 'disable',
    providerConfigId: number,
  ) {
    try {
      const result = await providerActionMutation.mutateAsync({
        action,
        providerConfigId,
      })
      assertAdminResult(
        !('activated' in result) || result.activated,
        'Provider was not activated',
      )
      assertAdminResult(
        !('enabled' in result) || result.enabled,
        'Provider was not enabled',
      )
      assertAdminResult(
        !('disabled' in result) || result.disabled,
        'Provider was not disabled',
      )
      if (action !== 'test' && 'dashboard' in result) {
        setProviderPage(0)
        setAuditPage(0)
        await installControlPlaneSnapshot(result)
        await invalidateTaxonomy('audit')
      }
      showStatus(
        action === 'test'
          ? `Provider test passed in ${'latencyMs' in result ? result.latencyMs : 0} ms.`
          : `Provider ${action === 'activate' ? 'activated' : action === 'enable' ? 'enabled' : 'disabled'}.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, `Could not ${action} provider.`),
        'error',
      )
    }
  }

  async function submitProviderUpdate(
    event: FormEvent<HTMLFormElement>,
    kind: 'openai_compatible' | 'gemini',
    providerConfigId: number,
  ) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const apiKeyElement = form.elements.namedItem('apiKey')
    const apiKeyInput =
      apiKeyElement instanceof HTMLInputElement ? apiKeyElement : null
    try {
      const routingRoleValue = String(data.get('routingRole'))
      assertAdminResult(
        isRoutingRole(routingRoleValue),
        'Invalid provider routing role',
      )
      const shared = {
        providerConfigId,
        name: String(data.get('name') || '').trim(),
        endpoint: String(data.get('endpoint') || '').trim(),
        model: String(data.get('model') || '').trim(),
        routingGroup: String(data.get('routingGroup') || '').trim(),
        routingRole: routingRoleValue,
        routingPriority: numberFromForm(data, 'routingPriority'),
        timeoutMs: numberFromForm(data, 'timeoutMs'),
        apiKey: apiKeyInput?.value.trim() || undefined,
      }
      const input =
        kind === 'openai_compatible'
          ? {
              ...shared,
              providerKind: kind,
              dialect: parseProviderDialect(data.get('dialect')),
            }
          : { ...shared, providerKind: kind, dialect: null }
      const result = await providerUpdateMutation.mutateAsync(input)
      assertProviderUpdated(result)
      if (apiKeyInput) apiKeyInput.value = ''
      setEditingProviderId(null)
      setProviderPage(0)
      setAuditPage(0)
      await installControlPlaneSnapshot(result)
      await invalidateTaxonomy('audit')
      showStatus(
        'Provider configuration updated. Structural changes disable the provider until it passes a new test.',
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(
          error,
          'Could not update provider configuration.',
        ),
        'error',
      )
    }
    if (apiKeyInput) apiKeyInput.value = ''
  }

  async function deleteProvider(providerConfigId: number) {
    if (!window.confirm('Delete this provider configuration?')) return
    try {
      const result = await providerDeleteMutation.mutateAsync(providerConfigId)
      assertAdminResult(result.deleted, 'Provider was not deleted')
      setEditingProviderId(null)
      setProviderPage(0)
      setAuditPage(0)
      await installControlPlaneSnapshot(result)
      await invalidateTaxonomy('audit')
      showStatus('Provider configuration deleted.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(
          error,
          'Could not delete provider configuration.',
        ),
        'error',
      )
    }
  }

  async function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (policyCreateMutation.isPending) return
    const data = new FormData(event.currentTarget)
    const draft = policyDraft
    try {
      const input = policyInputFromForm(data)
      const result = await policyCreateMutation.mutateAsync({
        ...input,
        ...(draft ? { supersedesPolicyConfigId: draft.sourceId } : {}),
      })
      assertAdminResult(
        Number.isInteger(result.id) && result.id >= 1,
        'Policy revision was not created',
      )
      setPolicyDraft(null)
      setPolicyPage(0)
      setAuditPage(0)
      await installControlPlaneSnapshot(result)
      await invalidateTaxonomy('audit')
      showStatus(
        draft
          ? `Policy revision created from revision ${draft.sourceRevision}.`
          : 'Safe-controls policy revision created.',
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not create policy revision.'),
        'error',
      )
    }
  }

  async function decideCandidate(
    event: FormEvent<HTMLFormElement>,
    candidateId: string,
  ) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const decision = String(data.get('decision'))
    if (!isCandidateDecision(decision)) {
      showStatus('Select a valid candidate decision.', 'error')
      return
    }
    const reason = String(data.get('reason') || '').trim()
    if (
      !window.confirm(
        `${humanize(decision)} candidate ${candidateId}?${decision === 'accepted' ? ' This queues a guarded ontology job.' : ''}`,
      )
    )
      return
    try {
      const result = await candidateDecisionMutation.mutateAsync({
        candidateId,
        decision,
        reason,
      })
      assertAdminResult(result.decided, 'Candidate was already decided')
      setCandidatePage(0)
      if (decision === 'accepted') {
        setJobPage(0)
      }
      await invalidateTaxonomy('candidates', 'jobs', 'dashboard', 'audit')
      showStatus(
        decision === 'accepted'
          ? `Candidate accepted and queued as job ${result.jobId}.`
          : `Candidate marked ${decision}.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not decide taxonomy candidate.'),
        'error',
      )
    }
  }

  async function activatePolicy(policyConfigId: number) {
    try {
      const result = await policyActivateMutation.mutateAsync(policyConfigId)
      assertAdminResult(result.activated, 'Policy revision was not activated')
      setPolicyPage(0)
      setAuditPage(0)
      await installControlPlaneSnapshot(result)
      await invalidateTaxonomy('audit')
      showStatus(
        'Policy revision activated. Backfill current-policy samples before promotion; elevated modes returned to shadow.',
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not activate policy revision.'),
        'error',
      )
    }
  }

  function editPolicy(policy: TaxonomyPolicyAdminRecord) {
    setPolicyDraft({
      sourceId: policy.id,
      sourceRevision: policy.revision,
      values: policyInputFromPolicy(policy),
    })
  }

  async function changeMode(mode: TaxonomyMode) {
    try {
      const result = await modeMutation.mutateAsync(mode)
      setAuditPage(0)
      await installDashboard(result.dashboard)
      await invalidateTaxonomy('audit')
      showStatus(`Automation mode changed to ${modeLabel(mode)}.`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not change automation mode.'),
        'error',
      )
    }
  }

  async function changeSiteClassification(enabled: boolean) {
    try {
      const result = await siteClassificationMutation.mutateAsync(enabled)
      setAuditPage(0)
      await installDashboard(result.dashboard)
      await invalidateTaxonomy('audit', 'jobs')
      showStatus(
        `Site classification ${enabled ? 'enabled' : 'disabled'}.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not change site classification.'),
        'error',
      )
    }
  }

  async function resetCircuit() {
    if (circuitMutation.isPending) return
    if (
      !window.confirm('Reset the circuit and return automation to shadow mode?')
    )
      return
    try {
      const result = await circuitMutation.mutateAsync()
      setAuditPage(0)
      await installDashboard(result.dashboard)
      await invalidateTaxonomy('audit')
      showStatus('Circuit reset. Automation is in shadow mode.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not reset the circuit.'),
        'error',
      )
    }
  }

  async function runBackfill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (backfillMutation.isPending) return
    const limit = numberFromForm(new FormData(event.currentTarget), 'limit')
    try {
      const result = await backfillMutation.mutateAsync({
        cursor: backfillCursor ?? 0,
        limit,
      })
      setBackfillCursor(result.nextCursor)
      setJobPage(0)
      await invalidateTaxonomy('dashboard', 'jobs')
      showStatus(
        `Backfill scanned ${result.scanned} sites, enqueued ${result.enqueued}, and dispatched ${result.dispatched}. ${result.nextCursor === null ? 'Scanning is complete; jobs remain pending until the queue consumer processes them.' : 'Continue scanning to cover remaining sites.'}`,
        '',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not continue taxonomy backfill.'),
        'error',
      )
    }
  }

  async function retryJobs(jobIds: string[]) {
    if (!jobIds.length || retryMutation.isPending) return
    if (
      !window.confirm(
        `Retry ${jobIds.length} selected jobs? They will return to pending and be dispatched to the queue.`,
      )
    )
      return
    try {
      const result = await retryMutation.mutateAsync(jobIds)
      setJobPage(0)
      await invalidateTaxonomy('jobs', 'dashboard')
      showStatus(
        `${result.retried} jobs returned to the queue${result.dispatched ? `, ${result.dispatched} dispatched` : ''}.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not retry selected jobs.'),
        'error',
      )
    }
  }

  async function dispatchPendingJobs() {
    try {
      const result = await dispatchMutation.mutateAsync()
      await invalidateTaxonomy('jobs', 'dashboard')
      showStatus(
        result.dispatched
          ? `${result.dispatched} pending jobs dispatched to the queue.`
          : 'No undispatched outbox rows were ready.',
        result.dispatched ? 'success' : '',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not dispatch pending jobs.'),
        'error',
      )
    }
  }

  async function rollback(input: RollbackInput, label: string) {
    if (
      !window.confirm(
        `Roll back ${label}? A compensating audit batch will be created.`,
      )
    )
      return
    try {
      await rollbackMutation.mutateAsync(input)
      setAuditPage(0)
      setBatchPage(0)
      setJobPage(0)
      await invalidateTaxonomy('audit', 'batches', 'jobs', 'dashboard')
      showStatus(`${label} rollback completed.`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, `Could not roll back ${label}.`),
        'error',
      )
    }
  }

  async function submitLock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lockCreateMutation.isPending) return
    const form = event.currentTarget
    const data = new FormData(form)
    const shared = {
      scope: lockScope,
      tagId: numberFromForm(data, 'tagId'),
      reason: String(data.get('reason') || '').trim(),
    }
    let input: TaxonomyLockInput
    if (lockScope === 'site_assignment') {
      input = {
        ...shared,
        scope: lockScope,
        siteId: numberFromForm(data, 'siteId'),
      }
    } else if (lockScope === 'alias') {
      input = {
        ...shared,
        scope: lockScope,
        alias: String(data.get('alias') || '').trim(),
      }
    } else if (lockScope === 'merge' || lockScope === 'parent_edge') {
      input = {
        ...shared,
        scope: lockScope,
        relatedTagId: numberFromForm(data, 'relatedTagId'),
      }
    } else {
      input = { ...shared, scope: lockScope }
    }
    try {
      await lockCreateMutation.mutateAsync(input)
      form.reset()
      setLockPage(0)
      setAuditPage(0)
      await invalidateTaxonomy('locks', 'dashboard', 'audit')
      showStatus('Automation lock created.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not create automation lock.'),
        'error',
      )
    }
  }

  async function releaseLock(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    const reason = String(
      new FormData(event.currentTarget).get('reason') || '',
    ).trim()
    if (!window.confirm(`Release automation lock ${id}?`)) return
    try {
      const result = await lockReleaseMutation.mutateAsync({ id, reason })
      assertLockReleased(result)
      setLockPage(0)
      setAuditPage(0)
      await invalidateTaxonomy('locks', 'dashboard', 'audit')
      showStatus('Automation lock released.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not release automation lock.'),
        'error',
      )
    }
  }

  const initialPolicy: TaxonomyPolicyInput =
    policyDraft?.values ?? policyDefaults.items.at(0) ?? defaultTaxonomyPolicy
  const modeOptions: TaxonomyMode[] = [
    'disabled',
    'shadow',
    'gradual',
    'autonomous',
  ]

  return {
    overview: {
      backfillCursor,
      backfillMutation,
      changeMode,
      changeSiteClassification,
      circuitMutation,
      controlPlanePending,
      dashboard,
      modeMutation,
      modeOptions,
      resetCircuit,
      runBackfill,
      setBackfillCursor,
      siteClassificationMutation,
    },
    providerPolicy: {
      activatePolicy,
      controlPlanePending,
      deleteProvider,
      editPolicy,
      editingProviderId,
      initialPolicy,
      policies,
      policyActivateMutation,
      policyCreateMutation,
      policyDraft,
      providerActionMutation,
      providerCreateMutation,
      providerKind,
      providers,
      providerUpdateMutation,
      runProviderAction,
      setEditingProviderId,
      setPolicyDraft,
      setPolicyPage,
      setProviderKind,
      setProviderPage,
      submitPolicy,
      submitProvider,
      submitProviderUpdate,
    },
    candidates: {
      candidateDecisionMutation,
      candidateKind,
      candidates,
      candidateStatus,
      decideCandidate,
      setCandidateKind,
      setCandidatePage,
      setCandidateStatus,
    },
    jobsBatches: {
      attemptJobId,
      attempts,
      batches,
      batchStatus,
      dispatchMutation,
      dispatchPendingJobs,
      jobKind,
      jobs,
      jobStatus,
      retryJobs,
      retryMutation,
      rollback,
      rollbackMutation,
      setAttemptJobId,
      setAttemptPage,
      setBatchPage,
      setBatchStatus,
      setJobKind,
      setJobPage,
      setJobStatus,
    },
    auditLocks: {
      audit,
      auditBatch,
      auditEntity,
      lockCreateMutation,
      lockReleaseMutation,
      locks,
      lockScope,
      lockState,
      releaseLock,
      rollback,
      rollbackMutation,
      setAuditBatch,
      setAuditEntity,
      setAuditPage,
      setLockPage,
      setLockScope,
      setLockState,
      submitLock,
    },
  }
}
