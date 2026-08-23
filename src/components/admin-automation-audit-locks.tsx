import { startTransition } from 'react'

import { AutomationBox, AutomationInput } from './admin-automation-ui'
import { AdminPagination, Empty } from './admin-ui'
import { automationPageSize } from './admin-automation-shared'
import { LocalTime } from './local-time'
import { buttonClass, fieldClass, primaryButtonClass } from './oddweb'
import { formatTimestamp, humanize } from '../lib/admin-format'

import type { AutomationAuditLocksModel } from './admin-automation-section'
import type { TaxonomyLockScope } from '../lib/taxonomy-types'

export function AutomationAuditEvents({
  model,
}: {
  model: AutomationAuditLocksModel
}) {
  const {
    audit,
    auditBatch,
    auditEntity,
    rollback,
    rollbackMutation,
    setAuditBatch,
    setAuditEntity,
    setAuditPage,
  } = model
  return (
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
                <li key={eventId} className="border border-line bg-paper p-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <strong className="block">
                        {humanize(String(event.eventType))}
                      </strong>
                      <span className="block font-mono text-xs text-muted [overflow-wrap:anywhere]">
                        {eventId} / {String(event.entityType)}{' '}
                        {String(event.entityId)} /{' '}
                        <LocalTime
                          seconds={Number(event.createdAt)}
                          fallback={formatTimestamp(event.createdAt)}
                          style="dateTime"
                        />
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
                  <p className="mt-1 mb-0 font-mono text-xs text-muted [overflow-wrap:anywhere]">
                    Batch {String(event.batchId || '-')} / actor{' '}
                    {String(event.actorType)}:{String(event.actorId || '-')} /
                    versions {String(event.taxonomyVersionBefore ?? '-')} to{' '}
                    {String(event.taxonomyVersionAfter ?? '-')}
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
  )
}

export function AutomationLocks({
  model,
}: {
  model: AutomationAuditLocksModel
}) {
  const {
    lockCreateMutation,
    lockReleaseMutation,
    locks,
    lockScope,
    lockState,
    releaseLock,
    setLockPage,
    setLockScope,
    setLockState,
    submitLock,
  } = model
  return (
    <div className="mt-2 grid items-start gap-2 xl:grid-cols-[1.2fr_.8fr]">
      <AutomationBox title="Automation locks" label={`${locks.total} RECORDS`}>
        <label className="mb-2 block max-w-xs">
          <span className="mb-1 block font-mono text-xs font-bold uppercase">
            Lock state
          </span>
          <select
            className={fieldClass}
            value={lockState}
            onChange={(event) => {
              startTransition(() => {
                setLockPage(0)
                setLockState(event.target.value as typeof lockState)
              })
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
                        {lock.releasedAt ? (
                          <>
                            Released{' '}
                            <LocalTime
                              seconds={Number(lock.releasedAt)}
                              fallback={formatTimestamp(lock.releasedAt)}
                              style="dateTime"
                            />
                          </>
                        ) : (
                          'Active'
                        )}
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
  )
}
