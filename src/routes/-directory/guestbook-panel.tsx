import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { LocalTime } from '../../components/local-time'
import { Panel, buttonClass, fieldClass } from '../../components/oddweb'
import { Turnstile } from '../../components/turnstile'
import { turnstileActions } from '../../lib/turnstile'
import { signGuestbook } from '../../server/data'

import type { FormEvent } from 'react'
import type { PublicSupportData } from '../../db/public-repository'

export function GuestbookPanel({
  entries,
  sitekey,
  setNotice,
  setNoticeError,
}: {
  entries: PublicSupportData['guestbook']
  sitekey: string
  setNotice: (notice: string) => void
  setNoticeError: (isError: boolean) => void
}) {
  const queryClient = useQueryClient()
  const tokenRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const [resetKey, setResetKey] = useState(0)
  const mutation = useMutation({
    mutationFn: (input: {
      name: string
      message: string
      hp?: string
      turnstileToken: string
    }) => signGuestbook({ data: input }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
  })

  function resetChallenge() {
    tokenRef.current = null
    setResetKey((key) => key + 1)
  }

  async function addEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutation.isPending || submittingRef.current) return

    const form = event.currentTarget
    const formData = new FormData(form)
    const name = String(formData.get('name') || '').trim()
    const message = String(formData.get('message') || '').trim()
    const hp = String(formData.get('message_hp') || '')
    if (!name || !message) return
    if (!tokenRef.current) {
      setNotice('Complete the verification check before signing.')
      setNoticeError(true)
      return
    }

    submittingRef.current = true
    setNotice('')
    setNoticeError(false)
    try {
      await mutation.mutateAsync({
        name,
        message,
        hp,
        turnstileToken: tokenRef.current,
      })
    } catch (error) {
      submittingRef.current = false
      resetChallenge()
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not sign the guestbook.',
      )
      setNoticeError(true)
      return
    }

    submittingRef.current = false
    form.reset()
    resetChallenge()
    setNotice('Your guestbook note was added.')
  }

  return (
    <Panel title="Guestbook" label="NEWEST VISITORS">
      <div className="grid gap-4 md:grid-cols-[.8fr_1.2fr]">
        <div>
          <form
            className="grid gap-1.5"
            onSubmit={addEntry}
            data-od-id="guestbook-form"
          >
            <fieldset
              disabled={mutation.isPending}
              className="m-0 grid min-w-0 gap-1.5 border-0 p-0"
            >
              <label className="font-mono text-xs font-bold">
                Name / alias
                <input
                  name="name"
                  required
                  maxLength={24}
                  className={`${fieldClass} mt-1`}
                  placeholder="Your screen name"
                />
              </label>
              <label className="font-mono text-xs font-bold">
                Short note
                <input
                  name="message"
                  required
                  maxLength={120}
                  className={`${fieldClass} mt-1`}
                  placeholder="What did you discover?"
                />
              </label>
              <input
                type="text"
                name="message_hp"
                tabIndex={-1}
                autoComplete="off"
                className="hidden sr-only"
                aria-hidden="true"
              />
              <Turnstile
                sitekey={sitekey}
                action={turnstileActions.guestbook}
                disabled={mutation.isPending}
                resetKey={resetKey}
                onToken={(token) => {
                  tokenRef.current = token
                }}
              />
              <button className={buttonClass} type="submit">
                {mutation.isPending ? 'Signing...' : 'Sign the wall'}
              </button>
            </fieldset>
          </form>
          <p className="mt-2 mb-0 text-sm text-brown">
            Name what you clicked, then leave a sentence for the next person.
          </p>
        </div>
        <ul className="m-0 list-none p-0 font-mono text-xs">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="grid grid-cols-[1fr_auto] gap-x-2 border-t border-dotted border-muted py-1.5 first:border-t-0 min-w-0"
            >
              <strong className="min-w-0 break-words [overflow-wrap:anywhere]">
                {entry.name}
              </strong>
              <span className="text-muted shrink-0">
                <LocalTime seconds={entry.createdAt} fallback={entry.date} />
              </span>
              <span className="col-span-2 text-brown break-words [overflow-wrap:anywhere]">
                {entry.message}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}
