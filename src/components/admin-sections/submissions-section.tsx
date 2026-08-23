import { useSuspenseQuery } from '@tanstack/react-query'
import { startTransition, useState } from 'react'

import { adminSubmissionsQueryOptions } from '../../queries/oddweb'
import { reviewSubmission } from '../../server/data'
import { Panel, fieldClass } from '../oddweb'
import { AdminPagination, Empty } from '../admin-ui'
import { SubmissionCard } from '../admin-cards'
import { useAdminMutation } from '../use-admin-mutation'
import type { ReviewStatus } from '../../lib/admin-types'
import type { AdminSubmission } from '../../db/repository'

export function SubmissionsSection({
  refresh,
  showStatus,
  handleAdminError,
  onDirectoryChanged,
}: {
  refresh: () => Promise<void>
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
  onDirectoryChanged: () => void
}) {
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | 'all'>(
    'pending',
  )
  const [submissionPage, setSubmissionPage] = useState(0)
  const { data: submissionResults } = useSuspenseQuery(
    adminSubmissionsQueryOptions(submissionPage, reviewFilter),
  )
  const reviewMutation = useAdminMutation({
    mutationFn: (input: { id: number; status: ReviewStatus }) =>
      reviewSubmission({ data: input }),
    onSuccess: async () => {
      setSubmissionPage(0)
      onDirectoryChanged()
      await refresh()
    },
  })

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

  return (
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
            startTransition(() => {
              setSubmissionPage(0)
              setReviewFilter(event.target.value as ReviewStatus | 'all')
            })
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
                pending={reviewMutation.isPending}
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
  )
}
