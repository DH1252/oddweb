import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { startTransition, useDeferredValue, useEffect, useState } from 'react'

import { adminSitesQueryOptions } from '../../queries/oddweb'
import { updateSiteStatus } from '../../server/data'
import { Panel, buttonClass, fieldClass } from '../oddweb'
import { AdminPagination, Empty } from '../admin-ui'
import { ManagedRow } from '../admin-cards'
import { TagInput } from '../tag-input'
import type { EntryStatus } from '../../lib/admin-types'
import type { AdminSite } from '../../db/repository'

export function SiteManagementSection({
  resetToken,
  refresh,
  showStatus,
  handleAdminError,
  openEditor,
  openingEditorId,
}: {
  resetToken: number
  refresh: () => Promise<void>
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
  openEditor: (id: number) => Promise<void>
  openingEditorId: number | null
}) {
  const [siteFilter, setSiteFilter] = useState<EntryStatus | 'all'>('active')
  const [siteSearch, setSiteSearch] = useState('')
  const [includedTags, setIncludedTags] = useState<string[]>([])
  const [excludedTags, setExcludedTags] = useState<string[]>([])
  const [sitePage, setSitePage] = useState(0)
  const deferredSiteSearch = useDeferredValue(siteSearch.trim())
  const { data: siteResults } = useSuspenseQuery(
    adminSitesQueryOptions({
      page: sitePage,
      status: siteFilter,
      search: deferredSiteSearch,
      includeTags: includedTags,
      excludeTags: excludedTags,
    }),
  )
  const statusMutation = useMutation({
    mutationFn: (input: { id: number; status: EntryStatus }) =>
      updateSiteStatus({ data: input }),
  })

  useEffect(() => {
    setSitePage(0)
  }, [resetToken])

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
      setSitePage(0)
      await refresh()
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

  function setManagementTags(type: 'include' | 'exclude', tags: string[]) {
    startTransition(() => {
      if (type === 'include') {
        setIncludedTags(tags)
        setExcludedTags((current) =>
          current.filter((tag) => !tags.includes(tag)),
        )
      } else {
        setExcludedTags(tags)
        setIncludedTags((current) =>
          current.filter((tag) => !tags.includes(tag)),
        )
      }
      setSitePage(0)
    })
  }

  return (
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
              startTransition(() => {
                setSitePage(0)
                setSiteFilter(event.target.value as EntryStatus | 'all')
              })
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
              <caption className="sr-only">Oddweb directory records</caption>
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
                    statusPending={statusMutation.isPending}
                    editPending={openingEditorId === entry.id}
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
  )
}
