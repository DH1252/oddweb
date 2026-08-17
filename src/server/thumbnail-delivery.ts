import { thumbnailVariant } from '../lib/thumbnails'

const objectNamePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/

type ThumbnailDeliveryEnv = {
  THUMBNAILS: Pick<R2Bucket, 'get' | 'head'>
  IMAGES: Pick<ImagesBinding, 'input'>
}

export async function serveThumbnail(
  request: Request,
  key: string,
  env: ThumbnailDeliveryEnv,
): Promise<Response> {
  if (!objectNamePattern.test(key)) {
    return new Response('Thumbnail not found.', { status: 404 })
  }

  const variant = thumbnailVariant(new URL(request.url))
  if (new URL(request.url).search && !variant) {
    return new Response('Invalid thumbnail variant.', { status: 400 })
  }

  if (request.method === 'HEAD') {
    const object = await env.THUMBNAILS.head(`thumbnails/${key}`)
    return object
      ? new Response(null, { headers: thumbnailHeaders(object) })
      : new Response(null, { status: 404 })
  }

  const object = await env.THUMBNAILS.get(`thumbnails/${key}`)
  if (!object) return new Response('Thumbnail not found.', { status: 404 })

  if (!variant) {
    if (request.headers.get('if-none-match') === object.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: thumbnailHeaders(object),
      })
    }
    return originalThumbnailResponse(object)
  }

  const [transformInput, fallbackBody] = object.body.tee()
  try {
    const transformed = await env.IMAGES.input(transformInput)
      .transform({ width: variant.width, fit: 'scale-down' })
      .output({ format: `image/${variant.format}`, quality: 75 })
    const response = transformed.response()
    if (response.ok && response.body) {
      return new Response(response.body, {
        status: response.status,
        headers: optimizedThumbnailHeaders(response),
      })
    }
  } catch (error) {
    console.warn({
      event: 'thumbnail_optimization_failed',
      key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return originalThumbnailResponse(object, fallbackBody)
}

function originalThumbnailResponse(
  object: R2ObjectBody,
  body: ReadableStream<Uint8Array> = object.body,
) {
  return new Response(body, { headers: thumbnailHeaders(object) })
}

function thumbnailHeaders(object: R2Object | R2ObjectBody) {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  headers.set('x-content-type-options', 'nosniff')
  return headers
}

function optimizedThumbnailHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.delete('etag')
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  headers.set('content-disposition', 'inline')
  headers.set('x-content-type-options', 'nosniff')
  return headers
}
