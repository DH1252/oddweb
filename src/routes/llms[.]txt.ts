import { createFileRoute } from '@tanstack/react-router'

import { llmsText } from '../lib/seo'

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: async () =>
        new Response(llmsText(), {
          headers: {
            'Cache-Control': 'public, max-age=3600',
            'Content-Type': 'text/plain; charset=utf-8',
          },
        }),
    },
  },
})
