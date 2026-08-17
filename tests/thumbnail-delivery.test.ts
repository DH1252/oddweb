import assert from 'node:assert/strict'
import test from 'node:test'

import {
  thumbnailSrcSet,
  thumbnailUrl,
  thumbnailVariant,
} from '../src/lib/thumbnails'
import { serveThumbnail } from '../src/server/thumbnail-delivery'

const thumbnailKey = '01234567-89ab-4cde-8fab-0123456789ab.jpg'

test('thumbnail variants use bounded responsive URLs', () => {
  assert.equal(
    thumbnailUrl(thumbnailKey, { width: 512, format: 'avif' }),
    `/thumbnails/${thumbnailKey}?width=512&format=avif`,
  )
  assert.match(
    thumbnailSrcSet(thumbnailKey, 'webp'),
    /width=64&format=webp 64w[\s\S]*width=1600&format=webp 1600w/,
  )
  assert.deepEqual(
    thumbnailVariant(
      new URL(
        `https://oddweb.page/thumbnails/${thumbnailKey}?width=512&format=avif`,
      ),
    ),
    { width: 512, format: 'avif' },
  )
  assert.equal(
    thumbnailVariant(
      new URL(
        `https://oddweb.page/thumbnails/${thumbnailKey}?width=999&format=avif`,
      ),
    ),
    null,
  )
})

test('thumbnail delivery transforms a valid immutable variant', async () => {
  const transforms: Array<Record<string, unknown>> = []
  const outputs: Array<Record<string, unknown>> = []
  const response = await serveThumbnail(
    new Request(
      `https://oddweb.page/thumbnails/${thumbnailKey}?width=256&format=webp`,
    ),
    thumbnailKey,
    {
      THUMBNAILS: {
        get: async () => thumbnailObject(),
        head: async () => thumbnailObject(),
      },
      IMAGES: {
        input: () => ({
          transform: (transform: Record<string, unknown>) => {
            transforms.push(transform)
            return {
              output: async (output: Record<string, unknown>) => {
                outputs.push(output)
                return {
                  response: () =>
                    new Response('optimized', {
                      headers: { 'content-type': 'image/webp' },
                    }),
                }
              },
            }
          },
        }),
      } as unknown as ImagesBinding,
    },
  )

  assert.equal(await response.text(), 'optimized')
  assert.deepEqual(transforms, [{ width: 256, fit: 'scale-down' }])
  assert.deepEqual(outputs, [{ format: 'image/webp', quality: 75 }])
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  )
})

test('thumbnail delivery rejects invalid variants and preserves original validators', async () => {
  const object = thumbnailObject()
  const env = {
    THUMBNAILS: {
      get: async () => object,
      head: async () => object,
    },
    IMAGES: { input: () => undefined },
  } as unknown as { THUMBNAILS: R2Bucket; IMAGES: ImagesBinding }

  const invalid = await serveThumbnail(
    new Request(
      `https://oddweb.page/thumbnails/${thumbnailKey}?width=999&format=webp`,
    ),
    thumbnailKey,
    env,
  )
  assert.equal(invalid.status, 400)

  const notModified = await serveThumbnail(
    new Request(`https://oddweb.page/thumbnails/${thumbnailKey}`, {
      headers: { 'if-none-match': 'etag' },
    }),
    thumbnailKey,
    env,
  )
  assert.equal(notModified.status, 304)
})

function thumbnailObject() {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('original'))
        controller.close()
      },
    }),
    httpEtag: 'etag',
    writeHttpMetadata(headers: Headers) {
      headers.set('content-type', 'image/jpeg')
      headers.set('content-disposition', 'inline')
    },
  } as unknown as R2ObjectBody
}
