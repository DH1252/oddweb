import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'

import { PageShell, SiteFooter, SiteHeader, buttonClass } from './oddweb'
import { useAdminMutation } from './use-admin-mutation'
import { Stat } from './admin-ui'
import { SiteEditor, TagEditor } from './admin-editors'
import { AutomationSection } from './admin-automation-section'
import { AddSiteSection } from './admin-sections/add-site-section'
import { GuestbookSection } from './admin-sections/guestbook-section'
import { SiteManagementSection } from './admin-sections/site-management-section'
import { SubmissionsSection } from './admin-sections/submissions-section'
import { TagCorrectionsSection } from './admin-sections/tag-corrections-section'
import {
  adminOverviewQueryOptions,
  adminSiteQueryOptions,
} from '../queries/oddweb'
import { logoutAdmin } from '../server/auth'
import {
  mergeTag,
  reconcileThumbnailStorage,
  saveTag,
  updateDirectorySite,
} from '../server/data'
import { commaList } from '../lib/admin-format'

import type { FormEvent } from 'react'
import type { AdminSite, AdminTagRecord } from '../db/repository'
import type { ScanResult } from '../lib/admin-types'

const adminRouteApi = getRouteApi('/admin')

export default function AdminPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { admin } = adminRouteApi.useRouteContext()
  const { data: overview } = useSuspenseQuery(adminOverviewQueryOptions())
  const [editingEntry, setEditingEntry] = useState<AdminSite | null>(null)
  const [openingEditorId, setOpeningEditorId] = useState<number | null>(null)
  const editorRequestRef = useRef(0)
  const [editingTag, setEditingTag] = useState<AdminTagRecord | null>(null)
  const [mergeTarget, setMergeTarget] = useState('')
  const [editorError, setEditorError] = useState('')
  const [status, setStatus] = useState('Ready.')
  const [statusState, setStatusState] = useState<'success' | 'error' | ''>('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [resetToken, setResetToken] = useState(0)

  const editMutation = useAdminMutation({
    mutationFn: (form: FormData) => updateDirectorySite({ data: form }),
    onSuccess: refreshDirectoryData,
  })
  const saveTagMutation = useAdminMutation({
    mutationFn: (input: {
      id: number
      name: string
      aliases: string[]
      parents: string[]
    }) => saveTag({ data: input }),
    onSuccess: refreshDirectoryData,
  })
  const mergeTagMutation = useAdminMutation({
    mutationFn: (input: { sourceId: number; targetSlug: string }) =>
      mergeTag({ data: input }),
    onSuccess: refreshDirectoryData,
  })
  const storageMutation = useAdminMutation({
    mutationFn: (cursor?: string) =>
      reconcileThumbnailStorage({ data: cursor ? { cursor } : {} }),
    onLatestSuccess: (result) => {
      setScanResult(result)
      const summary = `${result.stored} stored checked; ${result.referenced} references checked; ${result.orphaned} unused; ${result.missing} missing.`
      showStatus(
        result.phase === 'complete'
          ? `Thumbnail scan complete. ${summary}`
          : `Thumbnail scan ${result.phase === 'r2' ? 'checking stored objects' : 'checking database references'}. ${summary}`,
        result.phase === 'complete' ? 'success' : '',
      )
    },
  })
  const logoutMutation = useAdminMutation({
    mutationFn: () => logoutAdmin(),
    onSuccess: async () => {
      queryClient.clear()
      await navigate({ to: '/admin/login' })
    },
  })

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
    const queryKeys = [
      ['oddweb', 'admin'],
      ['oddweb', 'public'],
      ['oddweb', 'tags'],
    ] as const
    await Promise.all(
      queryKeys.map(async (queryKey) => {
        await queryClient.cancelQueries({ queryKey })
        await queryClient.invalidateQueries({
          queryKey,
          refetchType: 'active',
        })
      }),
    )
  }

  function onDirectoryChanged() {
    setResetToken((token) => token + 1)
  }

  async function refreshDirectoryData() {
    onDirectoryChanged()
    await refreshData()
  }

  async function logOut() {
    try {
      await logoutMutation.mutateAsync()
    } catch (error) {
      showStatus(await handleAdminError(error, 'Could not sign out.'), 'error')
    }
  }

  async function openEditor(id: number) {
    const request = ++editorRequestRef.current
    try {
      setOpeningEditorId(id)
      showStatus('Loading site editor...')
      const entry = await queryClient.fetchQuery(adminSiteQueryOptions(id))
      if (request !== editorRequestRef.current) return
      setEditingEntry(entry)
      setEditorError('')
      showStatus('Ready.')
    } catch (error) {
      if (request !== editorRequestRef.current) return
      showStatus(
        await handleAdminError(error, 'Could not load the site editor.'),
        'error',
      )
    }
    if (request === editorRequestRef.current) setOpeningEditorId(null)
  }

  function closeSiteEditor() {
    editorRequestRef.current += 1
    setOpeningEditorId(null)
    setEditingEntry(null)
    setEditorError('')
  }

  function closeTagEditor() {
    setEditingTag(null)
    setMergeTarget('')
    setEditorError('')
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
      closeSiteEditor()
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
      closeTagEditor()
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
      closeTagEditor()
      showStatus('Tags merged.', 'success')
    } catch (error) {
      const message = await handleAdminError(error, 'Could not merge tag.')
      setEditorError(message)
      showStatus(message, 'error')
    }
  }

  async function runThumbnailScan(cursor?: string) {
    try {
      await storageMutation.mutateAsync(cursor)
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not inspect thumbnail storage.'),
        'error',
      )
    }
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
        <AdminSessionPanel
          username={admin.username}
          logoutPending={logoutMutation.isPending}
          storagePending={storageMutation.isPending}
          scanResult={scanResult}
          onLogout={logOut}
          onScan={runThumbnailScan}
        />

        <div
          className={`mt-2.5 border px-2.5 py-2 font-mono text-xs ${statusState === 'error' ? 'border-danger bg-red-50 text-danger' : statusState === 'success' ? 'border-success bg-green-50 text-success' : 'border-line bg-canvas text-brown'}`}
          role="status"
          aria-live="polite"
        >
          {status}
        </div>

        <AdminStats
          activeSites={overview.activeSites}
          pendingSubmissions={overview.pendingSubmissions}
          visits={overview.visits}
          tagsInUse={overview.tagsInUse}
        />

        <AutomationSection
          showStatus={showStatus}
          handleAdminError={handleAdminError}
        />

        <AdminManagementSections
          resetToken={resetToken}
          unmappedCount={overview.unmappedTags}
          refresh={refreshData}
          showStatus={showStatus}
          handleAdminError={handleAdminError}
          onDirectoryChanged={onDirectoryChanged}
          openEditor={openEditor}
          openingEditorId={openingEditorId}
          onEditTag={(record) => {
            setEditorError('')
            setEditingTag(record)
            setMergeTarget('')
          }}
          editorBusy={saveTagMutation.isPending || mergeTagMutation.isPending}
        />
      </main>
      <SiteFooter />
      {editingEntry ? (
        <SiteEditor
          entry={editingEntry}
          pending={editMutation.isPending}
          error={editorError}
          onClose={closeSiteEditor}
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
          onClose={closeTagEditor}
          onSubmit={saveTagRecord}
          onMerge={mergeCurrentTag}
        />
      ) : null}
    </PageShell>
  )
}

