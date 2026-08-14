import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useDeferredValue, useState } from 'react'

import { TagInput } from '../components/tag-input'
import {
  FieldLabel,
  ItemThumbnail,
  ModalDialog,
  PageShell,
  Panel,
  SiteFooter,
  SiteHeader,
  buttonClass,
  dangerButtonClass,
  fieldClass,
  primaryButtonClass,
  successButtonClass,
} from '../components/oddweb'
import {
  adminGuestbookQueryOptions,
  adminOverviewQueryOptions,
  adminSiteQueryOptions,
  adminSitesQueryOptions,
  adminSubmissionsQueryOptions,
  adminTagsQueryOptions,
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
import { getAdminSession, logoutAdmin } from '../server/auth'
import {
  createDirectorySite,
  mergeTag,
  reconcileThumbnailStorage,
  reviewSubmission,
  saveTag,
  setGuestbookEntryVisibility,
  updateDirectorySite,
  updateSiteStatus,
} from '../server/data'
import {
  activateTaxonomyPolicy,
  activateTaxonomyProvider,
  createTaxonomyLock,
  createTaxonomyPolicy,
  createTaxonomyProvider,
  disableTaxonomyProvider,
  decideTaxonomyCandidate,
  enableTaxonomyProvider,
  releaseTaxonomyLock,
  resetTaxonomyCircuit,
  retryTaxonomyJobs,
  rollbackTaxonomyBatch,
  rollbackTaxonomyEvent,
  rollbackTaxonomySite,
  testTaxonomyProvider,
  transitionTaxonomyMode,
  triggerTaxonomyBackfill,
} from '../server/taxonomy-admin'

import type { FormEvent, ReactNode } from 'react'
import type {
  AdminSite,
  AdminSubmission,
  AdminTagRecord,
} from '../db/repository'
import type {
  TaxonomyCandidateKind,
  TaxonomyCandidateStatus,
} from '../db/taxonomy-admin-repository'
import type {
  TaxonomyPolicyCreateInput,
  TaxonomyProviderCreateInput,
} from '../server/taxonomy-admin-validation'

type ReviewStatus = 'pending' | 'approved' | 'rejected'
type EntryStatus = 'active' | 'archived'
type ScanResult = Awaited<ReturnType<typeof reconcileThumbnailStorage>>
type TaxonomyMode =
  'disabled' | 'shadow' | 'gradual' | 'autonomous' | 'degraded'
type TaxonomyJobStatus =
  | 'pending'
  | 'leased'
  | 'retry_wait'
  | 'succeeded'
  | 'settled'
  | 'obsolete'
  | 'dead'
  | 'cancelled'
  | 'degraded'
type TaxonomyJobKind =
  'classify_site' | 'reassess_concept' | 'apply_ontology' | 'rollback'
type TaxonomyBatchStatus =
  | 'planned'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'partial'
type TaxonomyLockScope =
  'site_assignment' | 'tag' | 'alias' | 'merge' | 'parent_edge'
type TaxonomyLockInput =
  | {
      scope: 'site_assignment'
      siteId: number
      tagId: number
      reason: string
    }
  | { scope: 'tag'; tagId: number; reason: string }
  | { scope: 'alias'; tagId: number; alias: string; reason: string }
  | {
      scope: 'merge' | 'parent_edge'
      tagId: number
      relatedTagId: number
      reason: string
    }
type RollbackInput =
  | { kind: 'event'; id: string }
  | { kind: 'site'; id: string }
  | { kind: 'batch'; id: string }
type ProviderActionInput = {
  action: 'test' | 'enable' | 'activate' | 'disable'
  providerConfigId: number
}
type ProviderActionResult =
  | { ok: true; latencyMs: number; providerRequestId: string | null }
  | { enabled: boolean }
  | { activated: boolean }
  | { disabled: boolean }

const adminPageSize = 12
const automationPageSize = 20

export const Route = createFileRoute('/admin')({
  beforeLoad: async ({ location }) => {
    const session = await getAdminSession()
    if (!session.authenticated) {
      throw redirect({
        to: '/admin/login',
        search: { redirect: location.href },
      })
    }
    return { admin: session }
  },
  head: () => ({
    meta: [
      { title: 'Oddweb Admin' },
      { name: 'description', content: 'Oddweb directory administration.' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(adminOverviewQueryOptions()),
  component: AdminPage,
})

function AdminPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { admin } = Route.useRouteContext()
  const { data: overview } = useSuspenseQuery(adminOverviewQueryOptions())
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | 'all'>(
    'pending',
  )
  const [siteFilter, setSiteFilter] = useState<EntryStatus | 'all'>('active')
  const [siteSearch, setSiteSearch] = useState('')
  const [includedTags, setIncludedTags] = useState<string[]>([])
  const [excludedTags, setExcludedTags] = useState<string[]>([])
  const [tagSearch, setTagSearch] = useState('')
  const [submissionPage, setSubmissionPage] = useState(0)
  const [sitePage, setSitePage] = useState(0)
  const [tagPage, setTagPage] = useState(0)
  const [guestbookPage, setGuestbookPage] = useState(0)
  const [editingEntry, setEditingEntry] = useState<AdminSite | null>(null)
  const [editingTag, setEditingTag] = useState<AdminTagRecord | null>(null)
  const [mergeTarget, setMergeTarget] = useState('')
  const [editorError, setEditorError] = useState('')
  const [status, setStatus] = useState('Ready.')
  const [statusState, setStatusState] = useState<'success' | 'error' | ''>('')
  const [entryTagInputKey, setEntryTagInputKey] = useState(0)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const deferredSiteSearch = useDeferredValue(siteSearch.trim())
  const deferredTagSearch = useDeferredValue(tagSearch.trim())

  const { data: submissionResults } = useSuspenseQuery(
    adminSubmissionsQueryOptions(submissionPage, reviewFilter),
  )
  const { data: siteResults } = useSuspenseQuery(
    adminSitesQueryOptions({
      page: sitePage,
      status: siteFilter,
      search: deferredSiteSearch,
      includeTags: includedTags,
      excludeTags: excludedTags,
    }),
  )
  const { data: tagResults } = useSuspenseQuery(
    adminTagsQueryOptions(tagPage, deferredTagSearch),
  )
  const { data: guestbookResults } = useSuspenseQuery(
    adminGuestbookQueryOptions(guestbookPage),
  )

  const reviewMutation = useMutation({
    mutationFn: (input: { id: number; status: ReviewStatus }) =>
      reviewSubmission({ data: input }),
  })
  const createMutation = useMutation({
    mutationFn: (form: FormData) => createDirectorySite({ data: form }),
  })
  const statusMutation = useMutation({
    mutationFn: (input: { id: number; status: EntryStatus }) =>
      updateSiteStatus({ data: input }),
  })
  const editMutation = useMutation({
    mutationFn: (form: FormData) => updateDirectorySite({ data: form }),
  })
  const saveTagMutation = useMutation({
    mutationFn: (input: {
      id: number
      name: string
      aliases: string[]
      parents: string[]
    }) => saveTag({ data: input }),
  })
  const mergeTagMutation = useMutation({
    mutationFn: (input: { sourceId: number; targetSlug: string }) =>
      mergeTag({ data: input }),
  })
  const guestbookMutation = useMutation({
    mutationFn: (input: { id: number; hidden: boolean }) =>
      setGuestbookEntryVisibility({ data: input }),
  })
  const storageMutation = useMutation({
    mutationFn: (cursor?: string) =>
      reconcileThumbnailStorage({ data: cursor ? { cursor } : {} }),
  })
  const logoutMutation = useMutation({ mutationFn: () => logoutAdmin() })

  function showStatus(message: string, state: 'success' | 'error' | '' = '') {
    setStatus(message)
    setStatusState(state)
  }

  async function handleAdminError(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback
    if (/unauthorized/i.test(message)) {
      queryClient.clear()
      await navigate({ to: '/admin/login', search: { redirect: '/admin' } })
      return 'Your admin session expired. Sign in again to continue.'
    }
    return message
  }

  async function refreshData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'tags'] }),
    ])
  }

  async function logOut() {
    try {
      await logoutMutation.mutateAsync()
      queryClient.clear()
      await navigate({ to: '/admin/login' })
    } catch (error) {
      showStatus(await handleAdminError(error, 'Could not sign out.'), 'error')
    }
  }

  async function review(submission: AdminSubmission, nextStatus: ReviewStatus) {
    if (
      nextStatus !== 'approved' &&
      submission.status === 'approved' &&
      !window.confirm(
        `${nextStatus === 'rejected' ? 'Reject' : 'Return'} "${submission.name}" and hide its published directory entry?`,
      )
    )
      return
    try {
      await reviewMutation.mutateAsync({
        id: submission.id,
        status: nextStatus,
      })
      await refreshData()
      showStatus(
        nextStatus === 'approved'
          ? `Approved "${submission.name}".`
          : nextStatus === 'rejected'
            ? `Rejected "${submission.name}".`
            : `Returned "${submission.name}" to the review queue.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not review submission.'),
        'error',
      )
    }
  }

  async function addEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('name') || '').trim()
    showStatus(`Adding "${name}"...`)
    try {
      await createMutation.mutateAsync(formData)
      await refreshData()
      form.reset()
      setEntryTagInputKey((key) => key + 1)
      showStatus(`Added "${name}".`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not add the site.'),
        'error',
      )
    }
  }

  async function toggleEntry(entry: AdminSite) {
    if (entry.source === 'Directory') return
    const nextStatus = entry.status === 'active' ? 'archived' : 'active'
    if (
      nextStatus === 'archived' &&
      !window.confirm(`Archive "${entry.name}" and hide it from the directory?`)
    )
      return
    try {
      await statusMutation.mutateAsync({ id: entry.id, status: nextStatus })
      await refreshData()
      showStatus(
        `${entry.name} is now ${nextStatus === 'active' ? 'published' : 'archived'}.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not update the site.'),
        'error',
      )
    }
  }

  async function openEditor(id: number) {
    try {
      showStatus('Loading site editor...')
      setEditingEntry(await queryClient.fetchQuery(adminSiteQueryOptions(id)))
      setEditorError('')
      showStatus('Ready.')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not load the site editor.'),
        'error',
      )
    }
  }

  async function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const name = String(formData.get('name') || '').trim()
    if (
      editingEntry?.status === 'active' &&
      formData.get('status') === 'archived' &&
      !window.confirm(`Archive "${name}" and hide it from the directory?`)
    )
      return
    try {
      setEditorError('')
      await editMutation.mutateAsync(formData)
      await refreshData()
      setEditingEntry(null)
      showStatus(`Updated "${name}".`, 'success')
    } catch (error) {
      const message = await handleAdminError(
        error,
        'Could not update the site.',
      )
      setEditorError(message)
      showStatus(message, 'error')
    }
  }

  async function saveTagRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingTag) return
    const form = new FormData(event.currentTarget)
    try {
      setEditorError('')
      await saveTagMutation.mutateAsync({
        id: editingTag.id,
        name: String(form.get('name') || ''),
        aliases: commaList(form.get('aliases')),
        parents: commaList(form.get('parents')),
      })
      await refreshData()
      setEditingTag(null)
      showStatus('Tag saved.', 'success')
    } catch (error) {
      const message = await handleAdminError(error, 'Could not save tag.')
      setEditorError(message)
      showStatus(message, 'error')
    }
  }

  async function mergeCurrentTag() {
    if (!editingTag || !mergeTarget.trim()) return
    if (
      !window.confirm(
        `Merge "${editingTag.name}" into "${mergeTarget.trim()}"?`,
      )
    )
      return
    try {
      setEditorError('')
      await mergeTagMutation.mutateAsync({
        sourceId: editingTag.id,
        targetSlug: mergeTarget.trim(),
      })
      await refreshData()
      setEditingTag(null)
      setMergeTarget('')
      showStatus('Tags merged.', 'success')
    } catch (error) {
      const message = await handleAdminError(error, 'Could not merge tag.')
      setEditorError(message)
      showStatus(message, 'error')
    }
  }

  async function changeGuestbookVisibility(id: number, hidden: boolean) {
    const entry = guestbookResults.items.find((item) => item.id === id)
    if (
      hidden &&
      !window.confirm(`Hide ${entry?.name || 'this entry'} from the guestbook?`)
    )
      return
    try {
      await guestbookMutation.mutateAsync({ id, hidden })
      await refreshData()
      showStatus(
        hidden ? 'Guestbook entry hidden.' : 'Guestbook entry restored.',
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not update the entry.'),
        'error',
      )
    }
  }

  async function runThumbnailScan(cursor?: string) {
    try {
      const result = await storageMutation.mutateAsync(cursor)
      setScanResult(result)
      const summary = `${result.stored} stored checked; ${result.referenced} references checked; ${result.orphaned} unused; ${result.missing} missing.`
      showStatus(
        result.phase === 'complete'
          ? `Thumbnail scan complete. ${summary}`
          : `Thumbnail scan ${result.phase === 'r2' ? 'checking stored objects' : 'checking database references'}. ${summary}`,
        result.phase === 'complete' ? 'success' : '',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not inspect thumbnail storage.'),
        'error',
      )
    }
  }

  function setManagementTags(type: 'include' | 'exclude', tags: string[]) {
    if (type === 'include') {
      setIncludedTags(tags)
      setExcludedTags((current) => current.filter((tag) => !tags.includes(tag)))
    } else {
      setExcludedTags(tags)
      setIncludedTags((current) => current.filter((tag) => !tags.includes(tag)))
    }
    setSitePage(0)
  }

  return (
    <PageShell patterned>
      <SiteHeader directoryLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-3 mb-4 border border-ink bg-paper p-2.5"
        data-od-id="admin-page"
      >
        <header className="grid border border-ink md:grid-cols-[1.4fr_.6fr]">
          <div className="bg-rust p-4 text-white">
            <p className="mb-1 font-mono text-xs font-bold tracking-[0.08em] uppercase">
              ODDWEB
            </p>
            <h1 className="m-0 font-mono text-[clamp(30px,5vw,44px)] leading-none font-bold tracking-[-0.04em]">
              Admin
            </h1>
          </div>
          <aside
            className="border-t border-ink bg-canvas p-4 md:border-t-0 md:border-l"
            aria-label="Admin session and thumbnail storage"
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="font-mono text-xs tracking-[0.06em] uppercase">
                Signed in as {admin.username}
              </strong>
              <button
                type="button"
                className={`${buttonClass} min-h-9`}
                onClick={logOut}
                disabled={logoutMutation.isPending}
              >
                {logoutMutation.isPending ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className={`${buttonClass} min-h-9`}
                onClick={() => runThumbnailScan()}
                disabled={storageMutation.isPending}
              >
                {storageMutation.isPending && !scanResult?.cursor
                  ? 'Scanning...'
                  : 'Start thumbnail scan'}
              </button>
              {scanResult?.cursor ? (
                <button
                  type="button"
                  className={`${buttonClass} min-h-9`}
                  onClick={() => runThumbnailScan(scanResult.cursor)}
                  disabled={storageMutation.isPending}
                >
                  {storageMutation.isPending
                    ? 'Scanning...'
                    : 'Continue thumbnail scan'}
                </button>
              ) : null}
            </div>
            {scanResult ? (
              <p className="mt-2 mb-0 font-mono text-xs text-brown">
                {scanResult.stored} stored / {scanResult.referenced} referenced
                / {scanResult.orphaned} unused / {scanResult.missing} missing
              </p>
            ) : null}
          </aside>
        </header>

        <div
          className={`mt-2.5 border px-2.5 py-2 font-mono text-xs ${statusState === 'error' ? 'border-danger bg-red-50 text-danger' : statusState === 'success' ? 'border-success bg-green-50 text-success' : 'border-line bg-canvas text-brown'}`}
          role="status"
          aria-live="polite"
        >
          {status}
        </div>

        <dl
          className="mt-2.5 grid grid-cols-1 gap-2 min-[481px]:grid-cols-2 md:grid-cols-4"
          aria-label="Directory statistics"
        >
          <Stat
            label="Published sites"
            value={overview.activeSites}
            note="Active directory records"
          />
          <Stat
            label="Waiting review"
            value={overview.pendingSubmissions}
            note="Unresolved submissions"
          />
          <Stat label="Views" value={overview.visits} note="Site page views" />
          <Stat
            label="Tags in use"
            value={overview.tagsInUse}
            note="Across active records"
          />
        </dl>

        <AutomationSection
          showStatus={showStatus}
          handleAdminError={handleAdminError}
        />

        <div className="mt-2.5 grid items-start gap-2.5 md:grid-cols-[1.3fr_.7fr]">
          <Panel
            title="Submission review"
            label={`${submissionResults.total} RECORDS`}
          >
            <label className="mb-2.5 block max-w-xs">
              <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                Show status
              </span>
              <select
                value={reviewFilter}
                onChange={(event) => {
                  setReviewFilter(event.target.value as ReviewStatus | 'all')
                  setSubmissionPage(0)
                }}
                className={fieldClass}
              >
                <option value="pending">Waiting review</option>
                <option value="all">All submissions</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            {submissionResults.items.length ? (
              <>
                <div
                  id="submission-results"
                  tabIndex={-1}
                  className="grid gap-2 outline-none"
                >
                  {submissionResults.items.map((submission) => (
                    <SubmissionCard
                      key={submission.id}
                      submission={submission}
                      onReview={review}
                      pending={
                        reviewMutation.isPending &&
                        reviewMutation.variables.id === submission.id
                      }
                    />
                  ))}
                </div>
                <AdminPagination
                  page={submissionResults.page}
                  total={submissionResults.total}
                  onChange={setSubmissionPage}
                  label="Submission review pages"
                  focusTargetId="submission-results"
                />
              </>
            ) : (
              <Empty title="No submissions." text="Try another status." />
            )}
          </Panel>

          <Panel title="Add site">
            <form onSubmit={addEntry}>
              <fieldset
                disabled={createMutation.isPending}
                className="m-0 min-w-0 border-0 p-0"
              >
                <AdminField
                  label="Site name"
                  name="name"
                  placeholder="Name as it should appear"
                  maxLength={60}
                />
                <AdminField
                  label="Website address"
                  name="url"
                  type="url"
                  placeholder="https://"
                />
                <div className="mb-2.5 border border-dotted border-brown bg-canvas p-2">
                  <FieldLabel htmlFor="entry-image">
                    Site preview image
                  </FieldLabel>
                  <input
                    id="entry-image"
                    name="image"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    required
                    className="w-full"
                  />
                  <small className="mt-1 block text-muted">
                    PNG, JPEG, or WebP, up to 8 MB.
                  </small>
                </div>
                <div className="mb-2.5">
                  <FieldLabel htmlFor="entry-description">
                    Card description
                  </FieldLabel>
                  <textarea
                    id="entry-description"
                    name="description"
                    maxLength={220}
                    required
                    className={`${fieldClass} min-h-24 resize-y`}
                  />
                </div>
                <div className="mb-2.5">
                  <TagInput
                    key={entryTagInputKey}
                    label="Tags"
                    name="tags"
                    required
                    placeholder="Try audio, playful, tool..."
                  />
                </div>
                <label className="mb-2.5 block">
                  <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                    Initial status
                  </span>
                  <select name="status" className={fieldClass}>
                    <option value="active">Published</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <button type="submit" className={primaryButtonClass}>
                  {createMutation.isPending ? 'Adding...' : 'Add site'}
                </button>
              </fieldset>
            </form>
          </Panel>

          <Panel
            title="Site management"
            label={`${siteResults.total} RECORDS`}
            className="md:col-span-2"
          >
            <div className="mb-2.5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <label className="w-full sm:max-w-md">
                <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                  Find a record
                </span>
                <input
                  type="search"
                  value={siteSearch}
                  onChange={(event) => {
                    setSiteSearch(event.target.value)
                    setSitePage(0)
                  }}
                  className={fieldClass}
                  placeholder="Search name, address, or tag"
                />
              </label>
              <label>
                <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                  Show records
                </span>
                <select
                  value={siteFilter}
                  onChange={(event) => {
                    setSiteFilter(event.target.value as EntryStatus | 'all')
                    setSitePage(0)
                  }}
                  className={fieldClass}
                >
                  <option value="active">Published</option>
                  <option value="all">All records</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            </div>
            <div className="mb-2.5 grid gap-2 border border-dotted border-line bg-canvas p-2 md:grid-cols-2">
              <TagInput
                label="Include tags"
                value={includedTags}
                onChange={(tags) => setManagementTags('include', tags)}
                tone="include"
                placeholder="Require a tag..."
              />
              <TagInput
                label="Exclude tags"
                value={excludedTags}
                onChange={(tags) => setManagementTags('exclude', tags)}
                tone="exclude"
                placeholder="Hide a tag..."
              />
              {includedTags.length || excludedTags.length ? (
                <div className="flex justify-end md:col-span-2">
                  <button
                    type="button"
                    className={`${buttonClass} min-h-9`}
                    onClick={() => {
                      setIncludedTags([])
                      setExcludedTags([])
                      setSitePage(0)
                    }}
                  >
                    Clear tag filters
                  </button>
                </div>
              ) : null}
            </div>
            {siteResults.items.length ? (
              <>
                <div className="overflow-x-auto border border-line">
                  <table
                    id="site-results"
                    tabIndex={-1}
                    className="w-full min-w-[700px] border-collapse outline-none"
                  >
                    <caption className="sr-only">
                      Oddweb directory records
                    </caption>
                    <thead>
                      <tr className="bg-brown text-left font-mono text-xs tracking-wide text-paper uppercase">
                        <th className="p-2">Site</th>
                        <th className="p-2">Tags</th>
                        <th className="p-2">Source</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {siteResults.items.map((entry) => (
                        <ManagedRow
                          key={entry.id}
                          entry={entry}
                          onToggle={toggleEntry}
                          onEdit={openEditor}
                          statusPending={
                            statusMutation.isPending &&
                            statusMutation.variables.id === entry.id
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <AdminPagination
                  page={siteResults.page}
                  total={siteResults.total}
                  onChange={setSitePage}
                  label="Site management pages"
                  focusTargetId="site-results"
                />
              </>
            ) : (
              <Empty
                title="No records match."
                text="Change the status, tag filters, or search with fewer words."
              />
            )}
          </Panel>

          <Panel
            title="Advanced tag corrections"
            label={`${overview.unmappedTags} UNMAPPED`}
            className="md:col-span-2"
          >
            <label className="mb-2.5 block max-w-md">
              <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                Find a tag
              </span>
              <input
                type="search"
                value={tagSearch}
                onChange={(event) => {
                  setTagSearch(event.target.value)
                  setTagPage(0)
                }}
                className={fieldClass}
                placeholder="Search name, slug, or alias"
              />
            </label>
            {tagResults.items.length ? (
              <>
                <div className="overflow-x-auto border border-line">
                  <table
                    id="tag-results"
                    tabIndex={-1}
                    className="w-full min-w-[680px] border-collapse outline-none"
                  >
                    <caption className="sr-only">
                      Tag definitions and usage
                    </caption>
                    <thead>
                      <tr className="bg-brown text-left font-mono text-xs tracking-wide text-paper uppercase">
                        <th className="p-2">Tag</th>
                        <th className="p-2">State</th>
                        <th className="p-2">Uses</th>
                        <th className="p-2">Aliases / parents</th>
                        <th className="p-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tagResults.items.map((tag) => (
                        <TagRow
                          key={tag.id}
                          tag={tag}
                          onEdit={(record) => {
                            setEditingTag(record)
                            setMergeTarget('')
                          }}
                          disabled={
                            saveTagMutation.isPending ||
                            mergeTagMutation.isPending
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <AdminPagination
                  page={tagResults.page}
                  total={tagResults.total}
                  onChange={setTagPage}
                  label="Tag management pages"
                  focusTargetId="tag-results"
                />
              </>
            ) : (
              <Empty title="No tags match." text="Search with fewer words." />
            )}
          </Panel>

          <Panel
            title="Guestbook moderation"
            label={`${guestbookResults.total} RECORDS`}
            className="md:col-span-2"
          >
            {guestbookResults.items.length ? (
              <>
                <ul
                  id="guestbook-results"
                  tabIndex={-1}
                  className="m-0 list-none p-0 outline-none"
                >
                  {guestbookResults.items.map((entry) => (
                    <li
                      key={entry.id}
                      className="grid gap-2 border-t border-dotted border-line py-2 first:border-t-0 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-center"
                    >
                      <span className="font-mono text-xs">
                        <strong className="block">{entry.name}</strong>
                        <span className="text-muted">{entry.date}</span>
                      </span>
                      <span className="text-sm text-brown">
                        {entry.message}
                      </span>
                      <button
                        type="button"
                        className={`${buttonClass} min-h-9`}
                        disabled={
                          guestbookMutation.isPending &&
                          guestbookMutation.variables.id === entry.id
                        }
                        onClick={() =>
                          changeGuestbookVisibility(entry.id, !entry.hidden)
                        }
                      >
                        {guestbookMutation.isPending &&
                        guestbookMutation.variables.id === entry.id
                          ? 'Saving...'
                          : entry.hidden
                            ? `Restore ${entry.name}`
                            : `Hide ${entry.name}`}
                      </button>
                    </li>
                  ))}
                </ul>
                <AdminPagination
                  page={guestbookResults.page}
                  total={guestbookResults.total}
                  onChange={setGuestbookPage}
                  label="Guestbook moderation pages"
                  focusTargetId="guestbook-results"
                />
              </>
            ) : (
              <Empty
                title="Guestbook is empty."
                text="No entries require moderation."
              />
            )}
          </Panel>
        </div>
      </main>
      <SiteFooter />
      {editingEntry ? (
        <SiteEditor
          entry={editingEntry}
          pending={editMutation.isPending}
          error={editorError}
          onClose={() => setEditingEntry(null)}
          onSubmit={saveEntry}
        />
      ) : null}
      {editingTag ? (
        <TagEditor
          tag={editingTag}
          mergeTarget={mergeTarget}
          onMergeTarget={setMergeTarget}
          pending={saveTagMutation.isPending || mergeTagMutation.isPending}
          error={editorError}
          onClose={() => setEditingTag(null)}
          onSubmit={saveTagRecord}
          onMerge={mergeCurrentTag}
        />
      ) : null}
    </PageShell>
  )
}

function AutomationSection({
  showStatus,
  handleAdminError,
}: {
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
}) {
  const queryClient = useQueryClient()
  const [providerPage, setProviderPage] = useState(0)
  const [policyPage, setPolicyPage] = useState(0)
  const [providerCreatePending, setProviderCreatePending] = useState(false)
  const [jobPage, setJobPage] = useState(0)
  const [jobStatus, setJobStatus] = useState<TaxonomyJobStatus | null>(null)
  const [jobKind, setJobKind] = useState<TaxonomyJobKind | null>(null)
  const [selectedJobs, setSelectedJobs] = useState<string[]>([])
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
      scopes.map((scope) =>
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'admin', 'taxonomy', scope],
        }),
      ),
    )
  }

  const providerActionMutation = useMutation<
    ProviderActionResult,
    Error,
    ProviderActionInput
  >({
    mutationFn: (input) =>
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
  const policyCreateMutation = useMutation({
    mutationFn: (input: TaxonomyPolicyInput) =>
      createTaxonomyPolicy({ data: input }),
  })
  const policyActivateMutation = useMutation({
    mutationFn: (policyConfigId: number) =>
      activateTaxonomyPolicy({ data: { policyConfigId } }),
  })
  const modeMutation = useMutation({
    mutationFn: (mode: TaxonomyMode) =>
      transitionTaxonomyMode({ data: { mode } }),
  })
  const circuitMutation = useMutation({
    mutationFn: () => resetTaxonomyCircuit(),
  })
  const backfillMutation = useMutation({
    mutationFn: (input: { cursor: number; limit: number }) =>
      triggerTaxonomyBackfill({ data: input }),
  })
  const retryMutation = useMutation({
    mutationFn: (jobIds: string[]) => retryTaxonomyJobs({ data: { jobIds } }),
  })
  const rollbackMutation = useMutation({
    mutationFn: (input: RollbackInput) => {
      if (input.kind === 'event')
        return rollbackTaxonomyEvent({ data: { eventId: input.id } })
      if (input.kind === 'site')
        return rollbackTaxonomySite({ data: { siteId: Number(input.id) } })
      return rollbackTaxonomyBatch({ data: { batchId: input.id } })
    },
  })
  const lockCreateMutation = useMutation({
    mutationFn: (input: TaxonomyLockInput) =>
      createTaxonomyLock({ data: input }),
  })
  const lockReleaseMutation = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      releaseTaxonomyLock({ data: input }),
  })
  const candidateDecisionMutation = useMutation({
    mutationFn: (input: {
      candidateId: string
      decision: 'accepted' | 'rejected' | 'deferred' | 'conflict'
      reason: string
    }) => decideTaxonomyCandidate({ data: input }),
  })

  async function submitProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const apiKeyElement = form.elements.namedItem('apiKey')
    if (!(apiKeyElement instanceof HTMLInputElement)) {
      showStatus('Provider API key field is unavailable.', 'error')
      return
    }
    const apiKeyInput = apiKeyElement
    setProviderCreatePending(true)
    try {
      const kindValue = String(data.get('providerKind'))
      if (!isProviderKind(kindValue)) throw new Error('Invalid provider type')
      const routingRoleValue = String(data.get('routingRole'))
      if (!isRoutingRole(routingRoleValue))
        throw new Error('Invalid provider routing role')
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
      const request = createTaxonomyProvider({ data: input })
      input = null
      apiKey = null
      data.delete('apiKey')
      apiKeyInput.value = ''
      const result = await request
      form.reset()
      setProviderKind('openai_compatible')
      await invalidateTaxonomy('providers', 'dashboard')
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
    } finally {
      apiKeyInput.value = ''
      setProviderCreatePending(false)
    }
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
      if ('activated' in result && !result.activated)
        throw new Error('Provider was not activated')
      if ('enabled' in result && !result.enabled)
        throw new Error('Provider was not enabled')
      if ('disabled' in result && !result.disabled)
        throw new Error('Provider was not disabled')
      await invalidateTaxonomy('providers', 'dashboard')
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

  async function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      const input = policyInputFromForm(data)
      await policyCreateMutation.mutateAsync(input)
      await invalidateTaxonomy('policies', 'dashboard')
      showStatus('Safe-controls policy revision created.', 'success')
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
      if (!result.decided) throw new Error('Candidate was already decided')
      await invalidateTaxonomy('candidates', 'jobs', 'dashboard')
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
      if (!result.activated)
        throw new Error('Policy revision was not activated')
      await invalidateTaxonomy('policies', 'dashboard')
      showStatus(
        'Policy revision activated. Elevated modes returned to shadow.',
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not activate policy revision.'),
        'error',
      )
    }
  }

  async function changeMode(mode: TaxonomyMode) {
    try {
      await modeMutation.mutateAsync(mode)
      await invalidateTaxonomy('dashboard')
      showStatus(`Automation mode changed to ${modeLabel(mode)}.`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not change automation mode.'),
        'error',
      )
    }
  }

  async function resetCircuit() {
    if (
      !window.confirm('Reset the circuit and return automation to shadow mode?')
    )
      return
    try {
      await circuitMutation.mutateAsync()
      await invalidateTaxonomy('dashboard')
      showStatus('Circuit reset. Automation is in shadow mode.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not reset the circuit.'),
        'error',
      )
    }
  }

  async function runBackfill(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const form = event?.currentTarget
    const limit = form
      ? numberFromForm(new FormData(form), 'limit')
      : backfillMutation.variables?.limit || 25
    try {
      const result = await backfillMutation.mutateAsync({
        cursor: backfillCursor ?? 0,
        limit,
      })
      setBackfillCursor(result.nextCursor)
      await invalidateTaxonomy('dashboard', 'jobs')
      showStatus(
        `Backfill scanned ${result.scanned} sites and queued ${result.enqueued}.${result.nextCursor === null ? ' Backfill complete.' : ''}`,
        result.nextCursor === null ? 'success' : '',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not continue taxonomy backfill.'),
        'error',
      )
    }
  }

  async function retrySelectedJobs() {
    if (!selectedJobs.length) return
    if (
      !window.confirm(
        `Retry ${selectedJobs.length} selected dead or settled jobs?`,
      )
    )
      return
    try {
      const result = await retryMutation.mutateAsync(selectedJobs)
      setSelectedJobs([])
      await invalidateTaxonomy('jobs', 'dashboard')
      showStatus(`${result.retried} jobs returned to the queue.`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not retry selected jobs.'),
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
      await invalidateTaxonomy('locks', 'dashboard')
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
      await lockReleaseMutation.mutateAsync({ id, reason })
      await invalidateTaxonomy('locks', 'dashboard')
      showStatus('Automation lock released.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not release automation lock.'),
        'error',
      )
    }
  }

  const initialPolicy: TaxonomyPolicyInput =
    policyDefaults.items.at(0) ?? defaultTaxonomyPolicy
  const modeOptions: TaxonomyMode[] = [
    'disabled',
    'shadow',
    'gradual',
    'autonomous',
  ]

  return (
    <section
      className="mt-3 border-2 border-ink bg-canvas p-2.5"
      aria-labelledby="automation-title"
    >
      <header className="mb-2.5 border-b-2 border-ink bg-brown p-3 text-paper">
        <p className="m-0 font-mono text-[11px] tracking-[0.08em] uppercase">
          Taxonomy operations
        </p>
        <h2 id="automation-title" className="m-0 font-mono text-2xl font-bold">
          Automation
        </h2>
      </header>

      <dl className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <AutomationMetric
          label="Health"
          value={dashboard.health.healthy ? 'Healthy' : 'Degraded'}
          note={`Mode: ${modeLabel(dashboard.state.mode)}`}
        />
        <AutomationMetric
          label="Published version"
          value={String(dashboard.state.publishedVersion)}
          note={`Provider #${dashboard.state.activeProviderConfigId ?? '-'} / Policy #${dashboard.state.activePolicyConfigId ?? '-'}`}
        />
        <AutomationMetric
          label="Circuit"
          value={humanize(dashboard.state.circuitState)}
          note={dashboard.state.circuitReason || 'No active trip reason'}
        />
        <AutomationMetric
          label="Daily budget"
          value={`${dashboard.health.budget.requests.toLocaleString('en')} / ${dashboard.health.budget.requestLimit?.toLocaleString('en') ?? 'not configured'}`}
          note={`${dashboard.health.budget.tokens.toLocaleString('en')} / ${dashboard.health.budget.tokenLimit?.toLocaleString('en') ?? 'not configured'} tokens`}
        />
      </dl>

      <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_1fr]">
        <AutomationBox title="Counts and 24-hour circuit signals">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries({
              'Enabled providers': dashboard.counts.enabledProviders,
              'Queued jobs': dashboard.counts.queuedJobs,
              'Dead jobs': dashboard.counts.deadJobs,
              'Active locks': dashboard.counts.activeLocks,
              'Proposed concepts': dashboard.counts.proposedCandidates,
              'Unclassified sites': dashboard.counts.unclassifiedSites,
              Attempts: dashboard.health.circuit.attempts,
              'Schema failures': dashboard.health.circuit.schemaFailures,
              Disagreements: dashboard.health.circuit.disagreements,
              Rollbacks: dashboard.health.circuit.rollbacks,
              Mutations: dashboard.health.circuit.mutations,
            }).map(([label, value]) => (
              <div key={label} className="border border-line bg-paper p-2">
                <dt className="font-mono text-[11px] text-muted uppercase">
                  {label}
                </dt>
                <dd className="m-0 font-mono text-lg font-bold">
                  {value.toLocaleString('en')}
                </dd>
              </div>
            ))}
          </dl>
        </AutomationBox>

        <AutomationBox
          title="Readiness gate"
          label={dashboard.readiness.readyForGradual ? 'READY' : 'BLOCKED'}
        >
          <ul className="m-0 grid list-none gap-1 p-0 sm:grid-cols-2">
            {Object.entries(dashboard.readiness.checks).map(
              ([check, passed]) => (
                <li
                  key={check}
                  className="flex justify-between border border-line bg-paper p-2 text-sm"
                >
                  <span>{humanize(check)}</span>
                  <strong className={passed ? 'text-success' : 'text-danger'}>
                    {passed ? 'Pass' : 'Fail'}
                  </strong>
                </li>
              ),
            )}
          </ul>
          <p className="mt-2 mb-0 font-mono text-xs text-muted">
            Samples {dashboard.readiness.metrics.samples}/
            {dashboard.readiness.thresholds.samples ?? 'not configured'};
            coverage{' '}
            {basisPoints(dashboard.readiness.metrics.coverageBasisPoints)}/
            {optionalBasisPoints(
              dashboard.readiness.thresholds.coverageBasisPoints,
            )}
            ; schema{' '}
            {basisPoints(dashboard.readiness.metrics.schemaSuccessBasisPoints)}/
            {optionalBasisPoints(
              dashboard.readiness.thresholds.schemaSuccessBasisPoints,
            )}
            ; agreement{' '}
            {basisPoints(dashboard.readiness.metrics.agreementBasisPoints)}/
            {optionalBasisPoints(
              dashboard.readiness.thresholds.agreementBasisPoints,
            )}
            .
          </p>
        </AutomationBox>
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <AutomationBox title="Mode and circuit controls">
          <fieldset
            className="m-0 border-0 p-0"
            aria-describedby="automation-mode-help"
          >
            <legend className="sr-only">Automation mode</legend>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Automation mode controls"
            >
              {modeOptions.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`${buttonClass} min-h-9 ${dashboard.state.mode === mode ? '!bg-brown !text-paper' : ''}`}
                  disabled={
                    modeMutation.isPending ||
                    dashboard.state.mode === mode ||
                    (mode !== 'disabled' &&
                      (dashboard.state.activeProviderConfigId === null ||
                        dashboard.state.activePolicyConfigId === null)) ||
                    !canTransitionMode(
                      dashboard.state.mode,
                      mode,
                      dashboard.readiness.readyForGradual,
                      dashboard.state.circuitState,
                    )
                  }
                  aria-describedby={`automation-mode-help automation-mode-${mode}-reason`}
                  title={modeDisabledReason(
                    dashboard.state,
                    mode,
                    dashboard.readiness.readyForGradual,
                  )}
                  onClick={() => changeMode(mode)}
                >
                  {modeMutation.isPending && modeMutation.variables === mode
                    ? 'Changing...'
                    : modeLabel(mode)}
                </button>
              ))}
              <button
                type="button"
                className={`${dangerButtonClass} min-h-9`}
                disabled={circuitMutation.isPending}
                onClick={resetCircuit}
              >
                {circuitMutation.isPending ? 'Resetting...' : 'Reset circuit'}
              </button>
            </div>
            {modeOptions.map((mode) => (
              <span
                key={mode}
                id={`automation-mode-${mode}-reason`}
                className="sr-only"
              >
                {modeDisabledReason(
                  dashboard.state,
                  mode,
                  dashboard.readiness.readyForGradual,
                )}
              </span>
            ))}
          </fieldset>
          <p id="automation-mode-help" className="mt-2 mb-0 text-xs text-muted">
            Promotion is sequential: disabled to shadow, shadow to gradual after
            the readiness gate, then gradual to autonomous. Degraded mode
            requires a circuit reset.
          </p>
        </AutomationBox>

        <AutomationBox title="Bounded classification backfill">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={runBackfill}
          >
            <label className="min-w-32 flex-1">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Batch limit
              </span>
              <input
                className={fieldClass}
                type="number"
                name="limit"
                min="1"
                max="100"
                defaultValue="25"
                required
              />
            </label>
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={backfillMutation.isPending || backfillCursor === null}
            >
              {backfillMutation.isPending
                ? 'Queueing...'
                : backfillCursor === 0
                  ? 'Start backfill'
                  : backfillCursor === null
                    ? 'Backfill complete'
                    : 'Continue backfill'}
            </button>
            {backfillCursor === null ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => setBackfillCursor(0)}
              >
                Start over
              </button>
            ) : null}
          </form>
          <p className="mt-2 mb-0 font-mono text-xs text-muted">
            Next cursor: {backfillCursor ?? 'complete'}
          </p>
        </AutomationBox>
      </div>

      <div className="mt-2 grid items-start gap-2 xl:grid-cols-[1.1fr_.9fr]">
        <AutomationBox
          title="Provider configurations"
          label={`${providers.total} REVISIONS`}
        >
          {providers.items.length ? (
            <>
              <ul
                id="taxonomy-provider-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none sm:grid-cols-2"
              >
                {providers.items.map((provider) => {
                  const pending =
                    providerActionMutation.isPending &&
                    providerActionMutation.variables.providerConfigId ===
                      Number(provider.id)
                  return (
                    <li
                      key={String(provider.id)}
                      className="flex min-w-0 flex-col justify-between border border-line bg-paper p-2"
                    >
                      <div>
                        <strong className="block">
                          {String(provider.name)}
                        </strong>
                        <span className="font-mono text-xs text-muted">
                          #{String(provider.id)} r{String(provider.revision)} /{' '}
                          {humanize(String(provider.providerKind))}
                          <br />
                          {String(provider.model)}
                        </span>
                      </div>
                      <p className="my-2 font-mono text-xs [overflow-wrap:anywhere]">
                        {String(provider.routingGroup)} /{' '}
                        {humanize(String(provider.routingRole))}{' '}
                        {String(provider.routingPriority)}
                        <br />
                        {String(provider.endpoint)}
                        <br />
                        {String(provider.timeoutMs)} ms
                      </p>
                      <p className="my-1 font-mono text-xs">
                        {String(provider.credentialFingerprint)}
                      </p>
                      <strong className="mb-2 block font-mono text-xs uppercase">
                        {provider.active
                          ? 'Active'
                          : provider.enabled
                            ? 'Enabled'
                            : 'Disabled'}
                      </strong>
                      <div>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={pending}
                            onClick={() =>
                              runProviderAction('test', Number(provider.id))
                            }
                          >
                            {pending &&
                            providerActionMutation.variables.action === 'test'
                              ? 'Testing...'
                              : 'Test'}
                          </button>
                          {!provider.active && provider.enabled ? (
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={pending}
                              onClick={() =>
                                runProviderAction(
                                  'activate',
                                  Number(provider.id),
                                )
                              }
                            >
                              Activate
                            </button>
                          ) : null}
                          {!provider.enabled ? (
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={pending}
                              onClick={() =>
                                runProviderAction('enable', provider.id)
                              }
                            >
                              {pending &&
                              providerActionMutation.variables.action ===
                                'enable'
                                ? 'Testing...'
                                : 'Test and enable'}
                            </button>
                          ) : null}
                          {provider.enabled ? (
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={pending}
                              onClick={() =>
                                runProviderAction(
                                  'disable',
                                  Number(provider.id),
                                )
                              }
                            >
                              Disable
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <AdminPagination
                page={providers.page}
                total={providers.total}
                pageSize={automationPageSize}
                onChange={setProviderPage}
                label="Provider configuration pages"
                focusTargetId="taxonomy-provider-results"
              />
            </>
          ) : (
            <Empty
              title="No providers."
              text="Create a provider configuration to begin shadow evaluation."
            />
          )}
        </AutomationBox>

        <AutomationBox title="Create provider">
          <form onSubmit={submitProvider} autoComplete="off">
            <fieldset
              disabled={providerCreatePending}
              className="m-0 min-w-0 border-0 p-0"
            >
              <div className="grid gap-x-2 sm:grid-cols-2">
                <AutomationInput
                  label="Configuration name"
                  name="name"
                  placeholder="Production classifier"
                  maxLength={100}
                />
                <label className="mb-2.5 block">
                  <span className="mb-1 block font-mono text-xs font-bold uppercase">
                    Provider type
                  </span>
                  <select
                    name="providerKind"
                    className={fieldClass}
                    value={providerKind}
                    onChange={(event) =>
                      setProviderKind(event.target.value as typeof providerKind)
                    }
                  >
                    <option value="openai_compatible">OpenAI-compatible</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
                <AutomationInput
                  label="Endpoint"
                  name="endpoint"
                  type="url"
                  placeholder={
                    providerKind === 'gemini'
                      ? 'https://generativelanguage.googleapis.com/...'
                      : 'https://api.openai.com/v1/...'
                  }
                />
                <AutomationInput
                  label="Model"
                  name="model"
                  placeholder="Model identifier"
                  maxLength={200}
                />
                {providerKind === 'openai_compatible' ? (
                  <label className="mb-2.5 block">
                    <span className="mb-1 block font-mono text-xs font-bold uppercase">
                      Dialect
                    </span>
                    <select name="dialect" className={fieldClass}>
                      <option value="responses">Responses API</option>
                      <option value="chat_completions">Chat completions</option>
                    </select>
                  </label>
                ) : null}
                <AutomationInput
                  label="Routing group"
                  name="routingGroup"
                  placeholder="default"
                  defaultValue="default"
                  maxLength={100}
                />
                <label className="mb-2.5 block">
                  <span className="mb-1 block font-mono text-xs font-bold uppercase">
                    Routing role
                  </span>
                  <select name="routingRole" className={fieldClass}>
                    <option value="primary">Primary</option>
                    <option value="failover">Failover</option>
                    <option value="consensus">Consensus</option>
                  </select>
                </label>
                <AutomationInput
                  label="Routing priority"
                  name="routingPriority"
                  type="number"
                  placeholder="0"
                  defaultValue="0"
                  min="0"
                  max="10000"
                />
                <AutomationInput
                  label="Timeout (ms)"
                  name="timeoutMs"
                  type="number"
                  placeholder="30000"
                  defaultValue="30000"
                  min="1000"
                  max="120000"
                />
                <AutomationInput
                  label="API key"
                  name="apiKey"
                  type="password"
                  placeholder="Cleared immediately after submit"
                  autoComplete="new-password"
                  maxLength={5000}
                />
              </div>
              <label className="mb-2.5 flex items-center gap-2 border border-dotted border-line bg-paper p-2">
                <input type="checkbox" name="enabled" defaultChecked />{' '}
                <span>Enable this revision after creation</span>
              </label>
              <button type="submit" className={primaryButtonClass}>
                {providerCreatePending ? 'Creating...' : 'Create provider'}
              </button>
            </fieldset>
            <p className="mt-2 mb-0 text-xs text-muted">
              Credentials are encrypted server-side. The key field is cleared
              before the request completes and is never returned.
            </p>
          </form>
        </AutomationBox>
      </div>

      <div className="mt-2 grid items-start gap-2 xl:grid-cols-[.8fr_1.2fr]">
        <AutomationBox
          title="Policy revisions"
          label={`${policies.total} REVISIONS`}
        >
          {policies.items.length ? (
            <>
              <ul
                id="taxonomy-policy-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none"
              >
                {policies.items.map((policy) => (
                  <li
                    key={String(policy.id)}
                    className="border border-line bg-paper p-2"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <strong className="font-mono">
                          Revision {String(policy.revision)}
                        </strong>
                        <span className="ml-2 text-xs text-muted">
                          #{String(policy.id)} /{' '}
                          {formatTimestamp(policy.createdAt)} /{' '}
                          {String(policy.createdBy)}
                        </span>
                      </div>
                      {policy.active ? (
                        <strong className="border border-success px-1.5 py-0.5 font-mono text-xs text-success uppercase">
                          Active
                        </strong>
                      ) : (
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={policyActivateMutation.isPending}
                          onClick={() => activatePolicy(Number(policy.id))}
                        >
                          {policyActivateMutation.isPending &&
                          policyActivateMutation.variables === Number(policy.id)
                            ? 'Activating...'
                            : 'Activate'}
                        </button>
                      )}
                    </div>
                    <p className="mt-1 mb-0 font-mono text-xs text-muted">
                      Assignments {String(policy.assignmentLimit)} / rollout{' '}
                      {basisPoints(Number(policy.rolloutBasisPoints))} /
                      requests{' '}
                      {Number(policy.dailyRequestBudget).toLocaleString('en')} /
                      tokens{' '}
                      {Number(policy.dailyTokenBudget).toLocaleString('en')}
                    </p>
                  </li>
                ))}
              </ul>
              <AdminPagination
                page={policies.page}
                total={policies.total}
                pageSize={automationPageSize}
                onChange={setPolicyPage}
                label="Policy revision pages"
                focusTargetId="taxonomy-policy-results"
              />
            </>
          ) : (
            <Empty
              title="No policy revisions."
              text="Create the initial safe-controls policy."
            />
          )}
        </AutomationBox>

        <AutomationBox title="Create safe-controls revision">
          <form
            key={String('id' in initialPolicy ? initialPolicy.id : 'default')}
            onSubmit={submitPolicy}
          >
            <div className="grid gap-x-2 sm:grid-cols-2 lg:grid-cols-3">
              {policyFields.map((field) => (
                <AutomationInput
                  key={field.name}
                  label={field.label}
                  name={field.name}
                  type={field.type || 'number'}
                  placeholder={field.placeholder || ''}
                  defaultValue={String(initialPolicy[field.name])}
                  min={field.min}
                  max={field.max}
                  maxLength={field.maxLength}
                  pattern={field.pattern}
                  step="1"
                />
              ))}
            </div>
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={policyCreateMutation.isPending}
            >
              {policyCreateMutation.isPending
                ? 'Creating...'
                : 'Create policy revision'}
            </button>
            <p className="mt-2 mb-0 text-xs text-muted">
              Values are initialized from the active revision, or conservative
              defaults when no revision exists. Creation does not activate the
              revision.
            </p>
          </form>
        </AutomationBox>
      </div>

      <div className="mt-2">
        <AutomationBox
          title="Ontology candidates"
          label={`${candidates.total} RECORDS`}
        >
          <div className="mb-2 grid gap-2 sm:grid-cols-2">
            <label>
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Candidate status
              </span>
              <select
                className={fieldClass}
                value={candidateStatus ?? ''}
                onChange={(event) => {
                  setCandidateStatus(parseCandidateStatus(event.target.value))
                  setCandidatePage(0)
                }}
              >
                <option value="">All statuses</option>
                {candidateStatusOptions.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Candidate kind
              </span>
              <select
                className={fieldClass}
                value={candidateKind ?? ''}
                onChange={(event) => {
                  setCandidateKind(parseCandidateKind(event.target.value))
                  setCandidatePage(0)
                }}
              >
                <option value="">All kinds</option>
                {candidateKindOptions.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {candidates.items.length ? (
            <>
              <ul
                id="taxonomy-candidate-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none lg:grid-cols-2"
              >
                {candidates.items.map((candidate) => {
                  const pending =
                    candidateDecisionMutation.isPending &&
                    candidateDecisionMutation.variables.candidateId ===
                      candidate.id
                  return (
                    <li
                      key={candidate.id}
                      className="min-w-0 border border-line bg-paper p-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <strong className="block">
                            {humanize(candidate.kind)}
                          </strong>
                          <span className="font-mono text-xs text-muted [overflow-wrap:anywhere]">
                            {candidate.id}
                            <br />
                            Job {candidate.jobId}
                          </span>
                        </div>
                        <strong className="font-mono text-xs uppercase">
                          {humanize(candidate.status)}
                        </strong>
                      </div>
                      <dl className="my-2 grid grid-cols-2 gap-1 text-xs">
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Confidence
                          </dt>
                          <dd className="m-0">
                            {microsPercent(candidate.confidenceMicros)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Margin
                          </dt>
                          <dd className="m-0">
                            {candidate.marginMicros === null
                              ? '-'
                              : microsPercent(candidate.marginMicros)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Tag IDs
                          </dt>
                          <dd className="m-0">
                            {candidate.tagId ?? '-'} /{' '}
                            {candidate.relatedTagId ?? '-'}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Proposed
                          </dt>
                          <dd className="m-0 [overflow-wrap:anywhere]">
                            {candidate.proposedName ||
                              candidate.normalizedConcept ||
                              '-'}{' '}
                            {candidate.proposedSlug
                              ? `(${candidate.proposedSlug})`
                              : ''}
                          </dd>
                        </div>
                      </dl>
                      <details className="border border-dotted border-line p-2">
                        <summary className="cursor-pointer font-mono text-xs font-bold uppercase">
                          Payload and evidence
                        </summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">
                          {JSON.stringify(candidate.payload, null, 2)}
                        </pre>
                        {candidate.evidence.length ? (
                          <ul className="m-0 list-none p-0">
                            {candidate.evidence.map((evidence, index) => (
                              <li
                                key={`${evidence.siteId}:${index}`}
                                className="border-t border-dotted border-line py-1 text-xs"
                              >
                                Site #{evidence.siteId}: {evidence.snippet} (
                                {microsPercent(evidence.confidenceMicros)},{' '}
                                {humanize(evidence.source)})
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mb-0 text-xs text-muted">
                            No linked concept evidence.
                          </p>
                        )}
                      </details>
                      {candidate.decisionReason ? (
                        <p className="mt-2 mb-0 text-xs text-muted">
                          Decision: {candidate.decisionReason}
                        </p>
                      ) : null}
                      {candidate.status === 'proposed' ? (
                        <form
                          className="mt-2 grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)_auto]"
                          onSubmit={(event) =>
                            decideCandidate(event, candidate.id)
                          }
                        >
                          <label>
                            <span className="sr-only">
                              Decision for {candidate.id}
                            </span>
                            <select
                              name="decision"
                              className={fieldClass}
                              defaultValue="deferred"
                            >
                              {candidate.kind !== 'existing_tag' ? (
                                <option value="accepted">
                                  Accept and queue
                                </option>
                              ) : null}
                              <option value="rejected">Reject</option>
                              <option value="deferred">Defer</option>
                              <option value="conflict">Mark conflict</option>
                            </select>
                          </label>
                          <label>
                            <span className="sr-only">
                              Reason for {candidate.id}
                            </span>
                            <input
                              name="reason"
                              className={fieldClass}
                              placeholder="Required decision reason"
                              maxLength={500}
                              required
                            />
                          </label>
                          <button
                            type="submit"
                            className={buttonClass}
                            disabled={pending}
                          >
                            {pending ? 'Saving...' : 'Apply decision'}
                          </button>
                        </form>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              <AdminPagination
                page={candidates.page}
                total={candidates.total}
                pageSize={automationPageSize}
                onChange={setCandidatePage}
                label="Ontology candidate pages"
                focusTargetId="taxonomy-candidate-results"
              />
            </>
          ) : (
            <Empty
              title="No candidates match."
              text="Change the status or kind filter."
            />
          )}
        </AutomationBox>
      </div>

      <div className="mt-2">
        <AutomationBox title="Automation jobs" label={`${jobs.total} RECORDS`}>
          <div className="mb-2 flex flex-wrap items-end gap-2">
            <label className="min-w-44 flex-1">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Job status
              </span>
              <select
                className={fieldClass}
                value={jobStatus || ''}
                onChange={(event) => {
                  setJobStatus(
                    (event.target.value || null) as TaxonomyJobStatus | null,
                  )
                  setJobPage(0)
                  setSelectedJobs([])
                }}
              >
                <option value="">All statuses</option>
                {jobStatusOptions.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-44 flex-1">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Job kind
              </span>
              <select
                className={fieldClass}
                value={jobKind || ''}
                onChange={(event) => {
                  setJobKind(
                    (event.target.value || null) as TaxonomyJobKind | null,
                  )
                  setJobPage(0)
                  setSelectedJobs([])
                }}
              >
                <option value="">All kinds</option>
                {jobKindOptions.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!selectedJobs.length || retryMutation.isPending}
              onClick={retrySelectedJobs}
            >
              {retryMutation.isPending
                ? 'Retrying...'
                : `Retry selected (${selectedJobs.length})`}
            </button>
          </div>
          {jobs.items.length ? (
            <>
              <ul className="m-0 grid list-none gap-2 p-0 md:hidden">
                {jobs.items.map((job) => {
                  const id = String(job.id)
                  const retryable =
                    job.status === 'dead' || job.status === 'settled'
                  return (
                    <li key={id} className="border border-line bg-paper p-2">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Select job ${id} for retry`}
                          disabled={!retryable}
                          checked={selectedJobs.includes(id)}
                          onChange={(event) =>
                            setSelectedJobs((current) =>
                              event.target.checked
                                ? [...new Set([...current, id])]
                                : current.filter((value) => value !== id),
                            )
                          }
                        />
                        <div className="min-w-0">
                          <strong className="block">
                            {humanize(String(job.kind))} /{' '}
                            {humanize(String(job.status))}
                          </strong>
                          <span className="block font-mono text-xs text-muted [overflow-wrap:anywhere]">
                            {id}
                          </span>
                          <p className="my-1 font-mono text-xs">
                            {job.siteId
                              ? `Site #${String(job.siteId)}`
                              : String(job.conceptKey || '-')}{' '}
                            / taxonomy v{String(job.taxonomyVersion)}
                            <br />
                            Attempts {String(job.attemptCount)} /{' '}
                            {String(job.maxAttempts)} (
                            {String(job.recordedAttempts)} recorded)
                          </p>
                          {job.lastErrorCode ? (
                            <p className="mb-0 text-xs text-danger [overflow-wrap:anywhere]">
                              {String(job.lastErrorCode)}:{' '}
                              {String(job.lastErrorSummary || '')}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <div className="hidden overflow-x-auto border border-line md:block">
                <table
                  id="taxonomy-job-results"
                  tabIndex={-1}
                  className="w-full min-w-[900px] border-collapse outline-none"
                >
                  <caption className="sr-only">
                    Taxonomy automation jobs
                  </caption>
                  <thead>
                    <tr className="bg-brown text-left font-mono text-xs text-paper uppercase">
                      <th className="p-2">
                        <span className="sr-only">Select retryable job</span>
                      </th>
                      <th className="p-2">Job</th>
                      <th className="p-2">Target</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Attempts</th>
                      <th className="p-2">Error</th>
                      <th className="p-2">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.items.map((job) => {
                      const id = String(job.id)
                      const retryable =
                        job.status === 'dead' || job.status === 'settled'
                      return (
                        <tr
                          key={id}
                          className="border-b border-dotted border-line last:border-0"
                        >
                          <td className="p-2 align-top">
                            <input
                              type="checkbox"
                              aria-label={`Select job ${id} for retry`}
                              disabled={!retryable}
                              checked={selectedJobs.includes(id)}
                              onChange={(event) =>
                                setSelectedJobs((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, id])]
                                    : current.filter((value) => value !== id),
                                )
                              }
                            />
                          </td>
                          <td className="p-2 align-top">
                            <strong className="block font-mono text-xs">
                              {humanize(String(job.kind))}
                            </strong>
                            <span className="font-mono text-[11px] text-muted">
                              {id}
                            </span>
                          </td>
                          <td className="p-2 align-top font-mono text-xs">
                            {job.siteId
                              ? `Site #${String(job.siteId)}`
                              : job.conceptKey
                                ? String(job.conceptKey)
                                : '-'}
                            <br />
                            Taxonomy v{String(job.taxonomyVersion)}
                          </td>
                          <td className="p-2 align-top">
                            {humanize(String(job.status))}
                          </td>
                          <td className="p-2 align-top font-mono text-xs">
                            {String(job.attemptCount)} /{' '}
                            {String(job.maxAttempts)} (
                            {String(job.recordedAttempts)} recorded)
                          </td>
                          <td className="max-w-64 p-2 align-top text-xs [overflow-wrap:anywhere]">
                            {job.lastErrorCode
                              ? `${String(job.lastErrorCode)}: ${String(job.lastErrorSummary || '')}`
                              : '-'}
                          </td>
                          <td className="p-2 align-top font-mono text-xs">
                            {formatTimestamp(job.updatedAt)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <AdminPagination
                page={jobs.page}
                total={jobs.total}
                pageSize={automationPageSize}
                onChange={(page) => {
                  setJobPage(page)
                  setSelectedJobs([])
                }}
                label="Automation job pages"
                focusTargetId="taxonomy-job-results"
              />
            </>
          ) : (
            <Empty
              title="No jobs match."
              text="Change the status or kind filter."
            />
          )}
        </AutomationBox>
      </div>

      <div className="mt-2">
        <AutomationBox
          title="Provider attempts"
          label={`${attempts.total} RECORDS`}
        >
          <label className="mb-2 block max-w-xl">
            <span className="mb-1 block font-mono text-xs font-bold uppercase">
              Exact job ID
            </span>
            <input
              className={fieldClass}
              value={attemptJobId}
              onChange={(event) => {
                setAttemptJobId(event.target.value)
                setAttemptPage(0)
              }}
              placeholder="Filter attempts by job ID"
            />
          </label>
          {attempts.items.length ? (
            <>
              <ul
                id="taxonomy-attempt-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none md:grid-cols-2"
              >
                {attempts.items.map((attempt) => (
                  <li
                    key={attempt.id}
                    className="min-w-0 border border-line bg-paper p-2"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong>{humanize(attempt.status)}</strong>
                      <span className="font-mono text-xs">
                        Attempt {attempt.attemptNumber}
                      </span>
                    </div>
                    <p className="my-1 font-mono text-xs text-muted [overflow-wrap:anywhere]">
                      {attempt.id}
                      <br />
                      Job {attempt.jobId}
                      <br />
                      {attempt.providerModel || 'Unknown model'} / provider #
                      {attempt.providerConfigId ?? '-'}
                    </p>
                    <details>
                      <summary className="cursor-pointer font-mono text-xs font-bold uppercase">
                        Request metadata
                      </summary>
                      <dl className="mt-2 grid gap-1 text-xs">
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Provider request
                          </dt>
                          <dd className="m-0 [overflow-wrap:anywhere]">
                            {attempt.providerRequestId || '-'}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Hashes
                          </dt>
                          <dd className="m-0 [overflow-wrap:anywhere]">
                            Request {attempt.requestHash}
                            <br />
                            Response {attempt.responseHash || '-'}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Usage and latency
                          </dt>
                          <dd className="m-0">
                            {attempt.inputTokens ?? '-'} input /{' '}
                            {attempt.outputTokens ?? '-'} output /{' '}
                            {attempt.latencyMs ?? '-'} ms
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-muted uppercase">
                            Timing
                          </dt>
                          <dd className="m-0">
                            {formatTimestamp(attempt.startedAt)} to{' '}
                            {attempt.completedAt
                              ? formatTimestamp(attempt.completedAt)
                              : 'in progress'}
                          </dd>
                        </div>
                        {attempt.errorCode || attempt.errorSummary ? (
                          <div>
                            <dt className="font-mono text-danger uppercase">
                              Error
                            </dt>
                            <dd className="m-0 text-danger">
                              {attempt.errorCode || 'error'}:{' '}
                              {attempt.errorSummary || '-'}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </details>
                  </li>
                ))}
              </ul>
              <AdminPagination
                page={attempts.page}
                total={attempts.total}
                pageSize={automationPageSize}
                onChange={setAttemptPage}
                label="Provider attempt pages"
                focusTargetId="taxonomy-attempt-results"
              />
            </>
          ) : (
            <Empty
              title="No attempts match."
              text="Clear or change the job ID filter."
            />
          )}
        </AutomationBox>
      </div>

      <div className="mt-2 grid items-start gap-2 xl:grid-cols-2">
        <AutomationBox title="Audit events" label={`${audit.total} RECORDS`}>
          <div className="mb-2 grid gap-2 sm:grid-cols-2">
            <label>
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Batch ID
              </span>
              <input
                className={fieldClass}
                value={auditBatch}
                onChange={(event) => {
                  setAuditBatch(event.target.value)
                  setAuditPage(0)
                }}
                placeholder="Exact batch ID"
              />
            </label>
            <label>
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Entity type
              </span>
              <input
                className={fieldClass}
                value={auditEntity}
                onChange={(event) => {
                  setAuditEntity(event.target.value)
                  setAuditPage(0)
                }}
                placeholder="site_assignment, tag..."
              />
            </label>
          </div>
          {audit.items.length ? (
            <>
              <ul
                id="taxonomy-audit-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none"
              >
                {audit.items.map((event) => {
                  const eventId = String(event.id)
                  const siteId =
                    event.entityType === 'site_assignment' &&
                    /^\d+$/.test(String(event.entityId))
                      ? Number(event.entityId)
                      : null
                  const pending =
                    rollbackMutation.isPending &&
                    rollbackMutation.variables.id === eventId
                  return (
                    <li
                      key={eventId}
                      className="border border-line bg-paper p-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <strong className="block">
                            {humanize(String(event.eventType))}
                          </strong>
                          <span className="font-mono text-xs text-muted">
                            {eventId} / {String(event.entityType)}{' '}
                            {String(event.entityId)} /{' '}
                            {formatTimestamp(event.createdAt)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={pending || rollbackMutation.isPending}
                            onClick={() =>
                              rollback(
                                { kind: 'event', id: eventId },
                                `event ${eventId}`,
                              )
                            }
                          >
                            Rollback event
                          </button>
                          {siteId ? (
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={rollbackMutation.isPending}
                              onClick={() =>
                                rollback(
                                  { kind: 'site', id: String(siteId) },
                                  `site #${siteId}`,
                                )
                              }
                            >
                              Rollback site
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-1 mb-0 font-mono text-xs text-muted">
                        Batch {String(event.batchId || '-')} / actor{' '}
                        {String(event.actorType)}:{String(event.actorId || '-')}{' '}
                        / versions {String(event.taxonomyVersionBefore ?? '-')}{' '}
                        to {String(event.taxonomyVersionAfter ?? '-')}
                      </p>
                    </li>
                  )
                })}
              </ul>
              <AdminPagination
                page={audit.page}
                total={audit.total}
                pageSize={automationPageSize}
                onChange={setAuditPage}
                label="Taxonomy audit event pages"
                focusTargetId="taxonomy-audit-results"
              />
            </>
          ) : (
            <Empty
              title="No audit events match."
              text="Change or clear the audit filters."
            />
          )}
        </AutomationBox>

        <AutomationBox
          title="Change batches"
          label={`${batches.total} RECORDS`}
        >
          <label className="mb-2 block">
            <span className="mb-1 block font-mono text-xs font-bold uppercase">
              Batch status
            </span>
            <select
              className={fieldClass}
              value={batchStatus || ''}
              onChange={(event) => {
                setBatchStatus(
                  (event.target.value || null) as TaxonomyBatchStatus | null,
                )
                setBatchPage(0)
              }}
            >
              <option value="">All statuses</option>
              {batchStatusOptions.map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </label>
          {batches.items.length ? (
            <>
              <ul
                id="taxonomy-batch-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none"
              >
                {batches.items.map((batch) => {
                  const id = String(batch.id)
                  const rolledBack =
                    batch.status === 'rolled_back' ||
                    batch.status === 'rolling_back'
                  return (
                    <li key={id} className="border border-line bg-paper p-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <strong className="block">
                            {humanize(String(batch.kind))} /{' '}
                            {humanize(String(batch.status))}
                          </strong>
                          <span className="font-mono text-xs text-muted">
                            {id} / {String(batch.eventCount)} events /{' '}
                            {formatTimestamp(batch.createdAt)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={rolledBack || rollbackMutation.isPending}
                          onClick={() =>
                            rollback({ kind: 'batch', id }, `batch ${id}`)
                          }
                        >
                          Rollback batch
                        </button>
                      </div>
                      <p className="mt-1 mb-0 text-xs text-muted">
                        {String(batch.summary)} / version{' '}
                        {String(batch.expectedTaxonomyVersion)} to{' '}
                        {String(batch.resultingTaxonomyVersion ?? '-')}
                      </p>
                    </li>
                  )
                })}
              </ul>
              <AdminPagination
                page={batches.page}
                total={batches.total}
                pageSize={automationPageSize}
                onChange={setBatchPage}
                label="Taxonomy change batch pages"
                focusTargetId="taxonomy-batch-results"
              />
            </>
          ) : (
            <Empty
              title="No batches match."
              text="Change the batch status filter."
            />
          )}
        </AutomationBox>
      </div>

      <div className="mt-2 grid items-start gap-2 xl:grid-cols-[1.2fr_.8fr]">
        <AutomationBox
          title="Automation locks"
          label={`${locks.total} RECORDS`}
        >
          <label className="mb-2 block max-w-xs">
            <span className="mb-1 block font-mono text-xs font-bold uppercase">
              Lock state
            </span>
            <select
              className={fieldClass}
              value={lockState}
              onChange={(event) => {
                setLockState(event.target.value as typeof lockState)
                setLockPage(0)
              }}
            >
              <option value="active">Active</option>
              <option value="released">Released</option>
              <option value="all">All</option>
            </select>
          </label>
          {locks.items.length ? (
            <>
              <ul
                id="taxonomy-lock-results"
                tabIndex={-1}
                className="m-0 grid list-none gap-2 p-0 outline-none"
              >
                {locks.items.map((lock) => {
                  const id = String(lock.id)
                  return (
                    <li key={id} className="border border-line bg-paper p-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <strong className="block">
                            {humanize(String(lock.scope))}
                          </strong>
                          <span className="font-mono text-xs text-muted">
                            {id} / {String(lock.resourceKey)} / r
                            {String(lock.revision)}
                          </span>
                        </div>
                        <span className="font-mono text-xs">
                          {lock.releasedAt
                            ? `Released ${formatTimestamp(lock.releasedAt)}`
                            : 'Active'}
                        </span>
                      </div>
                      <p className="my-1 text-sm">{String(lock.reason)}</p>
                      {!lock.releasedAt ? (
                        <form
                          className="flex flex-wrap items-end gap-1"
                          onSubmit={(event) => releaseLock(event, id)}
                        >
                          <label className="min-w-52 flex-1">
                            <span className="sr-only">
                              Release reason for lock {id}
                            </span>
                            <input
                              name="reason"
                              className={fieldClass}
                              placeholder="Required release reason"
                              maxLength={500}
                              required
                            />
                          </label>
                          <button
                            type="submit"
                            className={buttonClass}
                            disabled={lockReleaseMutation.isPending}
                          >
                            {lockReleaseMutation.isPending &&
                            lockReleaseMutation.variables.id === id
                              ? 'Releasing...'
                              : 'Release lock'}
                          </button>
                        </form>
                      ) : (
                        <p className="mb-0 text-xs text-muted">
                          {String(lock.releaseReason || 'No release reason')}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
              <AdminPagination
                page={locks.page}
                total={locks.total}
                pageSize={automationPageSize}
                onChange={setLockPage}
                label="Automation lock pages"
                focusTargetId="taxonomy-lock-results"
              />
            </>
          ) : (
            <Empty
              title="No locks match."
              text="Change the lock state or create a lock."
            />
          )}
        </AutomationBox>

        <AutomationBox title="Create automation lock">
          <form onSubmit={submitLock}>
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Lock scope
              </span>
              <select
                className={fieldClass}
                name="scope"
                value={lockScope}
                onChange={(event) =>
                  setLockScope(event.target.value as TaxonomyLockScope)
                }
              >
                <option value="site_assignment">Site assignment</option>
                <option value="tag">Tag</option>
                <option value="alias">Alias</option>
                <option value="merge">Merge</option>
                <option value="parent_edge">Parent edge</option>
              </select>
            </label>
            <AutomationInput
              label="Tag ID"
              name="tagId"
              type="number"
              min="1"
              placeholder="Canonical tag ID"
            />
            {lockScope === 'site_assignment' ? (
              <AutomationInput
                label="Site ID"
                name="siteId"
                type="number"
                min="1"
                placeholder="Site ID"
              />
            ) : null}
            {lockScope === 'alias' ? (
              <AutomationInput
                label="Alias"
                name="alias"
                placeholder="Protected alias"
                maxLength={80}
              />
            ) : null}
            {lockScope === 'merge' || lockScope === 'parent_edge' ? (
              <AutomationInput
                label="Related tag ID"
                name="relatedTagId"
                type="number"
                min="1"
                placeholder="Related tag ID"
              />
            ) : null}
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold uppercase">
                Reason
              </span>
              <textarea
                name="reason"
                className={`${fieldClass} min-h-20 resize-y`}
                maxLength={500}
                required
              />
            </label>
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={lockCreateMutation.isPending}
            >
              {lockCreateMutation.isPending ? 'Creating...' : 'Create lock'}
            </button>
          </form>
        </AutomationBox>
      </div>
    </section>
  )
}

function AutomationMetric({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="border border-line bg-paper p-2.5">
      <dt className="font-mono text-[11px] font-bold tracking-wide uppercase">
        {label}
      </dt>
      <dd className="m-0 font-mono text-xl font-bold">{value}</dd>
      <small className="block text-xs text-muted [overflow-wrap:anywhere]">
        {note}
      </small>
    </div>
  )
}

function AutomationBox({
  title,
  label,
  children,
}: {
  title: string
  label?: string
  children: ReactNode
}) {
  return (
    <section className="border border-line bg-canvas p-2.5">
      <header className="mb-2 flex items-center justify-between gap-2 border-b border-dotted border-brown pb-1.5">
        <h3 className="m-0 font-mono text-sm font-bold uppercase">{title}</h3>
        {label ? (
          <span className="font-mono text-[11px] text-muted">{label}</span>
        ) : null}
      </header>
      {children}
    </section>
  )
}

function AutomationInput({
  label,
  name,
  type = 'text',
  placeholder,
  defaultValue,
  min,
  max,
  step,
  maxLength,
  autoComplete,
  pattern,
}: {
  label: string
  name: string
  type?: string
  placeholder: string
  defaultValue?: string
  min?: string
  max?: string
  step?: string
  maxLength?: number
  autoComplete?: string
  pattern?: string
}) {
  return (
    <label className="mb-2.5 block">
      <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
        {label}
      </span>
      <input
        className={fieldClass}
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        autoComplete={autoComplete}
        pattern={pattern}
        required
      />
    </label>
  )
}

function canTransitionMode(
  current: TaxonomyMode,
  target: TaxonomyMode,
  readyForGradual: boolean,
  circuitState: string,
) {
  if (target === 'disabled') return current !== 'disabled'
  if (circuitState !== 'closed' || current === 'degraded') return false
  if (current === 'disabled') return target === 'shadow'
  if (current === 'shadow') return target === 'gradual' && readyForGradual
  if (current === 'gradual')
    return target === 'shadow' || target === 'autonomous'
  return target === 'shadow'
}

function numberFromForm(data: FormData, name: string) {
  return Number(data.get(name))
}

function policyInputFromForm(data: FormData): TaxonomyPolicyInput {
  return {
    assignmentLimit: numberFromForm(data, 'assignmentLimit'),
    novelEvidenceSiteThreshold: numberFromForm(
      data,
      'novelEvidenceSiteThreshold',
    ),
    assignmentConfidenceMicros: numberFromForm(
      data,
      'assignmentConfidenceMicros',
    ),
    ontologyConfidenceMicros: numberFromForm(data, 'ontologyConfidenceMicros'),
    minimumMarginMicros: numberFromForm(data, 'minimumMarginMicros'),
    hierarchyMaxDepth: numberFromForm(data, 'hierarchyMaxDepth'),
    hierarchyMaxFanout: numberFromForm(data, 'hierarchyMaxFanout'),
    ontologyProviderAgreement: numberFromForm(
      data,
      'ontologyProviderAgreement',
    ),
    retryBudget: numberFromForm(data, 'retryBudget'),
    retryBaseSeconds: numberFromForm(data, 'retryBaseSeconds'),
    retryMaxSeconds: numberFromForm(data, 'retryMaxSeconds'),
    rolloutBasisPoints: numberFromForm(data, 'rolloutBasisPoints'),
    dailyRequestBudget: numberFromForm(data, 'dailyRequestBudget'),
    dailyTokenBudget: numberFromForm(data, 'dailyTokenBudget'),
    schemaFailureTripBasisPoints: numberFromForm(
      data,
      'schemaFailureTripBasisPoints',
    ),
    disagreementTripBasisPoints: numberFromForm(
      data,
      'disagreementTripBasisPoints',
    ),
    rollbackTripBasisPoints: numberFromForm(data, 'rollbackTripBasisPoints'),
    mutationVolumeTripCount: numberFromForm(data, 'mutationVolumeTripCount'),
    rawResponseRetentionSeconds: numberFromForm(
      data,
      'rawResponseRetentionSeconds',
    ),
    shadowMinimumSamples: numberFromForm(data, 'shadowMinimumSamples'),
    shadowMinimumCoverageBasisPoints: numberFromForm(
      data,
      'shadowMinimumCoverageBasisPoints',
    ),
    shadowSchemaSuccessBasisPoints: numberFromForm(
      data,
      'shadowSchemaSuccessBasisPoints',
    ),
    shadowProviderAgreementBasisPoints: numberFromForm(
      data,
      'shadowProviderAgreementBasisPoints',
    ),
    promptHash: String(data.get('promptHash') || '').trim(),
    schemaHash: String(data.get('schemaHash') || '').trim(),
  }
}

function isProviderKind(
  value: string,
): value is 'openai_compatible' | 'gemini' {
  return value === 'openai_compatible' || value === 'gemini'
}

function isRoutingRole(
  value: string,
): value is 'primary' | 'failover' | 'consensus' {
  return value === 'primary' || value === 'failover' || value === 'consensus'
}

function parseProviderDialect(
  value: FormDataEntryValue | null,
): 'responses' | 'chat_completions' {
  const dialect = String(value)
  if (dialect !== 'responses' && dialect !== 'chat_completions')
    throw new Error('Invalid provider dialect')
  return dialect
}

function isCandidateDecision(
  value: string,
): value is 'accepted' | 'rejected' | 'deferred' | 'conflict' {
  return (
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'deferred' ||
    value === 'conflict'
  )
}

function parseCandidateStatus(value: string): TaxonomyCandidateStatus | null {
  if (value === 'proposed') return value
  if (value === 'accepted') return value
  if (value === 'rejected') return value
  if (value === 'deferred') return value
  if (value === 'conflict') return value
  return null
}

function parseCandidateKind(value: string): TaxonomyCandidateKind | null {
  if (value === 'existing_tag') return value
  if (value === 'novel_concept') return value
  if (value === 'alias') return value
  if (value === 'merge') return value
  if (value === 'parent_edge') return value
  return null
}

function optionalBasisPoints(value: number | null) {
  return value === null ? 'not configured' : basisPoints(value)
}

function microsPercent(value: number) {
  return `${(value / 10_000).toFixed(2)}%`
}

function modeDisabledReason(
  state: {
    mode: TaxonomyMode
    circuitState: string
    activeProviderConfigId: number | null
    activePolicyConfigId: number | null
  },
  target: TaxonomyMode,
  readyForGradual: boolean,
) {
  if (state.mode === target) return 'Current mode.'
  if (target === 'disabled') return 'Disable automation.'
  if (state.circuitState !== 'closed' || state.mode === 'degraded')
    return 'Circuit must be closed; reset the circuit first.'
  if (
    state.activeProviderConfigId === null ||
    state.activePolicyConfigId === null
  )
    return 'An active provider and policy are required.'
  if (state.mode === 'disabled' && target !== 'shadow')
    return 'Shadow mode must be enabled first.'
  if (state.mode === 'shadow' && target === 'gradual' && !readyForGradual)
    return 'Shadow readiness thresholds have not been met.'
  if (state.mode === 'gradual' && target === 'autonomous')
    return 'Autonomous mode follows gradual mode.'
  if (
    canTransitionMode(state.mode, target, readyForGradual, state.circuitState)
  )
    return `Switch automation to ${modeLabel(target)} mode.`
  return `Cannot transition directly from ${modeLabel(state.mode)} to ${modeLabel(target)}.`
}

function modeLabel(mode: TaxonomyMode) {
  return mode === 'disabled'
    ? 'Disabled'
    : mode === 'shadow'
      ? 'Shadow'
      : mode === 'gradual'
        ? 'Gradual'
        : mode === 'autonomous'
          ? 'Autonomous'
          : 'Degraded'
}

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase())
}

function basisPoints(value: number) {
  return `${(value / 100).toFixed(2).replace(/\.00$/, '')}%`
}

function formatTimestamp(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(numeric * 1_000))
}

function Stat({
  label,
  value,
  note,
}: {
  label: string
  value: number
  note: string
}) {
  return (
    <div className="min-w-0 border border-line bg-canvas p-2.5">
      <dt className="mb-1 font-mono text-xs font-bold tracking-[0.06em] uppercase">
        {label}
      </dt>
      <dd className="m-0 font-mono text-[clamp(24px,4vw,34px)] leading-none font-bold tracking-[-0.03em]">
        {value.toLocaleString('en')}
      </dd>
      <small className="mt-1.5 block text-xs text-muted">{note}</small>
    </div>
  )
}

function SubmissionCard({
  submission,
  onReview,
  pending,
}: {
  submission: AdminSubmission
  onReview: (submission: AdminSubmission, status: ReviewStatus) => void
  pending: boolean
}) {
  return (
    <article className="border border-line bg-canvas p-2.5">
      <div className="grid gap-2.5 sm:grid-cols-[126px_minmax(0,1fr)]">
        <ItemThumbnail
          thumbnailKey={submission.thumbnailKey}
          alt={submission.thumbnailAlt || `Preview of ${submission.name}`}
          label={submission.name}
          className="aspect-4/3 w-full"
        />
        <div>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="m-0 font-mono text-base font-bold">
                {submission.name}
              </h3>
              <a
                href={submission.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-xs text-muted underline"
              >
                {submission.url}
              </a>
            </div>
            <span className="border px-1.5 py-1 font-mono text-[11px] font-bold uppercase">
              {submission.status === 'pending' ? 'Waiting' : submission.status}
            </span>
          </div>
          <p className="my-1.5 text-brown">{submission.description}</p>
          <p className="mb-2 font-mono text-xs text-muted">
            {submission.date} / {submission.tags.join(', ')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {submission.status !== 'approved' ? (
              <button
                type="button"
                className={successButtonClass}
                onClick={() => onReview(submission, 'approved')}
                disabled={pending}
              >
                Approve {submission.name}
              </button>
            ) : null}
            {submission.status !== 'rejected' ? (
              <button
                type="button"
                className={dangerButtonClass}
                onClick={() => onReview(submission, 'rejected')}
                disabled={pending}
              >
                Reject {submission.name}
              </button>
            ) : null}
            {submission.status !== 'pending' ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => onReview(submission, 'pending')}
                disabled={pending}
              >
                Return to review
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  )
}

function ManagedRow({
  entry,
  onToggle,
  onEdit,
  statusPending,
}: {
  entry: AdminSite
  onToggle: (entry: AdminSite) => void
  onEdit: (id: number) => void
  statusPending: boolean
}) {
  return (
    <tr className="border-b border-dotted border-line last:border-b-0 hover:bg-canvas">
      <td className="p-2 align-top">
        <div className="grid min-w-56 grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
          <ItemThumbnail
            thumbnailKey={entry.thumbnailKey}
            alt={entry.thumbnailAlt || `Preview of ${entry.name}`}
            label={entry.name}
            className="aspect-4/3 w-16"
          />
          <div>
            <strong className="block">{entry.name}</strong>
            <span className="block max-w-64 break-all font-mono text-xs text-muted">
              {entry.externalUrl}
            </span>
          </div>
        </div>
      </td>
      <td className="p-2 align-top">
        <div className="flex flex-wrap gap-1">
          {entry.tags.length ? (
            entry.tags.map((tag) => (
              <span
                key={tag}
                className="border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px]"
              >
                {entry.tagLabels?.[tag] || tag.replace(/^~/, '')}
              </span>
            ))
          ) : (
            <span>-</span>
          )}
        </div>
      </td>
      <td className="p-2 align-top font-mono text-xs">{entry.source}</td>
      <td className="p-2 align-top">
        {entry.status === 'active' ? 'Published' : 'Archived'}
      </td>
      <td className="p-2 align-top">
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={`${buttonClass} min-h-9`}
            onClick={() => onEdit(entry.id)}
          >
            Edit
          </button>
          {entry.source !== 'Directory' ? (
            <button
              type="button"
              className={`${buttonClass} min-h-9`}
              onClick={() => onToggle(entry)}
              disabled={statusPending}
            >
              {statusPending
                ? 'Updating...'
                : entry.status === 'active'
                  ? 'Archive'
                  : 'Restore'}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  )
}

function TagRow({
  tag,
  onEdit,
  disabled,
}: {
  tag: AdminTagRecord
  onEdit: (tag: AdminTagRecord) => void
  disabled: boolean
}) {
  return (
    <tr className="border-b border-dotted border-line last:border-b-0">
      <td className="p-2">
        <strong className="block">{tag.name}</strong>
        <span className="font-mono text-xs text-muted">{tag.slug}</span>
      </td>
      <td className="p-2 font-mono text-xs">
        {tag.canonical ? 'Canonical' : 'Unmapped'}
      </td>
      <td className="p-2 font-mono text-xs">
        {tag.directCount || 0} direct / {tag.count} inherited
      </td>
      <td className="max-w-72 p-2 text-xs text-muted [overflow-wrap:anywhere]">
        {tag.aliases.length
          ? `Aliases: ${tag.aliases.join(', ')}`
          : 'No aliases'}
        {tag.parents.length ? ` / Parents: ${tag.parents.join(', ')}` : ''}
      </td>
      <td className="p-2">
        <button
          type="button"
          className={`${buttonClass} min-h-9`}
          onClick={() => onEdit(tag)}
          disabled={disabled}
        >
          Correct
        </button>
      </td>
    </tr>
  )
}

function SiteEditor({
  entry,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  entry: AdminSite
  pending: boolean
  error: string
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <ModalDialog
      labelledBy="edit-entry-title"
      onClose={onClose}
      closeDisabled={pending}
    >
      <form
        className="my-auto w-full max-w-2xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
        onSubmit={onSubmit}
      >
        <EditorHeader
          id="edit-entry-title"
          eyebrow={`Site #${entry.id}`}
          title={`Edit ${entry.name}`}
          onClose={onClose}
          disabled={pending}
        />
        {error ? <EditorError message={error} /> : null}
        <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
          <input type="hidden" name="id" value={entry.id} />
          <div className="grid gap-3 md:grid-cols-[1fr_180px]">
            <div>
              <AdminField
                label="Site name"
                name="name"
                placeholder="Name as it should appear"
                maxLength={60}
                defaultValue={entry.name}
                autoFocus
              />
              <AdminField
                label="Website address"
                name="url"
                type="url"
                placeholder="https://"
                defaultValue={entry.externalUrl}
              />
            </div>
            <div>
              <FieldLabel>Current thumbnail</FieldLabel>
              <ItemThumbnail
                thumbnailKey={entry.thumbnailKey}
                alt={entry.thumbnailAlt || `Preview of ${entry.name}`}
                label={entry.name}
                className="aspect-4/3 w-full"
              />
            </div>
          </div>
          <AdminTextArea
            id="edit-entry-description"
            label="Card description"
            name="description"
            defaultValue={entry.description}
            maxLength={220}
          />
          <AdminTextArea
            id="edit-entry-summary"
            label="Detail summary"
            name="summary"
            defaultValue={entry.summary}
            maxLength={400}
          />
          <div className="grid gap-2 md:grid-cols-2">
            <AdminField
              label="Categories"
              name="categories"
              placeholder="Interactive, Audio"
              defaultValue={entry.categories.join(', ')}
            />
            <AdminField
              label="Credit"
              name="poster"
              placeholder="Submitted by..."
              maxLength={120}
              defaultValue={entry.poster}
            />
          </div>
          <AdminTextArea
            id="edit-entry-notes"
            label="Detail notes"
            name="notes"
            defaultValue={entry.notes.join('\n')}
            tall
          />
          <AdminTextArea
            id="edit-entry-facts"
            label="Facts"
            name="facts"
            defaultValue={entry.facts
              .map((fact) => `${fact.label}: ${fact.value}`)
              .join('\n')}
            tall
          />
          <div className="grid gap-2 md:grid-cols-2">
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                Accent
              </span>
              <select
                name="accent"
                defaultValue={entry.accent}
                className={fieldClass}
              >
                {accentOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <AdminField
              label="Thumbnail alt text"
              name="thumbnailAlt"
              placeholder="Describe the image"
              maxLength={180}
              defaultValue={entry.thumbnailAlt || `Preview of ${entry.name}`}
            />
          </div>
          <div className="mb-2.5 border border-dotted border-brown bg-canvas p-2">
            <FieldLabel htmlFor="edit-entry-image">
              Replace thumbnail
            </FieldLabel>
            <input
              id="edit-entry-image"
              name="image"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="w-full"
            />
            <small className="mt-1 block text-muted">
              Leave empty to keep the current image.
            </small>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_180px]">
            <div className="mb-2.5">
              <TagInput
                key={entry.id}
                label="Tags"
                name="tags"
                required
                defaultValue={entry.tags}
                initialLabels={entry.tagLabels}
              />
            </div>
            <label className="mb-2.5 block">
              <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                Status
              </span>
              <select
                name="status"
                defaultValue={entry.status}
                className={fieldClass}
              >
                <option value="active">Published</option>
                <option value="archived">Archived</option>
              </select>
            </label>
          </div>
          <EditorActions pending={pending} onClose={onClose} />
        </fieldset>
      </form>
    </ModalDialog>
  )
}

function TagEditor({
  tag,
  mergeTarget,
  onMergeTarget,
  pending,
  error,
  onClose,
  onSubmit,
  onMerge,
}: {
  tag: AdminTagRecord
  mergeTarget: string
  onMergeTarget: (value: string) => void
  pending: boolean
  error: string
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onMerge: () => void
}) {
  return (
    <ModalDialog
      labelledBy="edit-tag-title"
      onClose={onClose}
      closeDisabled={pending}
    >
      <form
        className="my-auto w-full max-w-xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
        onSubmit={onSubmit}
      >
        <EditorHeader
          id="edit-tag-title"
          eyebrow={`${tag.canonical ? 'Canonical' : 'Unmapped'} / ${tag.slug}`}
          title={`Edit ${tag.name}`}
          onClose={onClose}
          disabled={pending}
        />
        {error ? <EditorError message={error} /> : null}
        <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
          <AdminField
            label="Display name"
            name="name"
            placeholder="Canonical display name"
            defaultValue={tag.name}
            maxLength={80}
            autoFocus
          />
          <AdminField
            label="Aliases"
            name="aliases"
            placeholder="audio, sounds, relaxing"
            defaultValue={tag.aliases.join(', ')}
            required={false}
          />
          <AdminField
            label="Parent tag slugs"
            name="parents"
            placeholder="listen, wander"
            defaultValue={tag.parents.join(', ')}
            required={false}
          />
          {!tag.canonical ? (
            <div className="mb-3 border border-dotted border-line bg-canvas p-2">
              <FieldLabel htmlFor="merge-target">
                Merge into canonical slug
              </FieldLabel>
              <div className="flex flex-wrap gap-2">
                <input
                  id="merge-target"
                  value={mergeTarget}
                  onChange={(event) => onMergeTarget(event.target.value)}
                  className={`${fieldClass} min-w-0 flex-1`}
                  placeholder="canonical-tag"
                />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!mergeTarget.trim() || pending}
                  onClick={onMerge}
                >
                  Merge
                </button>
              </div>
            </div>
          ) : null}
          <EditorActions
            pending={pending}
            onClose={onClose}
            submitLabel={tag.canonical ? 'Save tag' : 'Make canonical'}
          />
        </fieldset>
      </form>
    </ModalDialog>
  )
}

function EditorHeader({
  id,
  eyebrow,
  title,
  onClose,
  disabled,
}: {
  id: string
  eyebrow: string
  title: string
  onClose: () => void
  disabled: boolean
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
      <div>
        <p className="m-0 font-mono text-[11px] text-muted uppercase">
          {eyebrow}
        </p>
        <h2 id={id} className="m-0 font-mono text-base font-bold uppercase">
          {title}
        </h2>
      </div>
      <button
        type="button"
        className={`${buttonClass} min-w-11 px-0`}
        onClick={onClose}
        disabled={disabled}
        aria-label="Close"
      >
        X
      </button>
    </div>
  )
}

function EditorActions({
  pending,
  onClose,
  submitLabel = 'Save changes',
}: {
  pending: boolean
  onClose: () => void
  submitLabel?: string
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        className={buttonClass}
        onClick={onClose}
        disabled={pending}
      >
        Cancel
      </button>
      <button type="submit" className={primaryButtonClass} disabled={pending}>
        {pending ? 'Saving...' : submitLabel}
      </button>
    </div>
  )
}

function EditorError({ message }: { message: string }) {
  return (
    <p
      className="mb-3 border-l-4 border-danger bg-red-50 px-3 py-2 text-sm font-bold text-danger"
      role="alert"
    >
      {message}
    </p>
  )
}

function AdminField({
  label,
  name,
  type = 'text',
  placeholder,
  maxLength,
  defaultValue,
  autoFocus = false,
  required = true,
}: {
  label: string
  name: string
  type?: string
  placeholder: string
  maxLength?: number
  pattern?: string
  defaultValue?: string
  autoFocus?: boolean
  required?: boolean
}) {
  return (
    <label className="mb-2.5 block">
      <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className={fieldClass}
        placeholder={placeholder}
        data-dialog-initial-focus={autoFocus || undefined}
      />
    </label>
  )
}

function AdminTextArea({
  id,
  label,
  name,
  defaultValue,
  maxLength,
  tall = false,
}: {
  id: string
  label: string
  name: string
  defaultValue: string
  maxLength?: number
  tall?: boolean
}) {
  return (
    <div className="mb-2.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <textarea
        id={id}
        name={name}
        defaultValue={defaultValue}
        maxLength={maxLength}
        required
        className={`${fieldClass} ${tall ? 'min-h-32' : 'min-h-24'} resize-y`}
      />
    </div>
  )
}

function AdminPagination({
  page,
  total,
  pageSize = adminPageSize,
  onChange,
  label,
  focusTargetId,
}: {
  page: number
  total: number
  pageSize?: number
  onChange: (page: number) => void
  label: string
  focusTargetId: string
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageNumbers = Array.from(
    new Set(
      [0, safePage - 1, safePage, safePage + 1, pageCount - 1].filter(
        (value) => value >= 0 && value < pageCount,
      ),
    ),
  ).sort((a, b) => a - b)
  function changePage(nextPage: number) {
    onChange(nextPage)
    requestAnimationFrame(() => document.getElementById(focusTargetId)?.focus())
  }
  if (pageCount === 1) return null
  return (
    <nav
      className="mt-2 grid gap-2 border-t border-dotted border-line pt-2 sm:grid-cols-[auto_1fr_auto] sm:items-center"
      aria-label={label}
    >
      <button
        type="button"
        className={buttonClass}
        disabled={safePage === 0}
        onClick={() => changePage(safePage - 1)}
      >
        Previous
      </button>
      <div className="flex flex-wrap items-center justify-center gap-1">
        {pageNumbers.map((number, index) => (
          <span key={number} className="contents">
            {index > 0 && number - pageNumbers[index - 1] > 1 ? (
              <span aria-hidden="true">...</span>
            ) : null}
            <button
              type="button"
              className={`${buttonClass} min-h-9 min-w-9 px-2 ${number === safePage ? '!bg-brown !text-paper' : ''}`}
              aria-current={number === safePage ? 'page' : undefined}
              onClick={() => changePage(number)}
            >
              {number + 1}
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        className={buttonClass}
        disabled={safePage >= pageCount - 1}
        onClick={() => changePage(safePage + 1)}
      >
        Next
      </button>
      <span
        className="text-center font-mono text-xs text-muted sm:col-span-3"
        aria-live="polite"
      >
        {safePage * pageSize + 1}-{Math.min(total, (safePage + 1) * pageSize)}{' '}
        of {total} / Page {safePage + 1} of {pageCount}
      </span>
    </nav>
  )
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="border border-dashed border-line bg-canvas px-3 py-6 text-center">
      <h3 className="mb-1 font-mono text-base font-bold">{title}</h3>
      <p className="m-0 text-muted">{text}</p>
    </div>
  )
}

function commaList(value: FormDataEntryValue | null) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const defaultTaxonomyPolicy = {
  assignmentLimit: 12,
  novelEvidenceSiteThreshold: 3,
  assignmentConfidenceMicros: 850_000,
  ontologyConfidenceMicros: 920_000,
  minimumMarginMicros: 150_000,
  hierarchyMaxDepth: 3,
  hierarchyMaxFanout: 24,
  ontologyProviderAgreement: 2,
  retryBudget: 5,
  retryBaseSeconds: 60,
  retryMaxSeconds: 3_600,
  rolloutBasisPoints: 0,
  dailyRequestBudget: 250,
  dailyTokenBudget: 500_000,
  schemaFailureTripBasisPoints: 500,
  disagreementTripBasisPoints: 2_000,
  rollbackTripBasisPoints: 1_000,
  mutationVolumeTripCount: 100,
  rawResponseRetentionSeconds: 604_800,
  shadowMinimumSamples: 20,
  shadowMinimumCoverageBasisPoints: 9_000,
  shadowSchemaSuccessBasisPoints: 9_800,
  shadowProviderAgreementBasisPoints: 8_000,
  promptHash: '0'.repeat(64),
  schemaHash: '0'.repeat(64),
}

type TaxonomyPolicyInput = TaxonomyPolicyCreateInput

const policyFields: Array<{
  name: keyof TaxonomyPolicyInput
  label: string
  placeholder?: string
  type?: string
  min?: string
  max?: string
  maxLength?: number
  pattern?: string
}> = [
  { name: 'assignmentLimit', label: 'Assignment limit', min: '1', max: '100' },
  {
    name: 'novelEvidenceSiteThreshold',
    label: 'Novel evidence sites',
    min: '1',
    max: '100000',
  },
  {
    name: 'assignmentConfidenceMicros',
    label: 'Assignment confidence (micros)',
    min: '0',
    max: '1000000',
  },
  {
    name: 'ontologyConfidenceMicros',
    label: 'Ontology confidence (micros)',
    min: '0',
    max: '1000000',
  },
  {
    name: 'minimumMarginMicros',
    label: 'Minimum margin (micros)',
    min: '0',
    max: '1000000',
  },
  {
    name: 'hierarchyMaxDepth',
    label: 'Hierarchy max depth',
    min: '1',
    max: '32',
  },
  {
    name: 'hierarchyMaxFanout',
    label: 'Hierarchy max fanout',
    min: '1',
    max: '1000',
  },
  {
    name: 'ontologyProviderAgreement',
    label: 'Provider agreement count',
    min: '1',
    max: '16',
  },
  { name: 'retryBudget', label: 'Retry budget', min: '0', max: '100' },
  {
    name: 'retryBaseSeconds',
    label: 'Retry base seconds',
    min: '1',
    max: '86400',
  },
  {
    name: 'retryMaxSeconds',
    label: 'Retry max seconds',
    min: '1',
    max: '604800',
  },
  {
    name: 'rolloutBasisPoints',
    label: 'Rollout basis points',
    min: '0',
    max: '10000',
  },
  {
    name: 'dailyRequestBudget',
    label: 'Daily request budget',
    min: '0',
    max: '10000000',
  },
  {
    name: 'dailyTokenBudget',
    label: 'Daily token budget',
    min: '0',
    max: '10000000000',
  },
  {
    name: 'schemaFailureTripBasisPoints',
    label: 'Schema failure trip (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'disagreementTripBasisPoints',
    label: 'Disagreement trip (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'rollbackTripBasisPoints',
    label: 'Rollback trip (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'mutationVolumeTripCount',
    label: 'Mutation volume trip',
    min: '0',
    max: '10000000',
  },
  {
    name: 'rawResponseRetentionSeconds',
    label: 'Raw response retention seconds',
    min: '0',
    max: '2592000',
  },
  {
    name: 'shadowMinimumSamples',
    label: 'Shadow minimum samples',
    min: '0',
    max: '10000000',
  },
  {
    name: 'shadowMinimumCoverageBasisPoints',
    label: 'Shadow coverage (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'shadowSchemaSuccessBasisPoints',
    label: 'Shadow schema success (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'shadowProviderAgreementBasisPoints',
    label: 'Shadow agreement (bp)',
    min: '0',
    max: '10000',
  },
  {
    name: 'promptHash',
    label: 'Prompt SHA-256',
    type: 'text',
    placeholder: '64 lowercase hexadecimal characters',
    maxLength: 64,
    pattern: '[a-f0-9]{64}',
  },
  {
    name: 'schemaHash',
    label: 'Schema SHA-256',
    type: 'text',
    placeholder: '64 lowercase hexadecimal characters',
    maxLength: 64,
    pattern: '[a-f0-9]{64}',
  },
]

const jobStatusOptions: TaxonomyJobStatus[] = [
  'pending',
  'leased',
  'retry_wait',
  'succeeded',
  'settled',
  'obsolete',
  'dead',
  'cancelled',
  'degraded',
]

const jobKindOptions: TaxonomyJobKind[] = [
  'classify_site',
  'reassess_concept',
  'apply_ontology',
  'rollback',
]

const batchStatusOptions: TaxonomyBatchStatus[] = [
  'planned',
  'applying',
  'applied',
  'failed',
  'rolling_back',
  'rolled_back',
  'partial',
]

const candidateStatusOptions: TaxonomyCandidateStatus[] = [
  'proposed',
  'accepted',
  'rejected',
  'deferred',
  'conflict',
]
const candidateKindOptions: TaxonomyCandidateKind[] = [
  'existing_tag',
  'novel_concept',
  'alias',
  'merge',
  'parent_edge',
]

const accentOptions = [
  ['from-[#63396d] to-[#d27a3e]', 'Purple / orange'],
  ['from-[#315c51] to-[#79a381]', 'Green'],
  ['from-[#38578d] to-[#eabc52]', 'Blue / gold'],
  ['from-[#527797] to-[#d8a866]', 'Sky / sand'],
  ['from-[#dc4f33] to-[#e9b640]', 'Red / gold'],
  ['from-[#586f44] to-[#c4a866]', 'Olive / sand'],
  ['from-[#5b376b] to-[#b06970]', 'Purple / rose'],
  ['from-[#704d3f] to-[#d28f61]', 'Brown / orange'],
  ['from-[#42687c] to-[#8ca8aa]', 'Blue / gray'],
  ['from-[#8d3b2b] to-[#d37237]', 'Rust / orange'],
] as const
