import { LocalTime } from './local-time'
import {
  ItemThumbnail,
  buttonClass,
  dangerButtonClass,
  successButtonClass,
} from './oddweb'

import type {
  AdminSite,
  AdminSubmission,
  AdminTagRecord,
} from '../db/repository'
import type { ReviewStatus } from '../lib/admin-types'

export function SubmissionCard({
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
        <div className="min-w-0">
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
            <LocalTime
              seconds={submission.submittedAt}
              fallback={submission.date}
            />{' '}
            / {submission.tags.join(', ')}
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

export function ManagedRow({
  entry,
  onToggle,
  onEdit,
  statusPending,
  editPending,
}: {
  entry: AdminSite
  onToggle: (entry: AdminSite) => void
  onEdit: (id: number) => void
  statusPending: boolean
  editPending: boolean
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
            disabled={editPending || statusPending}
            aria-label={`Edit ${entry.name}`}
          >
            {editPending ? 'Loading...' : 'Edit'}
          </button>
          {entry.source !== 'Directory' ? (
            <button
              type="button"
              className={`${buttonClass} min-h-9`}
              onClick={() => onToggle(entry)}
              disabled={statusPending}
              aria-label={`${entry.status === 'active' ? 'Archive' : 'Restore'} ${entry.name}`}
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

export function TagRow({
  tag,
  onEdit,
  onForce,
  disabled,
  forceDisabled,
}: {
  tag: AdminTagRecord
  onEdit: (tag: AdminTagRecord) => void
  onForce: (tag: AdminTagRecord) => void
  disabled: boolean
  forceDisabled: boolean
}) {
  return (
    <tr className="border-b border-dotted border-line last:border-b-0">
      <td className="p-2">
        <strong className="block">{tag.name}</strong>
        <span className="font-mono text-xs text-muted">{tag.slug}</span>
      </td>
      <td className="p-2 font-mono text-xs">
        {tag.canonical
          ? 'Canonical'
          : tag.status === 'merged'
            ? 'Merged'
            : tag.status === 'deprecated'
              ? 'Deprecated'
              : 'Unmapped'}
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
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={`${buttonClass} min-h-9`}
            onClick={() => onEdit(tag)}
            disabled={disabled}
          >
            Correct
          </button>
          <button
            type="button"
            className={`${buttonClass} min-h-9`}
            onClick={() => onForce(tag)}
            disabled={disabled || forceDisabled || tag.status !== 'active'}
            aria-label={`Force relation inference for ${tag.name}`}
          >
            Force inference
          </button>
        </div>
      </td>
    </tr>
  )
}
