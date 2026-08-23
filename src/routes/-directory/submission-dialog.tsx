import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { TagInput } from '../../components/tag-input'
import { Turnstile } from '../../components/turnstile'
import {
  FieldLabel,
  ModalDialog,
  buttonClass,
  fieldClass,
  primaryButtonClass,
} from '../../components/oddweb'
import { turnstileActions } from '../../lib/turnstile'
import { submitSite } from '../../server/data'
import { SubmitField } from './submit-field'

import type { FormEvent } from 'react'

export function SubmissionDialog({
  sitekey,
  notice,
  noticeError,
  onClose,
  setNotice,
  setNoticeError,
}: {
  sitekey: string
  notice: string
  noticeError: boolean
  onClose: () => void
  setNotice: (notice: string) => void
  setNoticeError: (isError: boolean) => void
}) {
  const queryClient = useQueryClient()
  const tokenRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const [resetKey, setResetKey] = useState(0)
  const mutation = useMutation({
    mutationFn: (form: FormData) => submitSite({ data: form }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
      ]),
  })

  function resetChallenge() {
    tokenRef.current = null
    setResetKey((key) => key + 1)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutation.isPending || submittingRef.current) return

    const form = event.currentTarget
    const formData = new FormData(form)
    removeEmptyFile(formData, 'image')
    if (!tokenRef.current) {
      setNotice('Complete the verification check before submitting.')
      setNoticeError(true)
      return
    }
    formData.set('turnstileToken', tokenRef.current)
    const name = String(formData.get('name') || 'Your site')

    submittingRef.current = true
    setNotice('')
    setNoticeError(false)

    let result: unknown
    try {
      result = await mutation.mutateAsync(formData)
    } catch (error) {
      submittingRef.current = false
      resetChallenge()
      setNotice(
        error instanceof Error
          ? error.message
          : 'The submission could not be saved.',
      )
      setNoticeError(true)
      return
    }

    submittingRef.current = false
    if (!isSubmittedSite(result)) {
      resetChallenge()
      setNotice('The submission was not accepted.')
      setNoticeError(true)
      return
    }

    setNotice(`${name} was submitted for review.`)
    form.reset()
    resetChallenge()
    onClose()
  }

  return (
    <ModalDialog
      labelledBy="submit-title"
      onClose={onClose}
      closeDisabled={mutation.isPending}
    >
      <form
        className="my-auto w-full max-w-xl border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
        onSubmit={submit}
        data-od-id="submit-dialog"
      >
        <input
          type="text"
          name="homepage_hp"
          tabIndex={-1}
          autoComplete="off"
          className="hidden sr-only"
          aria-hidden="true"
        />
        <div className="mb-2.5 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
          <h2
            id="submit-title"
            className="m-0 font-mono text-sm font-bold tracking-wide uppercase"
          >
            Submit a site
          </h2>
          <button
            type="button"
            className={`${buttonClass} min-w-11 px-0`}
            onClick={onClose}
            disabled={mutation.isPending}
            aria-label="Close"
          >
            X
          </button>
        </div>
        <fieldset
          disabled={mutation.isPending}
          className="m-0 min-w-0 border-0 p-0"
        >
          <SubmitField
            label="Site name"
            name="name"
            placeholder="Enter the site's name"
            maxLength={40}
            autoFocus
          />
          <SubmitField
            label="Website address"
            name="url"
            type="url"
            placeholder="https://"
          />
          <div className="mb-2">
            <FieldLabel htmlFor="submit-image">Site preview image</FieldLabel>
            <div className="border border-dotted border-brown bg-canvas p-2">
              <input
                id="submit-image"
                name="image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Site preview image"
                className="w-full"
              />
              <small className="mt-1 block text-muted">
                Optional. PNG, JPEG, or WebP, up to 8 MB.
              </small>
            </div>
          </div>
          <div className="mb-2">
            <TagInput
              label="Tags"
              name="tags"
              required
              placeholder="Try sound, wander, useless..."
            />
          </div>
          <div className="mb-2">
            <FieldLabel htmlFor="submit-description">
              Short description
            </FieldLabel>
            <textarea
              id="submit-description"
              name="description"
              required
              maxLength={200}
              rows={3}
              className={`${fieldClass} resize-y`}
              placeholder="What happens when you click?"
            />
          </div>
          <div className="mb-2">
            <Turnstile
              sitekey={sitekey}
              action={turnstileActions.submission}
              disabled={mutation.isPending}
              resetKey={resetKey}
              onToken={(token) => {
                tokenRef.current = token
              }}
            />
          </div>
          {noticeError ? (
            <p
              className="mb-2 border border-danger bg-canvas px-2 py-1.5 font-mono text-xs text-danger"
              role="alert"
            >
              {notice}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Submitting...' : 'Submit site'}
            </button>
          </div>
        </fieldset>
      </form>
    </ModalDialog>
  )
}

function isSubmittedSite(value: unknown): value is { submitted: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'submitted' in value &&
    value.submitted === true
  )
}

function removeEmptyFile(data: FormData, name: string) {
  const value = data.get(name)
  if (value === '' || (value instanceof File && value.size === 0)) {
    data.delete(name)
  }
}
