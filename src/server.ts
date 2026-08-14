import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import {
  dispatchTaxonomyOutbox,
  processTaxonomyMessage,
  runTaxonomyMaintenance,
} from './taxonomy/processor'

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

        await processTaxonomyMessage(message.body.jobId)
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
