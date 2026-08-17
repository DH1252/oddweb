import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { serveThumbnail } from '../server/thumbnail-delivery'

export const Route = createFileRoute('/thumbnails/$key')({
  server: {
    handlers: {
      GET: async ({ params, request }) =>
        serveThumbnail(request, params.key, env),
      HEAD: async ({ params, request }) =>
        serveThumbnail(request, params.key, env),
    },
  },
})