function AdminStats({
  activeSites,
  pendingSubmissions,
  visits,
  tagsInUse,
}: {
  activeSites: number
  pendingSubmissions: number
  visits: number
  tagsInUse: number
}) {
  return (
    <dl
      className="mt-2.5 grid grid-cols-1 gap-2 min-[481px]:grid-cols-2 md:grid-cols-4"
      aria-label="Directory statistics"
    >
      <Stat
        label="Published sites"
        value={activeSites}
        note="Active directory records"
      />
      <Stat
        label="Waiting review"
        value={pendingSubmissions}
        note="Unresolved submissions"
      />
      <Stat label="Views" value={visits} note="Site page views" />
      <Stat
        label="Tags in use"
        value={tagsInUse}
        note="Across active records"
      />
    </dl>
  )
}

function AdminSessionPanel({
  username,
  logoutPending,
  storagePending,
  scanResult,
  onLogout,
  onScan,
}: {
  username: string
  logoutPending: boolean
  storagePending: boolean
  scanResult: ScanResult | null
  onLogout: () => Promise<void>
  onScan: (cursor?: string) => Promise<void>
}) {
  return (
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
            Signed in as {username}
          </strong>
          <button
            type="button"
            className={`${buttonClass} min-h-9`}
            onClick={onLogout}
            disabled={logoutPending}
          >
            {logoutPending ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={`${buttonClass} min-h-9`}
            onClick={() => onScan()}
            disabled={storagePending}
          >
            {storagePending && !scanResult?.cursor
              ? 'Scanning...'
              : 'Start thumbnail scan'}
          </button>
          {scanResult?.cursor ? (
            <button
              type="button"
              className={`${buttonClass} min-h-9`}
              onClick={() => onScan(scanResult.cursor)}
              disabled={storagePending}
            >
              {storagePending ? 'Scanning...' : 'Continue thumbnail scan'}
            </button>
          ) : null}
        </div>
        {scanResult ? (
          <p className="mt-2 mb-0 font-mono text-xs text-brown">
            {scanResult.stored} stored / {scanResult.referenced} referenced /{' '}
            {scanResult.orphaned} unused / {scanResult.missing} missing
          </p>
        ) : null}
      </aside>
    </header>
  )
}

function AdminManagementSections({
  resetToken,
  unmappedCount,
  refresh,
  showStatus,
  handleAdminError,
  onDirectoryChanged,
  openEditor,
  openingEditorId,
  onEditTag,
  editorBusy,
}: {
  resetToken: number
  unmappedCount: number
  refresh: () => Promise<void>
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
  onDirectoryChanged: () => void
  openEditor: (id: number) => Promise<void>
  openingEditorId: number | null
  onEditTag: (record: AdminTagRecord) => void
  editorBusy: boolean
}) {
  return (
    <div className="mt-2.5 grid items-start gap-2.5 md:grid-cols-[1.3fr_.7fr]">
      <SubmissionsSection
        refresh={refresh}
        showStatus={showStatus}
        handleAdminError={handleAdminError}
        onDirectoryChanged={onDirectoryChanged}
      />
      <AddSiteSection
        refresh={refresh}
        showStatus={showStatus}
        handleAdminError={handleAdminError}
        onDirectoryChanged={onDirectoryChanged}
      />
      <SiteManagementSection
        resetToken={resetToken}
        refresh={refresh}
        showStatus={showStatus}
        handleAdminError={handleAdminError}
        openEditor={openEditor}
        openingEditorId={openingEditorId}
      />
      <TagCorrectionsSection
        resetToken={resetToken}
        unmappedCount={unmappedCount}
        refresh={refresh}
        showStatus={showStatus}
        handleAdminError={handleAdminError}
        onEditTag={onEditTag}
        editorBusy={editorBusy}
      />
      <GuestbookSection
        refresh={refresh}
        showStatus={showStatus}
        handleAdminError={handleAdminError}
      />
    </div>
  )
}
