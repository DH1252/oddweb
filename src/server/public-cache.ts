const publicCacheSeconds = 30

type PublicCache = Pick<Cache, 'match' | 'put'>

export async function cachedPublicRead<T>(input: {
  cache: PublicCache
  request: Request
  name: string
  payload?: unknown
  read: () => Promise<T>
}): Promise<T> {
  const key = publicCacheKey(input.request, input.name, input.payload)
  const cached = await input.cache.match(key)
  if (cached) return (await cached.json()) as T

  const value = await input.read()
  await input.cache.put(
    key,
    Response.json(value, {
      headers: {
        'Cache-Control': `public, max-age=${publicCacheSeconds}, stale-while-revalidate=60`,
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
