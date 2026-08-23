import { startTransition, useState } from 'react'

import { AutomationBox } from './admin-automation-ui'
import { AdminPagination, Empty } from './admin-ui'
import { jobSnapshotIdentity } from './admin-automation-jobs-state'
import { automationPageSize } from './admin-automation-shared'
import { LocalTime } from './local-time'
import { buttonClass, fieldClass, primaryButtonClass } from './oddweb'
import { formatTimestamp, humanize } from '../lib/admin-format'
import { isRetryableJobStatus } from '../lib/admin-parsers'

import type { AutomationJobsBatchesModel } from './admin-automation-section'
import type {
  TaxonomyBatchStatus,
  TaxonomyJobKind,
  TaxonomyJobStatus,
} from '../lib/taxonomy-types'

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
  'rolling_back',
  'rolled_back',
  'failed',
  'partial',
]

export function AutomationJobsBatches({
  model,
}: {
  model: AutomationJobsBatchesModel
}) {
  const snapshotIdentity = jobSnapshotIdentity(
    model.jobs,
    model.jobStatus,
    model.jobKind,
  )
  return (
    <>
      <AutomationJobs key={snapshotIdentity} model={model} />
      <ProviderAttempts model={model} />
    </>
  )
}

function AutomationJobs({ model }: { model: AutomationJobsBatchesModel }) {
  const {
    dispatchMutation,
    dispatchPendingJobs,
    jobKind,
    jobs,
    jobStatus,
    retryJobs,
    retryMutation,
    setJobKind,
    setJobPage,
    setJobStatus,
  } = model
  const [selectedJobs, setSelectedJobs] = useState<string[]>([])
  const retryableJobIds = new Set<string>()
  for (const job of jobs.items) {
    if (isRetryableJobStatus(job.status)) retryableJobIds.add(String(job.id))
  }
  const selectedRetryableJobs = selectedJobs.filter((id) =>
    retryableJobIds.has(id),
  )
  const selectedJobIds = new Set(selectedRetryableJobs)

  function toggleJob(id: string, checked: boolean) {
    setSelectedJobs((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id),
    )
  }

  return (
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
                startTransition(() => {
                  setJobPage(0)
                  setJobStatus(
                    (event.target.value || null) as TaxonomyJobStatus | null,
                  )
                })
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
                startTransition(() => {
                  setJobPage(0)
                  setJobKind(
                    (event.target.value || null) as TaxonomyJobKind | null,
                  )
                })
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
            disabled={
              !selectedRetryableJobs.length ||
              retryMutation.isPending ||
              dispatchMutation.isPending
            }
            onClick={() => retryJobs(selectedRetryableJobs)}
          >
            {retryMutation.isPending
              ? 'Retrying...'
              : `Retry selected (${selectedRetryableJobs.length})`}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={dispatchMutation.isPending || retryMutation.isPending}
            onClick={dispatchPendingJobs}
          >
            {dispatchMutation.isPending
              ? 'Dispatching...'
              : 'Dispatch pending now'}
          </button>
        </div>
        <p className="mt-0 mb-2 font-mono text-xs text-muted">
          Pending, waiting, leased, dead, settled, and degraded jobs can be
          retried. Retry resets them to pending and sends them to the queue
          immediately. Dispatch pending now flushes the outbox without waiting
          for cron.
        </p>
        {jobs.items.length ? (
          <>
            <div id="taxonomy-job-results" tabIndex={-1}>
              <ul className="m-0 grid list-none gap-2 p-0 md:hidden">
                {jobs.items.map((job) => {
                  const id = String(job.id)
                  const retryable = isRetryableJobStatus(job.status)
                  return (
                    <li key={id} className="border border-line bg-paper p-2">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Select job ${id} for retry`}
                          disabled={!retryable}
                          checked={selectedJobIds.has(id)}
                          onChange={(event) =>
                            toggleJob(id, event.target.checked)
                          }
                        />
                        <JobSummary job={job} />
                      </div>
                    </li>
                  )
                })}
              </ul>
              <div className="hidden overflow-x-auto border border-line md:block">
                <table className="w-full min-w-[900px] border-collapse">
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
                      const retryable = isRetryableJobStatus(job.status)
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
                              checked={selectedJobIds.has(id)}
                              onChange={(event) =>
                                toggleJob(id, event.target.checked)
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
                            <LocalTime
                              seconds={Number(job.updatedAt)}
                              fallback={formatTimestamp(job.updatedAt)}
                              style="dateTime"
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <AdminPagination
              page={jobs.page}
              total={jobs.total}
              pageSize={automationPageSize}
              onChange={setJobPage}
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
  )
}

function JobSummary({
  job,
}: {
  job: AutomationJobsBatchesModel['jobs']['items'][number]
}) {
  return (
    <div className="min-w-0">
      <strong className="block">
        {humanize(String(job.kind))} / {humanize(String(job.status))}
      </strong>
      <span className="block font-mono text-xs text-muted [overflow-wrap:anywhere]">
        {String(job.id)}
      </span>
      <p className="my-1 font-mono text-xs">
        {job.siteId
          ? `Site #${String(job.siteId)}`
          : String(job.conceptKey || '-')}{' '}
        / taxonomy v{String(job.taxonomyVersion)}
        <br />
        Attempts {String(job.attemptCount)} / {String(job.maxAttempts)} (
        {String(job.recordedAttempts)} recorded)
      </p>
      {job.lastErrorCode ? (
        <p className="mb-0 text-xs text-danger [overflow-wrap:anywhere]">
          {String(job.lastErrorCode)}: {String(job.lastErrorSummary || '')}
        </p>
      ) : null}
    </div>
  )
}

function ProviderAttempts({ model }: { model: AutomationJobsBatchesModel }) {
  const { attemptJobId, attempts, setAttemptJobId, setAttemptPage } = model
  return (
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
                          <LocalTime
                            seconds={Number(attempt.startedAt)}
                            fallback={formatTimestamp(attempt.startedAt)}
                            style="dateTime"
                          />{' '}
                          to{' '}
                          {attempt.completedAt ? (
                            <LocalTime
                              seconds={Number(attempt.completedAt)}
                              fallback={formatTimestamp(attempt.completedAt)}
                              style="dateTime"
                            />
                          ) : (
                            'in progress'
                          )}
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
  )
}

export function AutomationChangeBatches({
  model,
}: {
  model: AutomationJobsBatchesModel
}) {
  const {
    batches,
    batchStatus,
    rollback,
    rollbackMutation,
    setBatchPage,
    setBatchStatus,
  } = model
  return (
    <AutomationBox title="Change batches" label={`${batches.total} RECORDS`}>
      <label className="mb-2 block">
        <span className="mb-1 block font-mono text-xs font-bold uppercase">
          Batch status
        </span>
        <select
          className={fieldClass}
          value={batchStatus || ''}
          onChange={(event) =>
            startTransition(() => {
              setBatchPage(0)
              setBatchStatus(
                (event.target.value || null) as TaxonomyBatchStatus | null,
              )
            })
          }
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
                    <div className="min-w-0">
                      <strong className="block">
                        {humanize(String(batch.kind))} /{' '}
                        {humanize(String(batch.status))}
                      </strong>
                      <span className="block font-mono text-xs text-muted [overflow-wrap:anywhere]">
                        {id} / {String(batch.eventCount)} events /{' '}
                        <LocalTime
                          seconds={Number(batch.createdAt)}
                          fallback={formatTimestamp(batch.createdAt)}
                          style="dateTime"
                        />
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
  )
}
