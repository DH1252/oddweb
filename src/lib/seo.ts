import type { SiteEntry } from '../data/sites'

export const FALLBACK_SITE_ORIGIN = 'https://oddweb.page'
export const SITE_NAME = 'Oddweb'
export const DEFAULT_DESCRIPTION =
  'A collection of unusual, playful, and interactive websites worth exploring.'
export const DEFAULT_SOCIAL_IMAGE_PATH = '/oddweb-social.png'
export const SITE_ORIGIN = resolveSiteOrigin(
  typeof process === 'undefined' ? undefined : process.env.PUBLIC_SITE_URL,
)
export const DEFAULT_SOCIAL_IMAGE = `${SITE_ORIGIN}${DEFAULT_SOCIAL_IMAGE_PATH}`
export const BRAND_IMAGE = `${SITE_ORIGIN}/oddweb-mark.svg`
export const canonicalOrigin = SITE_ORIGIN
const runtimeEnvironment =
  typeof process === 'undefined'
    ? undefined
    : (process.env as Record<string, string | undefined>).ENVIRONMENT
export const isProduction =
  (runtimeEnvironment || 'production') === 'production'
export const publicRobots = isProduction
  ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
  : 'noindex, nofollow'
export const filteredRobots = 'noindex, follow'

type SeoOptions = {
  title: string
  description: string
  path?: string
  image?: string
  imageAlt?: string
  type?: 'website' | 'article'
  noindex?: boolean
  jsonLd?: JsonLdValue
}

export type JsonLdPrimitive = string | number | boolean | null
export type JsonLdValue =
  JsonLdPrimitive | JsonLdValue[] | { [key: string]: JsonLdValue | undefined }

export function resolveSiteOrigin(value?: string) {
  if (!value) return FALLBACK_SITE_ORIGIN
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return FALLBACK_SITE_ORIGIN
    return url.origin
  } catch {
    return FALLBACK_SITE_ORIGIN
  }
}

export function absoluteUrl(path = '/', origin = SITE_ORIGIN) {
  const safeOrigin = resolveSiteOrigin(origin)
  const url = new URL(path.replace(/^\/+/, ''), `${safeOrigin}/`)
  return url.href
}

export function canonicalUrl(pathname = '/') {
  const input = new URL(pathname, `${SITE_ORIGIN}/`)
  return absoluteUrl(input.pathname.replace(/\/+$/, '') || '/')
}

export function siteDetailPath(slug: string) {
  return `/sites/${encodeURIComponent(slug)}`
}

export function siteDetailUrl(slug: string) {
  return absoluteUrl(siteDetailPath(slug))
}

export function siteSocialImage(site: SiteEntry) {
  return site.thumbnailKey
    ? absoluteUrl(`/thumbnails/${encodeURIComponent(site.thumbnailKey)}`)
    : DEFAULT_SOCIAL_IMAGE
}

export function socialMeta({
  title,
  description,
  url,
  image = DEFAULT_SOCIAL_IMAGE,
  imageAlt = "Oddweb, an index of the web's odd corners",
  type = 'website',
}: {
  title: string
  description: string
  url: string
  image?: string
  imageAlt?: string
  type?: 'website' | 'article'
}) {
  return [
    { property: 'og:site_name', content: SITE_NAME },
    { property: 'og:type', content: type },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:url', content: url },
    { property: 'og:image', content: image },
    ...(image === DEFAULT_SOCIAL_IMAGE
      ? [
          { property: 'og:image:width', content: '1200' },
          { property: 'og:image:height', content: '630' },
        ]
      : []),
    { property: 'og:image:alt', content: imageAlt },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: image },
    { name: 'twitter:image:alt', content: imageAlt },
  ]
}

export function seoHead({
  title,
  description,
  path = '/',
  image = DEFAULT_SOCIAL_IMAGE,
  type = 'website',
  noindex = false,
  jsonLd: structuredData,
}: SeoOptions) {
  const url = absoluteUrl(path)
  return {
    links: [{ rel: 'canonical', href: url }],
    meta: [
      { title },
      { name: 'description', content: description },
      { name: 'robots', content: noindex ? filteredRobots : publicRobots },
      ...socialMeta({ title, description, url, image, type }),
      ...(structuredData ? [{ 'script:ld+json': structuredData }] : []),
    ],
  }
}

export const websiteStructuredData: JsonLdValue = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE_ORIGIN}/#website`,
  url: `${SITE_ORIGIN}/`,
  name: SITE_NAME,
  alternateName: 'Oddweb Directory',
  description: DEFAULT_DESCRIPTION,
  publisher: {
    '@type': 'Organization',
    '@id': `${SITE_ORIGIN}/#organization`,
    name: SITE_NAME,
    url: `${SITE_ORIGIN}/`,
    logo: {
      '@type': 'ImageObject',
      url: BRAND_IMAGE,
      width: 630,
      height: 630,
    },
  },
}

export function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function robotsText(origin = SITE_ORIGIN) {
  if (!isProduction) return 'User-agent: *\nDisallow: /\n'
  return `User-agent: *
Allow: /
Disallow: /admin
Disallow: /health

Sitemap: ${new URL('/sitemap.xml', origin)}
`
}

export function sitemapXml(paths: string[], origin = SITE_ORIGIN) {
  const urls = paths.map((path) => new URL(path, origin).toString())
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join('\n')}
</urlset>
`
}

export function jsonLd(value: object) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}

export function noindexMeta(follow = false) {
  return {
    name: 'robots',
    content: `noindex, ${follow ? 'follow' : 'nofollow'}`,
  } as const
}

export const notFoundHeaders = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

export function buildSitemapXml(
  sites: Array<Pick<SiteEntry, 'slug' | 'added'> & { id?: number }>,
  origin = SITE_ORIGIN,
) {
  const entries: { loc: string; lastmod?: string }[] = [
    { loc: absoluteUrl('/', origin) },
    { loc: absoluteUrl('/tags', origin) },
    ...sites.map((site) => ({
      loc: absoluteUrl(siteDetailPath(site.slug), origin),
      lastmod: site.added,
    })),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    ({ loc, lastmod }) =>
      `  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`
}
