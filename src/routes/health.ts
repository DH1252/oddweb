import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: async () => {
        const checks = { d1: false, r2: false }
        try {
          checks.d1 = Boolean(await env.DB.prepare('SELECT 1 AS ok').first())
          await env.THUMBNAILS.list({ limit: 1 })
          checks.r2 = true
        } catch (error) {
          console.error({
            event: 'health_check_failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
        const healthy = checks.d1 && checks.r2
        return Response.json(
          {
            status: healthy ? 'ok' : 'error',
            checks,
            environment: process.env.ENVIRONMENT,
            release: process.env.RELEASE_SHA,
            releasedAt: process.env.RELEASE_TIME,
          },
          {
            status: healthy ? 200 : 503,
            headers: {
              'Cache-Control': 'no-store',
              'X-Robots-Tag': 'noindex',
            },
          },
        )
      },
    },
  },
})
