const trackingParameters = new Set([
  'dclid',
  'fbclid',
  'gclid',
  'gbraid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'ref',
  'vero_conv',
  'vero_id',
  'wbraid',
])

export function normalizeWebsiteUrl(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Website address must use HTTP or HTTPS.')
  }
  if (!url.hostname) throw new Error('Website address must include a host.')

  url.hash = ''
  url.username = ''
  url.password = ''
  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith('utm_') ||
      trackingParameters.has(key.toLowerCase())
    ) {
      url.searchParams.delete(key)
    }
  }
  url.searchParams.sort()
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  return url.toString()
}

export function websiteUrlKey(value: string) {
  const url = new URL(normalizeWebsiteUrl(value))
  return url.host.replace(/^www\./i, '').toLowerCase()
}
