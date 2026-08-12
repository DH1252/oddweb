import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

const objectNamePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/

export const Route = createFileRoute('/thumbnails/$key')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!objectNamePattern.test(params.key)) {
          return new Response('Thumbnail not found.', { status: 404 })
        }

        const object = await env.THUMBNAILS.get(`thumbnails/${params.key}`)
        if (!object) {
          return new Response('Thumbnail not found.', { status: 404 })
        }

        if (request.headers.get('if-none-match') === object.httpEtag) {
          return new Response(null, {
            status: 304,
            headers: thumbnailHeaders(object),
          })
        }

        return new Response(object.body, {
          headers: thumbnailHeaders(object),
        })
      },
      HEAD: async ({ params }) => {
        if (!objectNamePattern.test(params.key)) {
          return new Response(null, { status: 404 })
        }

        const object = await env.THUMBNAILS.head(`thumbnails/${params.key}`)
        if (!object) {
          return new Response(null, { status: 404 })
        }

        return new Response(null, { headers: thumbnailHeaders(object) })
      },
    },
  },
})

function thumbnailHeaders(object: R2Object) {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  headers.set('x-content-type-options', 'nosniff')
  return headers
}
