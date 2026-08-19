import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'

import {
  dispatchTaxonomyOutbox,
  processTaxonomyMessage,
  runTaxonomyMaintenance,
} from './taxonomy/processor'
import { runWithReleaseInvocation } from './server/release-barrier.server'
import { publishRealtimeEvent } from './server/realtime'
import { cleanupPublicAttempts } from './db/public-attempts'

export { RealtimeHub } from './realtime/hub'

const fetchHandler = createServerEntry({
  fetch(request) {
    return handler.fetch(request)
  },
})

export default {
  fetch: fetchHandler.fetch,
  async queue(batch: MessageBatch<unknown>) {
    const invocation = await runWithReleaseInvocation(
      'queue',
      async () => {
        for (const message of batch.messages) {
          try {
            if (
              typeof message.body !== 'object' ||
              message.body === null ||
              !('jobId' in message.body) ||
              typeof message.body.jobId !== 'string' ||
              !message.body.jobId.trim()
            ) {
              throw new TypeError('Taxonomy queue message requires a jobId')
            }

            const result = await processTaxonomyMessage(message.body.jobId)
            await dispatchTaxonomyOutbox({ limit: 25 })
            await publishRealtimeEvent({ type: 'taxonomy.changed' })
            if (result.mutations > 0) {
              await publishRealtimeEvent({ type: 'directory.changed' })
            }
            message.ack()
          } catch (error) {
            console.error({
              event: 'taxonomy_queue_message_failed',
              messageId: message.id,
              error: error instanceof Error ? error.message : String(error),
            })
            message.retry()
          }
        }
      },
      { database: env.DB },
    )
    if (!invocation.admitted) {
      for (const message of batch.messages) message.retry()
    }
  },
  async scheduled() {
    try {
      await cleanupPublicAttempts(env.DB)
    } catch (error) {
      console.error({
        event: 'public_attempts_cleanup_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const invocation = await runWithReleaseInvocation(
      'scheduled',
      runTaxonomyMaintenance,
      { database: env.DB },
    )
    if (
      invocation.admitted &&
      Object.values(invocation.value).some((value) => value > 0)
    ) {
      await publishRealtimeEvent({ type: 'taxonomy.changed' })
    }
  },
}
