import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useState } from 'react'

import { adminTagsQueryOptions } from '../../queries/oddweb'
import {
  forceTagRelationInference,
  forceUnmappedTagWrangling,
  refreshTagAssociations,
} from '../../server/taxonomy-admin'
import { Panel, buttonClass, fieldClass } from '../oddweb'
import { AdminPagination, Empty } from '../admin-ui'
import { TagRow } from '../admin-cards'
import type { AdminTagRecord } from '../../db/repository'

export function TagCorrectionsSection({
  resetToken,
  unmappedCount,
  refresh,
  showStatus,
  handleAdminError,
  onEditTag,
  editorBusy,
}: {
  resetToken: number
  unmappedCount: number
  refresh: () => Promise<void>
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
  onEditTag: (record: AdminTagRecord) => void
  editorBusy: boolean
}) {
  const [tagSearch, setTagSearch] = useState('')
  const [tagPage, setTagPage] = useState(0)
  const deferredTagSearch = useDeferredValue(tagSearch.trim())
  const { data: tagResults } = useSuspenseQuery(
    adminTagsQueryOptions(tagPage, deferredTagSearch),
  )
  const forceInferenceMutation = useMutation({
    mutationFn: (input: { tagId: number }) =>
      forceTagRelationInference({ data: input }),
  })
  const forceUnmappedWranglingMutation = useMutation({
    mutationFn: () => forceUnmappedTagWrangling({ data: {} }),
  })
  const refreshAssociationsMutation = useMutation({
    mutationFn: () => refreshTagAssociations({ data: {} }),
  })

  useEffect(() => {
    setTagPage(0)
  }, [resetToken])

  async function forceTagInference(tag: AdminTagRecord) {
    try {
      await forceInferenceMutation.mutateAsync({ tagId: tag.id })
      await refresh()
      showStatus(`Relation inference queued for "${tag.name}".`, 'success')
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not queue tag inference.'),
        'error',
      )
    }
  }

  async function forceUnmappedWrangling() {
    try {
      const result = await forceUnmappedWranglingMutation.mutateAsync()
      await refresh()
      showStatus(
        result.enqueued
          ? `Queued relation inference for ${result.enqueued} unmapped tag${
              result.enqueued === 1 ? '' : 's'
            }${result.skipped ? ` (${result.skipped} already queued)` : ''}.`
          : 'No unmapped tags are left to wrangle.',
        result.enqueued ? 'success' : '',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not queue unmapped wrangling.'),
        'error',
      )
    }
  }

  async function refreshAllTagAssociations() {
    try {
      const result = await refreshAssociationsMutation.mutateAsync()
      await refresh()
      showStatus(
        result.enqueued
          ? `Queued association refresh for ${result.enqueued} of ${result.total} tag${
              result.total === 1 ? '' : 's'
            }${result.skipped ? ` (${result.skipped} already queued)` : ''}.`
          : 'No active tags to refresh.',
        result.enqueued ? 'success' : '',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not queue association refresh.'),
        'error',
      )
    }
  }

  return (
    <Panel
      title="Advanced tag corrections"
      label={`${unmappedCount} UNMAPPED`}
      className="md:col-span-2"
    >
      <div className="mb-2.5 flex flex-wrap items-end gap-2">
        <label className="block w-full max-w-md">
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
        <button
          type="button"
          className={`${buttonClass} min-h-9`}
          onClick={() => void forceUnmappedWrangling()}
          disabled={
            unmappedCount === 0 ||
            forceUnmappedWranglingMutation.isPending ||
            forceInferenceMutation.isPending
          }
        >
          {forceUnmappedWranglingMutation.isPending
            ? 'Queuing...'
            : 'Force unmapped wrangling'}
        </button>
        <button
          type="button"
          className={`${buttonClass} min-h-9`}
          onClick={() => void refreshAllTagAssociations()}
          disabled={
            refreshAssociationsMutation.isPending ||
            forceUnmappedWranglingMutation.isPending ||
            forceInferenceMutation.isPending
          }
        >
          {refreshAssociationsMutation.isPending
            ? 'Queuing...'
            : 'Refresh tag associations'}
        </button>
      </div>
      {tagResults.items.length ? (
        <>
          <div className="overflow-x-auto border border-line">
            <table
              id="tag-results"
              tabIndex={-1}
              className="w-full min-w-[680px] border-collapse outline-none"
            >
              <caption className="sr-only">Tag definitions and usage</caption>
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
                    onEdit={onEditTag}
                    disabled={editorBusy}
                    onForce={forceTagInference}
                    forceDisabled={
                      forceInferenceMutation.isPending ||
                      forceUnmappedWranglingMutation.isPending
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
  )
}
