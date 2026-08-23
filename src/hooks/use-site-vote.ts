import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

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

type InFlightVote = {
  slug: string
  initialVoted: boolean
  initialVotes: number
}

export function useSiteVote(options?: UseSiteVoteOptions) {
  const queryClient = useQueryClient()
  const [localNotice, setLocalNotice] = useState('')
  const [localNoticeError, setLocalNoticeError] = useState(false)
  const [challengeSlug, setChallengeSlug] = useState<string | null>(null)
  const [inFlightVote, setInFlightVote] = useState<InFlightVote | null>(null)

  const updateNotice = (message: string, isError = false) => {
    setLocalNotice(message)
    setLocalNoticeError(isError)
    options?.setNotice?.(message)
    options?.setNoticeError?.(isError)
  }

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
      setInFlightVote(null)
      updateNotice(
        error instanceof Error ? error.message : 'Could not record your vote.',
        true,
      )
    },
    onSuccess: (result, variables) => {
      const { slug } = variables
      if (result.requireChallenge) {
        const triggerChallenge = (targetSlug: string) => {
          setInFlightVote(null)
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

      setInFlightVote(null)

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

  const isVoted = (slug: string) => {
    const cached = queryClient.getQueryData<{ slugs: string[] }>([
      'oddweb',
      'public',
      'my-votes',
    ])
    const activeSlugs = cached?.slugs ?? myVotes
    return activeSlugs.includes(slug)
  }

  const toggleVote = (
    slug: string,
    currentVotes?: number,
    turnstileToken?: string,
  ) => {
    if (inFlightVote) {
      return
    }
    const initialVoted = isVoted(slug)
    setInFlightVote({
      slug,
      initialVoted,
      initialVotes: currentVotes ?? 0,
    })
    voteMutation.mutate({
      slug,
      requestId: crypto.randomUUID(),
      turnstileToken,
    })
  }

  const isPendingFor = (slug: string) => inFlightVote?.slug === slug

  const submitChallengeVote = async (turnstileToken: string) => {
    if (!challengeSlug) return
    const targetSlug = challengeSlug
    setChallengeSlug(null)
    const targetVoted = isVoted(targetSlug)
    const cachedSite = queryClient.getQueryData<{ site: SiteEntry }>([
      'oddweb',
      'public',
      'site',
      targetSlug,
    ])
    setInFlightVote({
      slug: targetSlug,
      initialVoted: targetVoted,
      initialVotes: cachedSite?.site.votes ?? 0,
    })
    try {
      await voteMutation.mutateAsync({
        slug: targetSlug,
        requestId: crypto.randomUUID(),
        turnstileToken,
      })
    } catch {
      setInFlightVote(null)
    }
  }

  const clearChallenge = () => {
    setChallengeSlug(null)
  }

  const challenge: VoteChallengeState | null = challengeSlug
    ? {
        slug: challengeSlug,
        onClose: clearChallenge,
        onSubmitToken: submitChallengeVote,
        isPending: voteMutation.isPending,
      }
    : null

  const getOptimisticVoteState = (slug: string, serverVotes: number) => {
    const serverVoted = isVoted(slug)
    if (inFlightVote?.slug === slug) {
      const nextVoted = !inFlightVote.initialVoted
      const delta = inFlightVote.initialVoted ? -1 : 1
      const optimisticVotes = Math.max(0, inFlightVote.initialVotes + delta)
      return {
        voted: nextVoted,
        votes: optimisticVotes,
        isPending: true,
      }
    }
    return {
      voted: serverVoted,
      votes: serverVotes,
      isPending: false,
    }
  }

  return {
    toggleVote,
    isVoted,
    isPendingFor,
    getOptimisticVoteState,
    pendingSlug: inFlightVote?.slug ?? null,
    isAnyPending: inFlightVote !== null,
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
