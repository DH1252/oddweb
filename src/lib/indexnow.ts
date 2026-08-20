export const INDEXNOW_DEFAULT_KEY = '4f9d2a6e8b1c4e7a9f3b5d2c8a1e6f4b'

export function resolveIndexNowKey(configuredKey?: unknown): string {
  if (
    typeof configuredKey === 'string' &&
    /^[0-9a-zA-Z-]{8,128}$/.test(configuredKey.trim())
  ) {
    return configuredKey.trim()
  }
  return INDEXNOW_DEFAULT_KEY
}

export type IndexNowPayload = {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

export function formatIndexNowPayload({
  host = 'oddweb.page',
  key = INDEXNOW_DEFAULT_KEY,
  urlList,
}: {
  host?: string
  key?: string
  urlList: string[]
}): IndexNowPayload {
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList,
  }
}

export async function submitIndexNowUrls({
  host = 'oddweb.page',
  key = INDEXNOW_DEFAULT_KEY,
  urls,
  fetchFn = fetch,
}: {
  host?: string
  key?: string
  urls: string[]
  fetchFn?: typeof fetch
}): Promise<boolean> {
  if (!urls.length) return false
  const payload = formatIndexNowPayload({ host, key, urlList: urls })
  try {
    const response = await fetchFn('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    })
    return response.ok || response.status === 202
  } catch {
    return false
  }
}
