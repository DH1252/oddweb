export function coarseNetworkAddress(address: string) {
  if (address === 'local') return 'local'
  if (isIpv4(address)) {
    const parts = address.split('.')
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
  }
  if (address.includes(':')) {
    const expanded = expandIpv6(address)
    return `${expanded.slice(0, 4).join(':')}::/64`
  }
  return 'unknown'
}

export function isPublicIdentityId(value: string) {
  return /^[A-Za-z0-9_-]{22}$/.test(value)
}

function isIpv4(value: string) {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function expandIpv6(value: string) {
  const [left, right, ...rest] = value.split('::')
  if (rest.length) return Array.from({ length: 8 }, () => '0')
  const leftParts = left ? left.split(':') : []
  const rightParts = right ? right.split(':') : []
  const missing = Math.max(0, 8 - leftParts.length - rightParts.length)
  return [
    ...leftParts,
    ...Array.from({ length: missing }, () => '0'),
    ...rightParts,
  ].map((part) => part.padStart(4, '0').toLowerCase())
}

export const blockedUserAgentPatterns = [
  /^(curl|wget|python-requests|python-urllib|httpie|postman|insomnia|scrapy|go-http-client|apache-httpclient|okhttp|libwww-perl|aiohttp|undici|node-fetch)/i,
]

export function isLegitimateUserAgent(userAgent?: string | null): boolean {
  if (!userAgent) return false
  const trimmed = userAgent.trim()
  if (trimmed.length < 5) return false
  for (const pattern of blockedUserAgentPatterns) {
    if (pattern.test(trimmed)) return false
  }
  return true
}

export function assertLegitimateClient(request: Request) {
  const userAgent = request.headers.get('user-agent')
  if (!isLegitimateUserAgent(userAgent)) {
    throw new Error('Automated request blocked.')
  }
}
