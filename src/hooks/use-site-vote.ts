import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import {
  myVotesQueryOptions,
  turnstileConfigQueryOptions,
} from '../queries/oddweb'
import {
  ensureTurnstileScript,
  requestInvisibleTurnstileToken,
} from '../components/turnstile'
import { turnstileActions } from '../lib/turnstile'
import { toggleSiteVote } from '../server/data'
import type { SiteEntry } from '../data/sites'

export type VoteChallengeState = {
  slug: string
  onClose: () => void
  onSubmitToken: (token: string) => void
  isPending: boolean
}

export type UseSiteVoteOptions = {
  setNotice?: (message: string) => void
  setNoticeError?: (isError: boolean) => void
  onChallengeRequired?: (slug: string) => void
}

export function useSiteVote(options?: UseSiteVoteOptions) {
  const queryClient = useQueryClient()
  const [localNotice, setLocalNotice] = useState('')
  const [localNoticeError, setLocalNoticeError] = useState(false)
  const [challengeSlug, setChallengeSlug] = useState<string | null>(null)

  const updateNotice = useCallback(
    (message: string, isError = false) => {
      setLocalNotice(message)
      setLocalNoticeError(isError)
      options?.setNotice?.(message)
      options?.setNoticeError?.(isError)
    },
    [options],
  )

  const myVotesQuery = useQuery(myVotesQueryOptions())
  const myVotes = myVotesQuery.data?.slugs ?? []
  const turnstileConfigQuery = useQuery(turnstileConfigQueryOptions())
  const sitekey = turnstileConfigQuery.data?.sitekey ?? ''

  useEffect(() => {
    if (sitekey) {
      ensureTurnstileScript(sitekey)
    }
  }, [sitekey])

  const voteMutation = useMutation({
    mutationFn: (input: {
      slug: string
      requestId: string
      turnstileToken?: string
    }) => toggleSiteVote({ data: input }),
    onMutate: () => {
      updateNotice('', false)
    },
    onError: (error) => {
      updateNotice(
        error instanceof Error ? error.message : 'Could not record your vote.',
        true,
      )
    },
    onSuccess: (result, variables) => {
      const { slug } = variables
      if (result.requireChallenge) {
        const triggerChallenge = (targetSlug: string) => {
          setChallengeSlug(targetSlug)
          updateNotice('Verification check required for this vote.', true)
          options?.onChallengeRequired?.(targetSlug)
        }

        if (sitekey) {
          requestInvisibleTurnstileToken(sitekey, turnstileActions.vote)
            .then((invisibleToken) => {
              if (invisibleToken) {
                voteMutation.mutate({
                  slug,
                  requestId: crypto.randomUUID(),
                  turnstileToken: invisibleToken,
                })
              } else {
                triggerChallenge(slug)
              }
            })
            .catch(() => {
              triggerChallenge(slug)
            })
          return
        }

        triggerChallenge(slug)
        return
      }

      setChallengeSlug(null)

      const updateSiteList = (
        current:
          | {
              sites: SiteEntry[]
              total: number
              page: number
              pageSize: number
            }
          | undefined,
      ) =>
        current
          ? {
              ...current,
              sites: current.sites.map((site) =>
                site.slug === slug
                  ? { ...site, votes: result.votes ?? site.votes }
                  : site,
              ),
            }
          : current

      queryClient.setQueriesData(
        { queryKey: ['oddweb', 'public', 'directory'] },
        updateSiteList,
      )
      queryClient.setQueriesData(
        { queryKey: ['oddweb', 'public', 'popular'] },
        updateSiteList,
      )

      queryClient.setQueryData<
        | {
            site: SiteEntry
            previous: unknown
            next: unknown
          }
        | undefined
      >(['oddweb', 'public', 'site', slug], (current) =>
        current
          ? {
              ...current,
              site: {
                ...current.site,
                votes: result.votes ?? current.site.votes,
              },
            }
          : current,
      )

      queryClient.setQueryData<{ slugs: string[] } | undefined>(
        ['oddweb', 'public', 'my-votes'],
        (current) => {
          const slugs = current?.slugs ?? myVotes
          return {
            slugs: result.voted
              ? slugs.includes(slug)
                ? slugs
                : [...slugs, slug]
              : slugs.filter((item) => item !== slug),
          }
        },
      )

      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'directory'],
          refetchType: 'none',
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'popular'],
          refetchType: 'none',
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'site', slug],
          refetchType: 'none',
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'my-votes'],
          refetchType: 'none',
        }),
      ])
    },
  })

  const toggleVote = useCallback(
    (slug: string, turnstileToken?: string) => {
      if (voteMutation.isPending && voteMutation.variables.slug === slug) {
        return
      }
      voteMutation.mutate({
        slug,
        requestId: crypto.randomUUID(),
        turnstileToken,
      })
    },
    [voteMutation],
  )

  const isPendingFor = useCallback(
    (slug: string) =>
      voteMutation.isPending && voteMutation.variables.slug === slug,
    [voteMutation.isPending, voteMutation.variables?.slug],
  )

  const isVoted = useCallback(
    (slug: string) => {
      const cached = queryClient.getQueryData<{ slugs: string[] }>([
        'oddweb',
        'public',
        'my-votes',
      ])
      const activeSlugs = cached?.slugs ?? myVotes
      return activeSlugs.includes(slug)
    },
    [myVotes, queryClient],
  )

  const submitChallengeVote = useCallback(
    async (turnstileToken: string) => {
      if (!challengeSlug) return
      const targetSlug = challengeSlug
      setChallengeSlug(null)
      await voteMutation.mutateAsync({
        slug: targetSlug,
        requestId: crypto.randomUUID(),
        turnstileToken,
      })
    },
    [challengeSlug, voteMutation],
  )

  const clearChallenge = useCallback(() => {
    setChallengeSlug(null)
  }, [])

  const challenge: VoteChallengeState | null = challengeSlug
    ? {
        slug: challengeSlug,
        onClose: clearChallenge,
        onSubmitToken: submitChallengeVote,
        isPending: voteMutation.isPending,
      }
    : null

  return {
    toggleVote,
    isVoted,
    isPendingFor,
    pendingSlug: voteMutation.isPending ? voteMutation.variables.slug : null,
    isAnyPending: voteMutation.isPending,
    challenge,
    challengeSlug,
    clearChallenge,
    submitChallengeVote,
    myVotes,
    notice: localNotice,
    noticeError: localNoticeError,
    setNotice: updateNotice,
    setNoticeError: (isError: boolean) => updateNotice(localNotice, isError),
  }
}
