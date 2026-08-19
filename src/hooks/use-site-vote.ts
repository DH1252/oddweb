import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import {
  myVotesQueryOptions,
  turnstileConfigQueryOptions,
} from '../queries/oddweb'
import { requestInvisibleTurnstileToken } from '../components/turnstile'
import { toggleSiteVote } from '../server/data'
import type { SiteEntry } from '../data/sites'

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

  const voteMutation = useMutation({
    mutationFn: (input: {
      slug: string
      requestId: string
      turnstileToken?: string
    }) => toggleSiteVote({ data: input }),
    onMutate: async ({ slug }) => {
      updateNotice('', false)

      await Promise.all([
        queryClient.cancelQueries({
          queryKey: ['oddweb', 'public', 'my-votes'],
        }),
        queryClient.cancelQueries({
          queryKey: ['oddweb', 'public', 'directory'],
        }),
        queryClient.cancelQueries({
          queryKey: ['oddweb', 'public', 'popular'],
        }),
        queryClient.cancelQueries({
          queryKey: ['oddweb', 'public', 'site', slug],
        }),
      ])

      const previousMyVotes = queryClient.getQueryData<{ slugs: string[] }>([
        'oddweb',
        'public',
        'my-votes',
      ])
      const previousDirectory = queryClient.getQueriesData<{
        sites: SiteEntry[]
        total: number
        page: number
        pageSize: number
      }>({ queryKey: ['oddweb', 'public', 'directory'] })
      const previousPopular = queryClient.getQueriesData<{
        sites: SiteEntry[]
        total: number
        page: number
        pageSize: number
      }>({ queryKey: ['oddweb', 'public', 'popular'] })
      const previousSite = queryClient.getQueryData<{
        site: SiteEntry
        previous: unknown
        next: unknown
      }>(['oddweb', 'public', 'site', slug])

      const currentSlugs = previousMyVotes?.slugs ?? []
      const wasVoted = currentSlugs.includes(slug)
      const delta = wasVoted ? -1 : 1

      // 1. Optimistically update my-votes
      queryClient.setQueryData<{ slugs: string[] }>(
        ['oddweb', 'public', 'my-votes'],
        {
          slugs: wasVoted
            ? currentSlugs.filter((item) => item !== slug)
            : [...currentSlugs, slug],
        },
      )

      // 2. Optimistically update directory queries
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
                  ? { ...site, votes: Math.max(0, site.votes + delta) }
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

      // 3. Optimistically update site detail query
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
                votes: Math.max(0, current.site.votes + delta),
              },
            }
          : current,
      )

      return {
        previousMyVotes,
        previousDirectory,
        previousPopular,
        previousSite,
      }
    },
    onError: (error, { slug }, context) => {
      if (context) {
        if (context.previousMyVotes) {
          queryClient.setQueryData(
            ['oddweb', 'public', 'my-votes'],
            context.previousMyVotes,
          )
        }
        for (const [queryKey, data] of context.previousDirectory) {
          queryClient.setQueryData(queryKey, data)
        }
        for (const [queryKey, data] of context.previousPopular) {
          queryClient.setQueryData(queryKey, data)
        }
        if (context.previousSite) {
          queryClient.setQueryData(
            ['oddweb', 'public', 'site', slug],
            context.previousSite,
          )
        }
      }
      updateNotice(
        error instanceof Error ? error.message : 'Could not record your vote.',
        true,
      )
    },
    onSuccess: (result, { slug }, context) => {
      if (result.requireChallenge) {
        if (context.previousMyVotes) {
          queryClient.setQueryData(
            ['oddweb', 'public', 'my-votes'],
            context.previousMyVotes,
          )
        }
        for (const [queryKey, data] of context.previousDirectory) {
          queryClient.setQueryData(queryKey, data)
        }
        for (const [queryKey, data] of context.previousPopular) {
          queryClient.setQueryData(queryKey, data)
        }
        if (context.previousSite) {
          queryClient.setQueryData(
            ['oddweb', 'public', 'site', slug],
            context.previousSite,
          )
        }
        if (sitekey) {
          requestInvisibleTurnstileToken(sitekey, 'vote').then(
            (invisibleToken) => {
              if (invisibleToken) {
                voteMutation.mutate({
                  slug,
                  requestId: crypto.randomUUID(),
                  turnstileToken: invisibleToken,
                })
              } else {
                setChallengeSlug(slug)
                updateNotice('Verification check required for this vote.', true)
                options?.onChallengeRequired?.(slug)
              }
            },
          )
          return
        }

        setChallengeSlug(slug)
        updateNotice('Verification check required for this vote.', true)
        options?.onChallengeRequired?.(slug)
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
          const slugs = current?.slugs ?? []
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
      ])
    },
  })

  const toggleVote = useCallback(
    (slug: string, turnstileToken?: string) => {
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
    (slug: string) => myVotes.includes(slug),
    [myVotes],
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

  return {
    toggleVote,
    isVoted,
    isPendingFor,
    pendingSlug: voteMutation.isPending ? voteMutation.variables.slug : null,
    isAnyPending: voteMutation.isPending,
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
