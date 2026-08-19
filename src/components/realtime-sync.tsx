import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { parseRealtimeEvent } from '../realtime/events'

export function isAdminPath(pathname: string) {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

export function RealtimeSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let taxonomyRefreshTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let stopped = false
    let attempts = 0

    const heartbeat = () => {
      if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
    }

    const resync = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'tags'] }),
      ])
    }

    const applySiteVote = (slug: string, votes: number) => {
      const updateEntry = <
        T extends {
          sites: Array<{
            slug: string
            votes?: number
            [key: string]: unknown
          }>
        },
      >(
        current: T | undefined,
      ) =>
        current
          ? {
              ...current,
              sites: current.sites.map((site) =>
                site.slug === slug ? { ...site, votes } : site,
              ),
            }
          : current

      queryClient.setQueriesData(
        { queryKey: ['oddweb', 'public', 'directory'] },
        updateEntry,
      )
      queryClient.setQueriesData(
        { queryKey: ['oddweb', 'public', 'popular'] },
        updateEntry,
      )
      queryClient.setQueryData<
        | { site: { slug: string; votes?: number; [key: string]: unknown } }
        | undefined
      >(['oddweb', 'public', 'site', slug], (current) =>
        current
          ? {
              ...current,
              site: { ...current.site, votes },
            }
          : current,
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
          queryKey: ['oddweb', 'admin'],
          refetchType: 'none',
        }),
      ])
    }

    const applySiteViews = (slug: string, views: number) => {
      const updateEntry = <
        T extends {
          sites: Array<{
            slug: string
            visits?: number
            [key: string]: unknown
          }>
        },
      >(
        current: T | undefined,
      ) =>
        current
          ? {
              ...current,
              sites: current.sites.map((site) =>
                site.slug === slug ? { ...site, visits: views } : site,
              ),
            }
          : current

      queryClient.setQueriesData(
        { queryKey: ['oddweb', 'public', 'directory'] },
        updateEntry,
      )
      queryClient.setQueriesData(
        { queryKey: ['oddweb', 'public', 'popular'] },
        updateEntry,
      )
      queryClient.setQueryData<
        | { site: { slug: string; visits?: number; [key: string]: unknown } }
        | undefined
      >(['oddweb', 'public', 'site', slug], (current) =>
        current
          ? {
              ...current,
              site: { ...current.site, visits: views },
            }
          : current,
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
          queryKey: ['oddweb', 'admin'],
          refetchType: 'none',
        }),
      ])
    }

    const refreshSiteView = async (slug: string) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'directory'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'popular'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'public', 'site', slug],
        }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'tags'] }),
      ])
    }

    const refreshTaxonomy = async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'admin', 'taxonomy'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'admin', 'overview'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'admin', 'tags'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'admin', 'sites'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['oddweb', 'admin', 'site'],
        }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'tags'] }),
      ])
    }

    const connect = () => {
      if (stopped || document.visibilityState === 'hidden') return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/api/realtime`)
      socket.addEventListener('open', () => {
        attempts = 0
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(heartbeat, 25_000)
        void resync()
      })
      socket.addEventListener('message', async (message) => {
        if (typeof message.data !== 'string' || message.data === 'pong') return
        try {
          const event = parseRealtimeEvent(JSON.parse(message.data))
          if (!event) return
          if (event.type === 'directory.changed') {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
              queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
              queryClient.invalidateQueries({ queryKey: ['oddweb', 'tags'] }),
            ])
          } else if (event.type === 'guestbook.changed') {
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: ['oddweb', 'public', 'support'],
              }),
              queryClient.invalidateQueries({
                queryKey: ['oddweb', 'admin', 'guestbook'],
              }),
            ])
          } else if (event.type === 'submission.changed') {
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: ['oddweb', 'admin', 'submissions'],
              }),
              queryClient.invalidateQueries({
                queryKey: ['oddweb', 'admin', 'overview'],
              }),
              queryClient.invalidateQueries({
                queryKey: ['oddweb', 'public', 'support'],
              }),
            ])
          } else if (event.type === 'taxonomy.changed') {
            if (taxonomyRefreshTimer) clearTimeout(taxonomyRefreshTimer)
            taxonomyRefreshTimer = setTimeout(() => {
              taxonomyRefreshTimer = undefined
              void refreshTaxonomy()
            }, 400)
          } else if (event.type === 'site.voted') {
            applySiteVote(event.slug, event.votes)
          } else {
            applySiteViews(event.slug, event.views)
            await refreshSiteView(event.slug)
          }
        } catch {
          // Ignore malformed messages; D1 remains authoritative.
        }
      })
      socket.addEventListener('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
        if (stopped || document.visibilityState === 'hidden') return
        const delay = Math.min(30_000, 1_000 * 2 ** attempts++)
        reconnectTimer = setTimeout(connect, delay)
      })
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (isAdminPath(window.location.pathname)) return
        if (reconnectTimer) clearTimeout(reconnectTimer)
        socket?.close(1000, 'Page hidden')
      } else {
        void resync()
        if (!socket || socket.readyState === WebSocket.CLOSED) connect()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    connect()
    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (taxonomyRefreshTimer) clearTimeout(taxonomyRefreshTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      document.removeEventListener('visibilitychange', handleVisibility)
      socket?.close(1000, 'Page closed')
    }
  }, [queryClient])

  return null
}
