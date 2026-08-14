import { env } from 'cloudflare:workers'

import type { RealtimeEvent } from '../realtime/events'

export async function publishRealtimeEvent(event: RealtimeEvent) {
  try {
    await env.REALTIME_HUB.getByName('public').publish(event)
  } catch (error) {
    console.error({
      event: 'realtime_publish_failed',
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
