const publicCacheSeconds = 60
const publicStaleWhileRevalidateSeconds = 120

type PublicCache = Pick<Cache, 'match' | 'put'>

export async function cachedPublicRead<T>(input: {
  cache: PublicCache
  request: Request
  name: string
  payload?: unknown
  ttlSeconds?: number
  read: () => Promise<T>
}): Promise<T> {
  const key = publicCacheKey(input.request, input.name, input.payload)
  const cached = await input.cache.match(key)
  if (cached) return await cached.json()

  const value = await input.read()
  await input.cache.put(
    key,
    Response.json(value, {
      headers: {
        'Cache-Control': `public, max-age=${input.ttlSeconds ?? publicCacheSeconds}, stale-while-revalidate=${publicStaleWhileRevalidateSeconds}`,
      },
    }),
  )
  return value
}

export function publicCacheKey(
  request: Request,
  name: string,
  payload?: unknown,
) {
  const key = new URL(
    `/__edge-cache/public/${encodeURIComponent(name)}`,
    request.url,
  )
  if (payload !== undefined)
    key.searchParams.set('data', JSON.stringify(payload))
  return new Request(key)
}
