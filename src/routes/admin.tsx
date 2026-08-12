import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
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
  fieldClass,
  primaryButtonClass,
} from '../components/oddweb'
import { adminQueryOptions } from '../queries/oddweb'
import { tagLabel, tagTokensFromNames, tagsMatchFilter } from '../data/tags'
import { getAdminSession, logoutAdmin } from '../server/auth'
import {
  createDirectorySite,
  mergeTag,
  reconcileThumbnailStorage,
  removeGuestbookEntry,
  reviewSubmission,
  saveTag,
  updateDirectorySite,
  updateSiteStatus,
} from '../server/data'

import type { FormEvent } from 'react'
import type { AdminSubmission, AdminTagRecord } from '../db/repository'
import type { CanonicalTag } from '../data/tags'

type ReviewStatus = 'pending' | 'approved' | 'rejected'
type EntryStatus = 'active' | 'archived'
const adminPageSize = 12

type ManagedEntry = {
  id: number
  name: string
  url: string
  description: string
  tags: string[]
  source: 'Directory' | 'Submission' | 'Manual'
  status: EntryStatus
  thumbnailKey?: string
  thumbnailAlt?: string
}

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
      { title: 'Oddweb Admin - Directory management' },
      {
        name: 'description',
        content: 'Review, file, and maintain the Oddweb directory.',
      },
    ],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(adminQueryOptions()),
  component: AdminPage,
})

function AdminPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { admin } = Route.useRouteContext()
  const { data } = useSuspenseQuery(adminQueryOptions())
  const entries: ManagedEntry[] = data.sites.map((site) => ({
    id: site.id,
    name: site.name,
    url: site.externalUrl,
    description: site.description,
    tags: site.tags,
    source: site.source,
    status: site.status,
    thumbnailKey: site.thumbnailKey,
    thumbnailAlt: site.thumbnailAlt,
  }))
  const submissions = data.submissions
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | 'all'>(
    'pending',
  )
  const [siteFilter, setSiteFilter] = useState<EntryStatus | 'all'>('active')
  const [siteSearch, setSiteSearch] = useState('')
  const [includedTags, setIncludedTags] = useState<string[]>([])
  const [excludedTags, setExcludedTags] = useState<string[]>([])
  const [editingEntry, setEditingEntry] = useState<ManagedEntry | null>(null)
  const [editingTag, setEditingTag] = useState<AdminTagRecord | null>(null)
  const [tagSearch, setTagSearch] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [submissionPage, setSubmissionPage] = useState(0)
  const [sitePage, setSitePage] = useState(0)
  const [tagPage, setTagPage] = useState(0)
  const [guestbookPage, setGuestbookPage] = useState(0)
  const deferredSiteSearch = useDeferredValue(siteSearch.trim().toLowerCase())
  const [status, setStatus] = useState(
    'Admin records loaded. Thumbnail storage is checked when an image operation runs.',
  )
  const [statusState, setStatusState] = useState<'success' | 'error' | ''>('')
  const [entryTagInputKey, setEntryTagInputKey] = useState(0)
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
  const logoutMutation = useMutation({ mutationFn: () => logoutAdmin() })
  const guestbookDeleteMutation = useMutation({
    mutationFn: (id: number) => removeGuestbookEntry({ data: { id } }),
  })
  const storageMutation = useMutation({
    mutationFn: (deleteOrphans: boolean) =>
      reconcileThumbnailStorage({ data: { deleteOrphans } }),
  })
  const entryPending = createMutation.isPending

  const visibleSubmissions = submissions.filter(
    (submission) =>
      reviewFilter === 'all' || submission.status === reviewFilter,
  )
  const visibleEntries = entries.filter((entry) => {
    const matchesStatus = siteFilter === 'all' || entry.status === siteFilter
    const haystack =
      `${entry.name} ${entry.url} ${entry.tags.join(' ')}`.toLowerCase()
    const matchesIncluded = includedTags.every((tag) =>
      tagsMatchFilter(entry.tags, tag, data.tagCatalog),
    )
    const matchesExcluded = excludedTags.some((tag) =>
      tagsMatchFilter(entry.tags, tag, data.tagCatalog),
    )
    return (
      matchesStatus &&
      matchesIncluded &&
      !matchesExcluded &&
      (!deferredSiteSearch || haystack.includes(deferredSiteSearch))
    )
  })
  const activeEntries = entries.filter((entry) => entry.status === 'active')
  const pendingTotal = submissions.filter(
    (submission) => submission.status === 'pending',
  ).length
  const visitTotal = data.sites.reduce((sum, site) => sum + site.visits, 0)
  const visibleTagRecords = data.tagRecords.filter((tag) => {
    const query = tagSearch.trim().toLowerCase()
    return (
      !query ||
      `${tag.name} ${tag.slug} ${tag.aliases.join(' ')}`
        .toLowerCase()
        .includes(query)
    )
  })
  const pagedSubmissions = pageItems(visibleSubmissions, submissionPage)
  const pagedEntries = pageItems(visibleEntries, sitePage)
  const pagedTagRecords = pageItems(visibleTagRecords, tagPage)
  const pagedGuestbook = pageItems(data.guestbook, guestbookPage)

  function showStatus(message: string, state: 'success' | 'error' | '' = '') {
    setStatus(message)
    setStatusState(state)
  }

  async function handleAdminError(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback
    if (/unauthorized/i.test(message)) {
      queryClient.clear()
      await navigate({
        to: '/admin/login',
        search: { redirect: '/admin' },
      })
      return 'Your admin session expired. Sign in again to continue.'
    }
    return message
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

  async function refreshData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'directory'] }),
    ])
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
          ? `Approved "${submission.name}" and published its D1 record.`
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
    showStatus(`Uploading the thumbnail for "${name}" to R2...`)

    try {
      const result = await createMutation.mutateAsync(formData)
      await refreshData()
      form.reset()
      setEntryTagInputKey((key) => key + 1)
      showStatus(
        `Added "${name}" to D1 with R2 thumbnail ${result.thumbnailKey}.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'The thumbnail upload failed.'),
        'error',
      )
    }
  }

  async function toggleEntry(id: number) {
    const entry = entries.find((item) => item.id === id)
    if (!entry || entry.source === 'Directory') return
    const nextStatus = entry.status === 'active' ? 'archived' : 'active'
    if (
      nextStatus === 'archived' &&
      !window.confirm(`Archive "${entry.name}" and hide it from the directory?`)
    )
      return
    try {
      await statusMutation.mutateAsync({ id, status: nextStatus })
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

  function setManagementTags(type: 'include' | 'exclude', nextTags: string[]) {
    if (type === 'include') {
      setIncludedTags(nextTags)
      setExcludedTags((current) =>
        current.filter((tag) => !nextTags.includes(tag)),
      )
    } else {
      setExcludedTags(nextTags)
      setIncludedTags((current) =>
        current.filter((tag) => !nextTags.includes(tag)),
      )
    }
  }

  async function saveEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('name') || '').trim()
    if (
      editingEntry?.status === 'active' &&
      formData.get('status') === 'archived' &&
      !window.confirm(`Archive "${name}" and hide it from the directory?`)
    )
      return
    showStatus(`Saving changes to "${name}"...`)
    try {
      await editMutation.mutateAsync(formData)
      await refreshData()
      setEditingEntry(null)
      showStatus(`Updated "${name}" in D1.`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not update the site.'),
        'error',
      )
    }
  }

  async function saveTagRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingTag?.id) return
    const form = new FormData(event.currentTarget)
    try {
      await saveTagMutation.mutateAsync({
        id: editingTag.id,
        name: String(form.get('name') || ''),
        aliases: String(form.get('aliases') || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        parents: String(form.get('parents') || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      })
      await refreshData()
      setEditingTag(null)
      showStatus('Saved tag relationships in D1.', 'success')
    } catch (error) {
      showStatus(await handleAdminError(error, 'Could not save tag.'), 'error')
    }
  }

  async function mergeCurrentTag() {
    if (!editingTag?.id || !mergeTarget) return
    if (
      !window.confirm(
        `Merge "${editingTag.name}" into "${mergeTarget}"? This rewrites assignments and deletes the source tag.`,
      )
    )
      return
    try {
      await mergeTagMutation.mutateAsync({
        sourceId: editingTag.id,
        targetSlug: mergeTarget,
      })
      await refreshData()
      setEditingTag(null)
      setMergeTarget('')
      showStatus('Merged freeform tag into its canonical tag.', 'success')
    } catch (error) {
      showStatus(await handleAdminError(error, 'Could not merge tag.'), 'error')
    }
  }

  async function deleteGuestbook(id: number) {
    const entry = data.guestbook.find((item) => item.id === id)
    if (
      !window.confirm(
        `Remove ${entry?.name || 'this entry'} from the guestbook?`,
      )
    )
      return
    try {
      await guestbookDeleteMutation.mutateAsync(id)
      await refreshData()
      showStatus('Removed the guestbook entry.', 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not remove the entry.'),
        'error',
      )
    }
  }

  async function checkThumbnailStorage(deleteOrphans = false) {
    if (
      deleteOrphans &&
      !window.confirm(
        'Delete R2 thumbnails that have been unreferenced for at least 24 hours?',
      )
    )
      return
    try {
      const result = await storageMutation.mutateAsync(deleteOrphans)
      showStatus(
        deleteOrphans
          ? `R2 reconciliation deleted ${result.deleted} orphaned thumbnail${result.deleted === 1 ? '' : 's'}.`
          : `R2 contains ${result.stored} thumbnails; ${result.orphanKeys.length} are eligible for cleanup and ${result.missingKeys.length} D1 references are missing objects.`,
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not inspect thumbnail storage.'),
        'error',
      )
    }
  }

  function exportRecords() {
    const payload = JSON.stringify(
      {
        report: {
          type: 'oddweb-admin-data-report',
          version: 1,
          scope:
            'Current directory sites, submissions, canonical tag catalog, and tag-management records visible to this admin session.',
          restoreableBackup: false,
        },
        exportedAt: new Date().toISOString(),
        totals: {
          sites: data.sites.length,
          activeSites: activeEntries.length,
          submissions: submissions.length,
          pendingSubmissions: pendingTotal,
          recordedDetailOpens: visitTotal,
          tags: data.tagRecords.length,
          guestbookEntries: data.guestbook.length,
        },
        submissions,
        sites: data.sites,
        tagCatalog: data.tagCatalog,
        tagRecords: data.tagRecords,
        guestbook: data.guestbook,
      },
      null,
      2,
    )
    const url = URL.createObjectURL(
      new Blob([payload], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `oddweb-records-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    showStatus(
      'Exported the current admin data report (not a backup).',
      'success',
    )
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
        <header
          className="grid border border-ink md:grid-cols-[1.4fr_.6fr]"
          data-od-id="admin-header"
        >
          <div className="bg-rust p-4 text-white">
            <p className="mb-1 font-mono text-xs font-bold tracking-[0.08em] uppercase">
              Cloudflare operations desk
            </p>
            <h1 className="m-0 mb-1.5 font-mono text-[clamp(30px,5vw,44px)] leading-none font-bold tracking-[-0.04em]">
              Directory management
            </h1>
            <p className="m-0 max-w-2xl">
              Review incoming sites, publish additions, maintain records, and
              see how the directory is being used.
            </p>
          </div>
          <aside
            className="border-t border-ink bg-canvas p-4 md:border-t-0 md:border-l"
            aria-label="Storage notice"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <strong className="block font-mono text-xs tracking-[0.06em] uppercase">
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
            <p className="m-0 text-sm text-brown">
              Records live in D1 and thumbnail objects live in R2.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className={`${buttonClass} min-h-9`}
                onClick={() => checkThumbnailStorage(false)}
                disabled={storageMutation.isPending}
              >
                {storageMutation.isPending ? 'Checking R2...' : 'Check R2'}
              </button>
              <button
                type="button"
                className={`${buttonClass} min-h-9`}
                onClick={() => checkThumbnailStorage(true)}
                disabled={storageMutation.isPending}
              >
                Clean R2 orphans
              </button>
            </div>
          </aside>
        </header>

        <div
          className={`mt-2.5 border px-2.5 py-2 font-mono text-xs ${statusState === 'error' ? 'border-danger bg-red-50 text-danger' : statusState === 'success' ? 'border-success bg-green-50 text-success' : 'border-line bg-canvas text-brown'}`}
          role="status"
          aria-live="polite"
          data-od-id="admin-status"
        >
          {status}
        </div>

        <dl
          className="mt-2.5 grid grid-cols-1 gap-2 min-[481px]:grid-cols-2 md:grid-cols-4"
          aria-label="Directory statistics"
        >
          <Stat
            label="Published sites"
            value={activeEntries.length}
            note="Active directory records"
          />
          <Stat
            label="Waiting review"
            value={pendingTotal}
            note="Unresolved submissions"
          />
          <Stat
            label="Recorded detail entries"
            value={visitTotal}
            note="Persisted detail-route opens"
          />
          <Stat
            label="Tags in use"
            value={
              data.tagRecords.filter((tag) => (tag.directCount || 0) > 0).length
            }
            note="Across active records"
          />
        </dl>

        <div className="mt-2.5 grid items-start gap-2.5 md:grid-cols-[1.3fr_.7fr]">
          <Panel
            title="Submission review"
            label={`${visibleSubmissions.length} RECORDS`}
          >
            <div className="mb-2.5 flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-end">
              <label className="block">
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
              <button
                type="button"
                className={buttonClass}
                onClick={exportRecords}
                title="Downloads a current JSON data report; it is not a restoreable backup"
              >
                Export data report
              </button>
            </div>
            {visibleSubmissions.length ? (
              <>
                <div className="grid gap-2" data-od-id="submission-queue">
                  {pagedSubmissions.map((submission) => (
                    <SubmissionCard
                      key={submission.url}
                      submission={submission}
                      status={submission.status}
                      onReview={review}
                      pending={
                        reviewMutation.isPending &&
                        reviewMutation.variables.id === submission.id
                      }
                    />
                  ))}
                </div>
                <AdminPagination
                  page={submissionPage}
                  total={visibleSubmissions.length}
                  onChange={setSubmissionPage}
                  label="Submission review pages"
                />
              </>
            ) : (
              <Empty
                title="Nothing in this view."
                text="Choose another status or wait for a new filing."
              />
            )}
          </Panel>

          <Panel title="Add an entry" label="MANUAL FILE">
            <form onSubmit={addEntry} data-od-id="manual-entry-form">
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
                  PNG, JPEG, or WebP, up to 8 MB. Stored in the private R2
                  thumbnail bucket.
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
                  placeholder="Describe what happens when someone visits"
                />
                <small className="mt-1 block text-muted">
                  New entries use this text for the card and their initial
                  detail-page summary and notes.
                </small>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                <div className="mb-2.5">
                  <TagInput
                    catalog={data.tagCatalog}
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
              </div>
              <button
                type="submit"
                className={primaryButtonClass}
                disabled={entryPending}
              >
                {entryPending ? 'Uploading to R2...' : 'Add entry'}
              </button>
            </form>
          </Panel>

          <Panel
            title="Site management"
            label={`${visibleEntries.length} RECORDS`}
            className="md:col-span-2"
          >
            <div className="mb-2.5 flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-end">
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
                catalog={data.tagCatalog}
                label="Include tags"
                value={includedTags}
                onChange={(tags) => setManagementTags('include', tags)}
                tone="include"
                placeholder="Require a tag..."
              />
              <TagInput
                catalog={data.tagCatalog}
                label="Exclude tags"
                value={excludedTags}
                onChange={(tags) => setManagementTags('exclude', tags)}
                tone="exclude"
                placeholder="Hide a tag..."
              />
              {includedTags.length || excludedTags.length ? (
                <div className="md:col-span-2 flex justify-end">
                  <button
                    type="button"
                    className={`${buttonClass} min-h-9`}
                    onClick={() => {
                      setIncludedTags([])
                      setExcludedTags([])
                    }}
                  >
                    Clear tag filters
                  </button>
                </div>
              ) : null}
            </div>

            {visibleEntries.length ? (
              <>
                <div className="overflow-x-auto border border-line">
                  <table
                    className="w-full min-w-[700px] border-collapse"
                    data-od-id="managed-sites-table"
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
                      {pagedEntries.map((entry) => (
                        <ManagedRow
                          key={entry.id}
                          entry={entry}
                          onToggle={toggleEntry}
                          onEdit={setEditingEntry}
                          tagCatalog={data.tagCatalog}
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
                  page={sitePage}
                  total={visibleEntries.length}
                  onChange={setSitePage}
                  label="Site management pages"
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
            title="Tag wrangling"
            label={`${data.tagRecords.filter((tag) => !tag.canonical).length} UNWRANGLED`}
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
            <div className="max-h-[520px] overflow-auto border border-line">
              <table className="w-full min-w-[680px] border-collapse">
                <caption className="sr-only">
                  Tag definitions, usage counts, relationships, and actions
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
                  {pagedTagRecords.map((tag) => (
                    <tr
                      key={tag.id}
                      className="border-b border-dotted border-line last:border-b-0"
                    >
                      <td className="p-2">
                        <strong className="block">{tag.name}</strong>
                        <span className="font-mono text-xs text-muted">
                          {tag.slug}
                        </span>
                      </td>
                      <td className="p-2 font-mono text-xs">
                        {tag.canonical ? 'Canonical' : 'Unwrangled'}
                      </td>
                      <td className="p-2 font-mono text-xs">
                        {tag.directCount || 0} direct / {tag.count} inherited
                      </td>
                      <td className="max-w-72 p-2 text-xs text-muted [overflow-wrap:anywhere]">
                        {tag.aliases.length
                          ? `Aliases: ${tag.aliases.join(', ')}`
                          : 'No aliases'}
                        {tag.parents.length
                          ? ` / Parents: ${tag.parents.join(', ')}`
                          : ''}
                      </td>
                      <td className="p-2">
                        <button
                          type="button"
                          className={`${buttonClass} min-h-9`}
                          onClick={() => {
                            setEditingTag(tag)
                            setMergeTarget('')
                          }}
                          disabled={
                            saveTagMutation.isPending ||
                            mergeTagMutation.isPending
                          }
                        >
                          {tag.canonical ? 'Edit' : 'Wrangle'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AdminPagination
              page={tagPage}
              total={visibleTagRecords.length}
              onChange={setTagPage}
              label="Tag management pages"
            />
          </Panel>
          <Panel
            title="Guestbook moderation"
            label={`${data.guestbook.length} RECORDS`}
            className="md:col-span-2"
          >
            {data.guestbook.length ? (
              <ul className="m-0 list-none p-0">
                {pagedGuestbook.map((entry) => (
                  <li
                    key={entry.id}
                    className="grid gap-2 border-t border-dotted border-line py-2 first:border-t-0 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-center"
                  >
                    <span className="font-mono text-xs">
                      <strong className="block">{entry.name}</strong>
                      <span className="text-muted">{entry.date}</span>
                    </span>
                    <span className="text-sm text-brown">{entry.message}</span>
                    <button
                      type="button"
                      className={`${buttonClass} min-h-9`}
                      disabled={
                        guestbookDeleteMutation.isPending &&
                        guestbookDeleteMutation.variables === entry.id
                      }
                      onClick={() => deleteGuestbook(entry.id)}
                    >
                      {guestbookDeleteMutation.isPending &&
                      guestbookDeleteMutation.variables === entry.id
                        ? `Removing ${entry.name}...`
                        : `Remove ${entry.name}`}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                title="Guestbook is empty."
                text="No entries require moderation."
              />
            )}
            <AdminPagination
              page={guestbookPage}
              total={data.guestbook.length}
              onChange={setGuestbookPage}
              label="Guestbook moderation pages"
            />
          </Panel>
        </div>
      </main>
      <SiteFooter />
      {editingEntry ? (
        <ModalDialog
          labelledBy="edit-entry-title"
          onClose={() => setEditingEntry(null)}
          closeDisabled={editMutation.isPending}
        >
          <form
            className="my-auto w-full max-w-2xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
            onSubmit={saveEntry}
          >
            <div className="mb-2.5 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
              <div>
                <p className="m-0 font-mono text-[11px] text-muted uppercase">
                  D1 record #{editingEntry.id}
                </p>
                <h2
                  id="edit-entry-title"
                  className="m-0 font-mono text-base font-bold uppercase"
                >
                  Edit {editingEntry.name}
                </h2>
              </div>
              <button
                type="button"
                className={`${buttonClass} min-w-11 px-0`}
                onClick={() => setEditingEntry(null)}
                disabled={editMutation.isPending}
                aria-label="Close"
              >
                X
              </button>
            </div>
            <input type="hidden" name="id" value={editingEntry.id} />
            <div className="grid gap-3 md:grid-cols-[1fr_180px]">
              <div>
                <AdminField
                  label="Site name"
                  name="name"
                  placeholder="Name as it should appear"
                  maxLength={60}
                  defaultValue={editingEntry.name}
                  autoFocus
                />
                <AdminField
                  label="Website address"
                  name="url"
                  type="url"
                  placeholder="https://"
                  defaultValue={editingEntry.url}
                />
              </div>
              <div>
                <FieldLabel>Current thumbnail</FieldLabel>
                <ItemThumbnail
                  thumbnailKey={editingEntry.thumbnailKey}
                  alt={
                    editingEntry.thumbnailAlt ||
                    `Preview of ${editingEntry.name}`
                  }
                  label={editingEntry.name}
                  className="aspect-4/3 w-full"
                />
              </div>
            </div>
            <div className="mb-2.5">
              <FieldLabel htmlFor="edit-entry-description">
                Card description
              </FieldLabel>
              <textarea
                id="edit-entry-description"
                name="description"
                defaultValue={editingEntry.description}
                maxLength={220}
                required
                className={`${fieldClass} min-h-24 resize-y`}
              />
              <small className="mt-1 block text-muted">
                Seeded editorial summaries and multi-paragraph notes are
                separate detail-page fields and are preserved by this editor.
                For newer entries initialized from one description, this text
                also updates their matching summary and note.
              </small>
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
                Optional. Leave empty to keep the current R2 object.
              </small>
            </div>
            <div className="grid gap-2 md:grid-cols-[1fr_180px]">
              <div className="mb-2.5">
                <TagInput
                  catalog={data.tagCatalog}
                  key={editingEntry.id}
                  label="Tags"
                  name="tags"
                  required
                  defaultValue={tagTokensFromNames(
                    editingEntry.tags,
                    data.tagCatalog,
                  )}
                  placeholder="Add canonical or freeform tags..."
                />
              </div>
              <label className="mb-2.5 block">
                <span className="mb-1 block font-mono text-xs font-bold tracking-wide uppercase">
                  Status
                </span>
                <select
                  name="status"
                  defaultValue={editingEntry.status}
                  className={fieldClass}
                >
                  <option value="active">Published</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => setEditingEntry(null)}
                disabled={editMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={primaryButtonClass}
                disabled={editMutation.isPending}
              >
                {editMutation.isPending ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </form>
        </ModalDialog>
      ) : null}
      {editingTag?.id ? (
        <ModalDialog
          labelledBy="edit-tag-title"
          onClose={() => setEditingTag(null)}
          closeDisabled={
            saveTagMutation.isPending || mergeTagMutation.isPending
          }
        >
          <form
            className="my-auto w-full max-w-xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
            onSubmit={saveTagRecord}
          >
            <div className="mb-3 flex items-center justify-between border-b border-dotted border-brown pb-2">
              <div>
                <p className="m-0 font-mono text-[11px] text-muted uppercase">
                  {editingTag.canonical ? 'Canonical tag' : 'Unwrangled tag'} /{' '}
                  {editingTag.slug}
                </p>
                <h2
                  id="edit-tag-title"
                  className="m-0 font-mono text-base font-bold uppercase"
                >
                  Wrangle {editingTag.name}
                </h2>
              </div>
              <button
                type="button"
                className={`${buttonClass} min-w-11 px-0`}
                onClick={() => setEditingTag(null)}
                disabled={
                  saveTagMutation.isPending || mergeTagMutation.isPending
                }
                aria-label="Close tag editor"
              >
                X
              </button>
            </div>
            <AdminField
              label="Display name"
              name="name"
              placeholder="Canonical display name"
              defaultValue={editingTag.name}
              maxLength={80}
              autoFocus
            />
            <AdminField
              label="Aliases"
              name="aliases"
              placeholder="audio, sounds, relaxing"
              defaultValue={editingTag.aliases.join(', ')}
              required={false}
            />
            <AdminField
              label="Parent tag slugs"
              name="parents"
              placeholder="listen, wander"
              defaultValue={editingTag.parents.join(', ')}
              required={false}
            />
            {!editingTag.canonical ? (
              <div className="mb-3 border border-dotted border-line bg-canvas p-2">
                <FieldLabel htmlFor="merge-target">
                  Or merge as an alias of
                </FieldLabel>
                <div className="flex gap-2">
                  <select
                    id="merge-target"
                    value={mergeTarget}
                    onChange={(event) => setMergeTarget(event.target.value)}
                    className={fieldClass}
                  >
                    <option value="">Choose canonical tag</option>
                    {data.tagCatalog.map((tag) => (
                      <option key={tag.slug} value={tag.slug}>
                        {tag.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={
                      !mergeTarget ||
                      mergeTagMutation.isPending ||
                      saveTagMutation.isPending
                    }
                    onClick={mergeCurrentTag}
                  >
                    Merge
                  </button>
                </div>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => setEditingTag(null)}
                disabled={
                  saveTagMutation.isPending || mergeTagMutation.isPending
                }
                aria-label="Close tag editor"
              >
                Cancel
              </button>
              <button
                type="submit"
                className={primaryButtonClass}
                disabled={
                  saveTagMutation.isPending || mergeTagMutation.isPending
                }
              >
                {saveTagMutation.isPending
                  ? 'Saving...'
                  : editingTag.canonical
                    ? 'Save tag'
                    : 'Promote to canonical'}
              </button>
            </div>
          </form>
        </ModalDialog>
      ) : null}
    </PageShell>
  )
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
  status,
  onReview,
  pending,
}: {
  submission: AdminSubmission
  status: ReviewStatus
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
              <p className="my-0.5 break-all font-mono text-xs text-muted">
                <a
                  href={submission.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-rust"
                >
                  {submission.url}
                </a>
              </p>
            </div>
            <span
              className={`shrink-0 border px-1.5 py-1 font-mono text-[11px] font-bold tracking-wide uppercase ${status === 'approved' ? 'text-success' : status === 'rejected' ? 'text-danger' : 'text-brown'}`}
            >
              {status === 'pending' ? 'Waiting' : status}
            </span>
          </div>
          <p className="my-1.5 text-brown">{submission.description}</p>
          <p className="mb-2 font-mono text-xs text-muted">
            {submission.date} / {submission.tags.join(', ')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {status !== 'approved' ? (
              <button
                type="button"
                className={`${buttonClass} bg-success text-white hover:bg-[#235a2e]`}
                onClick={() => onReview(submission, 'approved')}
                disabled={pending}
              >
                {pending
                  ? `Updating ${submission.name}...`
                  : `Approve ${submission.name}`}
              </button>
            ) : null}
            {status !== 'rejected' ? (
              <button
                type="button"
                className={`${buttonClass} bg-danger text-white hover:bg-[#7f241d]`}
                onClick={() => onReview(submission, 'rejected')}
                disabled={pending}
              >
                {pending
                  ? `Updating ${submission.name}...`
                  : `Reject ${submission.name}`}
              </button>
            ) : null}
            {status !== 'pending' ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => onReview(submission, 'pending')}
                disabled={pending}
              >
                {pending
                  ? `Updating ${submission.name}...`
                  : `Return ${submission.name} to review`}
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
  tagCatalog,
  statusPending,
}: {
  entry: ManagedEntry
  onToggle: (id: number) => void
  onEdit: (entry: ManagedEntry) => void
  tagCatalog: CanonicalTag[]
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
            fallbackClassName="from-warm to-line"
          />
          <div>
            <strong className="block">{entry.name}</strong>
            <span className="block max-w-64 break-all font-mono text-xs text-muted">
              {entry.url}
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
                {tagLabel(tag, tagCatalog)}
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
            onClick={() => onEdit(entry)}
          >
            Edit
          </button>
          {entry.source !== 'Directory' ? (
            <button
              type="button"
              className={`${buttonClass} min-h-9`}
              onClick={() => onToggle(entry.id)}
              disabled={statusPending}
            >
              {statusPending
                ? `Updating ${entry.name}...`
                : entry.status === 'active'
                  ? `Archive ${entry.name}`
                  : `Restore ${entry.name}`}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
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

function AdminPagination({
  page,
  total,
  onChange,
  label,
}: {
  page: number
  total: number
  onChange: (page: number) => void
  label: string
}) {
  const pageCount = Math.max(1, Math.ceil(total / adminPageSize))
  const safePage = Math.min(page, pageCount - 1)
  if (pageCount === 1) return null
  return (
    <nav
      className="mt-2 flex items-center justify-between gap-2 border-t border-dotted border-line pt-2"
      aria-label={label}
    >
      <button
        type="button"
        className={buttonClass}
        disabled={safePage === 0}
        onClick={() => onChange(safePage - 1)}
      >
        Previous
      </button>
      <span className="font-mono text-xs text-muted" aria-live="polite">
        Page {safePage + 1} of {pageCount}
      </span>
      <button
        type="button"
        className={buttonClass}
        disabled={safePage >= pageCount - 1}
        onClick={() => onChange(safePage + 1)}
      >
        Next
      </button>
    </nav>
  )
}

function pageItems<T>(items: T[], page: number) {
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(items.length / adminPageSize) - 1),
  )
  return items.slice(safePage * adminPageSize, (safePage + 1) * adminPageSize)
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="border border-dashed border-line bg-canvas px-3 py-6 text-center">
      <h3 className="mb-1 font-mono text-base font-bold">{title}</h3>
      <p className="m-0 text-muted">{text}</p>
    </div>
  )
}
