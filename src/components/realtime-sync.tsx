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
    let stopped = false
    let attempts = 0

    const resync = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
        queryClient.invalidateQueries({ queryKey: ['oddweb', 'tags'] }),
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
          } else {
            await refreshSiteView(event.slug)
          }
        } catch {
          // Ignore malformed messages; D1 remains authoritative.
        }
      })
      socket.addEventListener('close', () => {
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
      document.removeEventListener('visibilitychange', handleVisibility)
      socket?.close(1000, 'Page closed')
    }
  }, [queryClient])

  return null
}
