import { useQuery } from '@tanstack/react-query'

import { turnstileConfigQueryOptions } from '../queries/oddweb'
import { turnstileActions } from '../lib/turnstile'
import { ModalDialog } from './oddweb'
import { Turnstile } from './turnstile'
import type { VoteChallengeState } from '../hooks/use-site-vote'

export type VoteChallengeDialogProps = {
  challenge: VoteChallengeState
}

export function VoteChallengeDialog({ challenge }: VoteChallengeDialogProps) {
  const { slug, onClose, onSubmitToken, isPending = false } = challenge

  const turnstileQuery = useQuery(turnstileConfigQueryOptions())
  const sitekey = turnstileQuery.data?.sitekey ?? ''

  return (
    <ModalDialog
      labelledBy="vote-challenge-title"
      onClose={onClose}
      closeDisabled={isPending}
    >
      <div className="my-auto w-full max-w-sm border-2 border-ink bg-paper p-4 shadow-[6px_6px_0_#2a1810]">
        <div className="mb-3 flex items-center justify-between border-b border-dotted border-brown pb-1.5">
          <h2
            id="vote-challenge-title"
            className="m-0 font-mono text-sm font-bold uppercase tracking-wide"
          >
            Quick Verification
          </h2>
          <button
            type="button"
            className="min-w-9 border-2 border-ink bg-paper px-2 py-0.5 font-mono text-xs uppercase shadow-[2px_2px_0_#2a1810] hover:bg-parchment"
            onClick={onClose}
            disabled={isPending}
            aria-label="Close"
          >
            X
          </button>
        </div>
        <p className="mb-3 font-mono text-xs text-brown">
          Please complete this quick verification to confirm your vote for{' '}
          <strong className="text-ink">{slug}</strong>.
        </p>
        <div className="flex justify-center py-2">
          <Turnstile
            sitekey={sitekey}
            action={turnstileActions.vote}
            disabled={isPending}
            onToken={(token) => {
              if (token) {
                onSubmitToken(token)
              }
            }}
          />
        </div>
        {isPending ? (
          <p className="mt-2 text-center font-mono text-xs text-brown animate-pulse">
            Recording vote...
          </p>
        ) : null}
      </div>
    </ModalDialog>
  )
}
