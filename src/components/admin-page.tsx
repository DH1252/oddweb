import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'

import { PageShell, SiteFooter, SiteHeader, buttonClass } from './oddweb'
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

export default function AdminPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { admin } = getRouteApi('/admin').useRouteContext()
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

  async function logOut() {
    try {
      await logoutMutation.mutateAsync()
      queryClient.clear()
      await navigate({ to: '/admin/login' })
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
    } finally {
      if (request === editorRequestRef.current) setOpeningEditorId(null)
    }
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
      onDirectoryChanged()
      await refreshData()
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
      onDirectoryChanged()
      await refreshData()
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
      onDirectoryChanged()
      await refreshData()
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
          <SubmissionsSection
            refresh={refreshData}
            showStatus={showStatus}
            handleAdminError={handleAdminError}
            onDirectoryChanged={onDirectoryChanged}
          />
          <AddSiteSection
            refresh={refreshData}
            showStatus={showStatus}
            handleAdminError={handleAdminError}
            onDirectoryChanged={onDirectoryChanged}
          />
          <SiteManagementSection
            resetToken={resetToken}
            refresh={refreshData}
            showStatus={showStatus}
            handleAdminError={handleAdminError}
            openEditor={openEditor}
            openingEditorId={openingEditorId}
          />
          <TagCorrectionsSection
            resetToken={resetToken}
            unmappedCount={overview.unmappedTags}
            refresh={refreshData}
            showStatus={showStatus}
            handleAdminError={handleAdminError}
            onEditTag={(record) => {
              setEditorError('')
              setEditingTag(record)
              setMergeTarget('')
            }}
            editorBusy={saveTagMutation.isPending || mergeTagMutation.isPending}
          />
          <GuestbookSection
            refresh={refreshData}
            showStatus={showStatus}
            handleAdminError={handleAdminError}
          />
        </div>
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
