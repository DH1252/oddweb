import { env, waitUntil } from 'cloudflare:workers'

import { resolveIndexNowKey, submitIndexNowUrls } from '../lib/indexnow'
import { absoluteUrl, isProduction, siteDetailPath } from '../lib/seo'

export function triggerIndexNowSiteSync(
  slugs: string[] | string | undefined | null,
) {
  if (!slugs) return
  const list = Array.isArray(slugs) ? slugs : [slugs]
  const validSlugs = list.filter(Boolean)
  if (!validSlugs.length) return

  const key = resolveIndexNowKey(Reflect.get(env, 'INDEXNOW_KEY'))
  const urls = [
    absoluteUrl('/'),
    ...validSlugs.map((slug) => absoluteUrl(siteDetailPath(slug))),
  ]
  const uniqueUrls = Array.from(new Set(urls))

  if (!isProduction) {
    console.info({ event: 'indexnow_skipped_non_production', urls: uniqueUrls })
    return
  }

  waitUntil(
    submitIndexNowUrls({
      key,
      urls: uniqueUrls,
    })
      .then((success) => {
        if (!success) {
          console.warn({
            event: 'indexnow_submission_unsuccessful',
            urls: uniqueUrls,
          })
        }
      })
      .catch((error: unknown) => {
        console.error({
          event: 'indexnow_submission_error',
          error: error instanceof Error ? error.message : String(error),
        })
      }),
  )
}
