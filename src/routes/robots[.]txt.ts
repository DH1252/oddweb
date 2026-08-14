import { createFileRoute } from '@tanstack/react-router'

import { robotsText } from '../lib/seo'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async () =>
        new Response(robotsText(), {
          headers: {
            'Cache-Control': 'public, max-age=3600',
            'Content-Type': 'text/plain; charset=utf-8',
          },
        }),
    },
  },
})
