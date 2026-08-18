import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { adminGuestbookQueryOptions } from '../../queries/oddweb'
import { setGuestbookEntryVisibility } from '../../server/data'
import { Panel, buttonClass } from '../oddweb'
import { AdminPagination, Empty } from '../admin-ui'
import { LocalTime } from '../local-time'

export function GuestbookSection({
  refresh,
  showStatus,
  handleAdminError,
}: {
  refresh: () => Promise<void>
  showStatus: (message: string, state?: 'success' | 'error' | '') => void
  handleAdminError: (error: unknown, fallback: string) => Promise<string>
}) {
  const [guestbookPage, setGuestbookPage] = useState(0)
  const { data: guestbookResults } = useSuspenseQuery(
    adminGuestbookQueryOptions(guestbookPage),
  )
  const guestbookMutation = useMutation({
    mutationFn: (input: { id: number; hidden: boolean }) =>
      setGuestbookEntryVisibility({ data: input }),
  })

  async function changeGuestbookVisibility(id: number, hidden: boolean) {
    const entry = guestbookResults.items.find((item) => item.id === id)
    if (
      hidden &&
      !window.confirm(`Hide ${entry?.name || 'this entry'} from the guestbook?`)
    )
      return
    try {
      const result = await guestbookMutation.mutateAsync({ id, hidden })
      if (result.id !== id || result.hidden !== hidden) {
        throw new Error('Guestbook visibility was not updated.')
      }
      setGuestbookPage(0)
      await refresh()
      showStatus(
        hidden ? 'Guestbook entry hidden.' : 'Guestbook entry restored.',
        'success',
      )
    } catch (error) {
      showStatus(
        await handleAdminError(error, 'Could not update the entry.'),
        'error',
      )
    }
  }

  return (
    <Panel
      title="Guestbook moderation"
      label={`${guestbookResults.total} RECORDS`}
      className="md:col-span-2"
    >
      {guestbookResults.items.length ? (
        <>
          <ul
            id="guestbook-results"
            tabIndex={-1}
            className="m-0 list-none p-0 outline-none"
          >
            {guestbookResults.items.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-2 border-t border-dotted border-line py-2 first:border-t-0 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="font-mono text-xs">
                  <strong className="block">{entry.name}</strong>
                  <span className="text-muted">
                    <LocalTime
                      seconds={entry.createdAt}
                      fallback={entry.date}
                    />
                  </span>
                </span>
                <span className="text-sm text-brown">{entry.message}</span>
                <button
                  type="button"
                  className={`${buttonClass} min-h-9`}
                  disabled={guestbookMutation.isPending}
                  onClick={() =>
                    changeGuestbookVisibility(entry.id, !entry.hidden)
                  }
                >
                  {guestbookMutation.isPending &&
                  guestbookMutation.variables.id === entry.id
                    ? 'Saving...'
                    : entry.hidden
                      ? `Restore ${entry.name}`
                      : `Hide ${entry.name}`}
                </button>
              </li>
            ))}
          </ul>
          <AdminPagination
            page={guestbookResults.page}
            total={guestbookResults.total}
            onChange={setGuestbookPage}
            label="Guestbook moderation pages"
            focusTargetId="guestbook-results"
          />
        </>
      ) : (
        <Empty
          title="Guestbook is empty."
          text="No entries require moderation."
        />
      )}
    </Panel>
  )
}
