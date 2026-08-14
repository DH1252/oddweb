import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/realtime')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = request.headers.get('Origin')
        if (origin && origin !== new URL(request.url).origin) {
          return new Response('Forbidden.', { status: 403 })
        }
        return env.REALTIME_HUB.getByName('public').fetch(request)
      },
    },
  },
})
