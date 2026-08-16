import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

import { parseRealtimeEvent } from '../realtime/events'

export function RealtimeSync() {
  const queryClient = useQueryClient()
  const router = useRouter()

  useEffect(() => {
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let attempts = 0

    const refreshPublicData = async () => {
      await queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] })
      await router.invalidate()
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
      ])
      await router.invalidate()
    }

    const connect = () => {
      if (stopped || document.visibilityState === 'hidden') return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/api/realtime`)
      socket.addEventListener('open', () => {
        attempts = 0
        void refreshPublicData()
      })
      socket.addEventListener('message', async (message) => {
        if (typeof message.data !== 'string' || message.data === 'pong') return
        try {
          const event = parseRealtimeEvent(JSON.parse(message.data))
          if (!event) return
          if (event.type === 'directory.changed') {
            await Promise.all([
              refreshPublicData(),
              queryClient.invalidateQueries({ queryKey: ['oddweb', 'admin'] }),
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
        if (reconnectTimer) clearTimeout(reconnectTimer)
        socket?.close(1000, 'Page hidden')
      } else if (!socket || socket.readyState === WebSocket.CLOSED) {
        connect()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    connect()
    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      document.removeEventListener('visibilitychange', handleVisibility)
      socket?.close(1000, 'Page closed')
    }
  }, [queryClient, router])

  return null
}
