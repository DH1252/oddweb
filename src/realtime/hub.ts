import { DurableObject } from 'cloudflare:workers'

import { parseRealtimeEvent } from './events'

import type { RealtimeEvent } from './events'

export class RealtimeHub extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required.', { status: 426 })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({ connectedAt: Date.now() })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  publish(event: RealtimeEvent) {
    const validEvent = parseRealtimeEvent(event)
    if (!validEvent) throw new TypeError('Invalid realtime event.')
    const message = JSON.stringify(validEvent)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message)
      } catch {
        try {
          socket.close(1011, 'Delivery failed')
        } catch {
          // The socket may already be closed.
        }
      }
    }
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string' && message === 'ping') socket.send('pong')
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) {
    const attachment = socket.deserializeAttachment() as
      { connectedAt?: number } | undefined
    const durationMs =
      typeof attachment?.connectedAt === 'number'
        ? Date.now() - attachment.connectedAt
        : null
    const record = {
      event: 'realtime_client_disconnected',
      code,
      reason,
      wasClean,
      durationMs,
    }
    if (wasClean && code === 1000) {
      console.info(record)
    } else {
      console.warn(record)
    }
  }

  webSocketError(_socket: WebSocket, error: unknown) {
    console.warn({
      event: 'realtime_socket_error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
