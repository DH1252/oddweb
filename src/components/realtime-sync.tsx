import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { parseRealtimeEvent } from '../realtime/events'

export function RealtimeSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let attempts = 0

    const refreshPublicData = () =>
      queryClient.invalidateQueries({ queryKey: ['oddweb', 'public'] })

    const connect = () => {
      if (stopped || document.visibilityState === 'hidden') return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/api/realtime`)
      socket.addEventListener('open', () => {
        attempts = 0
        void refreshPublicData()
      })
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string' || message.data === 'pong') return
        try {
          const event = parseRealtimeEvent(JSON.parse(message.data))
          if (!event) return
          if (event.type === 'directory.changed') {
            void refreshPublicData()
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'admin'],
            })
          } else if (event.type === 'guestbook.changed') {
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'public', 'support'],
            })
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'admin', 'guestbook'],
            })
          } else {
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'public', 'directory'],
            })
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'public', 'popular'],
            })
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'public', 'site', event.slug],
            })
            void queryClient.invalidateQueries({
              queryKey: ['oddweb', 'admin'],
            })
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
  }, [queryClient])

  return null
}
