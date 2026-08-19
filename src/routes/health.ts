import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { dispatchTaxonomyOutbox } from '../taxonomy/processor'

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
      POST: async ({ request }) => {
        const probeToken =
          request.headers.get('x-release-probe') ??
          request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
        const validTokens = [
          process.env.RELEASE_SHA,
          env.RELEASE_SHA,
          env.TAXONOMY_MASTER_KEY_V1,
          env.ADMIN_SESSION_SECRET,
        ].filter((t): t is string => typeof t === 'string' && t.length > 0)

        if (!probeToken || !validTokens.includes(probeToken)) {
          return Response.json(
            { error: 'Unauthorized' },
            { status: 401, headers: { 'Cache-Control': 'no-store' } },
          )
        }

        let dispatched = 0
        try {
          dispatched = await dispatchTaxonomyOutbox({ limit: 25 })
        } catch (error) {
          console.error({
            event: 'health_probe_dispatch_failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }

        return Response.json(
          { ok: true, dispatched },
          {
            status: 200,
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
