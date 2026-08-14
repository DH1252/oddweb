import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import {
  dispatchTaxonomyOutbox,
  processTaxonomyMessage,
  runTaxonomyMaintenance,
} from './taxonomy/processor'
import { publishRealtimeEvent } from './server/realtime'

export { RealtimeHub } from './realtime/hub'

const fetchHandler = createServerEntry({
  fetch(request) {
    return handler.fetch(request)
  },
})

export default {
  fetch: fetchHandler.fetch,
  async queue(batch: MessageBatch<unknown>) {
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
  async scheduled() {
    await dispatchTaxonomyOutbox()
    await runTaxonomyMaintenance()
  },
}
