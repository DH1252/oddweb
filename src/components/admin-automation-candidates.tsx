import { startTransition } from 'react'

import { AutomationBox } from './admin-automation-ui'
import { AdminPagination, Empty } from './admin-ui'
import { buttonClass, fieldClass } from './oddweb'
import { automationPageSize } from './admin-automation-shared'
import { humanize, microsPercent } from '../lib/admin-format'
import { parseCandidateKind, parseCandidateStatus } from '../lib/admin-parsers'

import type { AutomationCandidatesModel } from './admin-automation-section'
import type {
  TaxonomyCandidateKind,
  TaxonomyCandidateStatus,
} from '../db/taxonomy-admin-repository'

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

export function AutomationCandidates({
  model,
}: {
  model: AutomationCandidatesModel
}) {
  const {
    candidateDecisionMutation,
    candidateKind,
    candidates,
    candidateStatus,
    decideCandidate,
    setCandidateKind,
    setCandidatePage,
    setCandidateStatus,
  } = model

  return (
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
                startTransition(() => {
                  setCandidatePage(0)
                  setCandidateStatus(parseCandidateStatus(event.target.value))
                })
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
                startTransition(() => {
                  setCandidatePage(0)
                  setCandidateKind(parseCandidateKind(event.target.value))
                })
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
              {candidates.items.map((candidate) => (
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
                      <dt className="font-mono text-muted uppercase">Margin</dt>
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
                      <>
                        <ul className="m-0 list-none p-0">
                          {candidate.evidence.map((evidence) => (
                            <li
                              key={evidence.id}
                              className="border-t border-dotted border-line py-1 text-xs"
                            >
                              Site #{evidence.siteId}: {evidence.snippet} (
                              {microsPercent(evidence.confidenceMicros)},{' '}
                              {humanize(evidence.source)})
                            </li>
                          ))}
                        </ul>
                        {candidate.evidenceTotal > candidate.evidence.length ? (
                          <p className="mb-0 text-xs text-muted">
                            Showing the latest {candidate.evidence.length} of{' '}
                            {candidate.evidenceTotal} evidence records.
                          </p>
                        ) : null}
                      </>
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
                      onSubmit={(event) => decideCandidate(event, candidate.id)}
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
                            <option value="accepted">Accept and queue</option>
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
                        disabled={candidateDecisionMutation.isPending}
                      >
                        {candidateDecisionMutation.isPending
                          ? 'Saving...'
                          : 'Apply decision'}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
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
  )
}
