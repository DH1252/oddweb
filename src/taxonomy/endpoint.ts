const blockedHostSuffixes = [
  '.localhost',
  '.local',
  '.internal',
  '.home',
  '.lan',
]

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null
  }
  const octets = parts.map(Number)
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

export interface EndpointValidationOptions {
  allowedHosts?: readonly string[]
}

export function validateProviderEndpoint(
  value: string,
  options: EndpointValidationOptions = {},
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Provider endpoint must be an absolute URL')
  }
  if (url.protocol !== 'https:')
    throw new TypeError('Provider endpoint must use HTTPS')
  if (url.username || url.password)
    throw new TypeError('Provider endpoint cannot contain credentials')
  if (url.search || url.hash)
    throw new TypeError(
      'Provider endpoint cannot contain query or fragment data',
    )
  if (url.port && url.port !== '443')
    throw new TypeError('Provider endpoint must use port 443')

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const ipv4 = parseIpv4(hostname)
  if (
    hostname === 'localhost' ||
    blockedHostSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    (ipv4 && isPrivateIpv4(ipv4)) ||
    hostname.includes(':')
  ) {
    throw new TypeError('Provider endpoint cannot target a private network')
  }
  if (
    options.allowedHosts &&
    !options.allowedHosts.some((host) => host.toLowerCase() === hostname)
  ) {
    throw new TypeError('Provider endpoint host is not allowed')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url
}

export function providerUrl(endpoint: URL, route: string): URL {
  const basePath = endpoint.pathname.replace(/\/+$/, '')
  const safeRoute = route.replace(/^\/+/, '')
  const url = new URL(endpoint.href)
  url.pathname = `${basePath}/${safeRoute}`.replace(/\/{2,}/g, '/')
  return url
}
