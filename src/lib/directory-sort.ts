export const directorySortModes = [
  'popular',
  'views',
  'newest',
  'oldest',
  'tags',
  'az',
  'za',
] as const

export type DirectorySortMode = (typeof directorySortModes)[number]

export type DirectorySortPreference = {
  status: 'valid' | 'missing' | 'invalid'
  sort: DirectorySortMode
}

export const directorySortStorageKey = 'oddweb-directory-sort'

const secureCookieName = '__Host-oddweb-directory-sort'
const developmentCookieName = 'oddweb-directory-sort'
const cookieMaxAge = 365 * 24 * 60 * 60
const supportedSortModes = new Set<string>(directorySortModes)

export function normalizeDirectorySort(
  value: string | null | undefined,
): DirectorySortMode | undefined {
  return value && supportedSortModes.has(value)
    ? (value as DirectorySortMode)
    : undefined
}

export function readDirectorySortCookie(
  cookieHeader: string | null | undefined,
): DirectorySortPreference {
  const cookies = new Map<string, string>()
  for (const part of cookieHeader?.split(/;\s*/) ?? []) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    cookies.set(part.slice(0, separator), part.slice(separator + 1))
  }
  for (const name of [secureCookieName, developmentCookieName]) {
    if (!cookies.has(name)) continue
    const sort = normalizeDirectorySort(cookies.get(name))
    return sort
      ? { status: 'valid', sort }
      : { status: 'invalid', sort: 'popular' }
  }
  return { status: 'missing', sort: 'popular' }
}

export function directorySortCookie(sort: DirectorySortMode, secure: boolean) {
  return `${secure ? secureCookieName : developmentCookieName}=${sort}; Path=/; Max-Age=${cookieMaxAge}; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function readLegacyDirectorySort() {
  try {
    return normalizeDirectorySort(
      window.localStorage.getItem(directorySortStorageKey),
    )
  } catch {
    return undefined
  }
}

export function persistDirectorySort(sort: DirectorySortMode) {
  const secure = window.location.protocol === 'https:'
  try {
    document.cookie = directorySortCookie(sort, secure)
  } catch {
    // The preference remains usable for this page if cookies are unavailable.
  }
  try {
    window.localStorage.setItem(directorySortStorageKey, sort)
  } catch {
    // The cookie remains the authoritative cross-visit preference.
  }
}

export function readBrowserDirectorySortPreference() {
  const cookiePreference = readDirectorySortCookie(document.cookie)
  if (cookiePreference.status !== 'missing') return cookiePreference
  const legacySort = readLegacyDirectorySort()
  if (!legacySort) return cookiePreference
  persistDirectorySort(legacySort)
  return {
    status: readDirectorySortCookie(document.cookie).status,
    sort: legacySort,
  }
}

export function directorySortMigrationScript() {
  return `try{if(location.pathname==='/'){const names=['${secureCookieName}','${developmentCookieName}'];const hasCookie=document.cookie.split(/;\\s*/).some(part=>names.some(name=>part.startsWith(name+'=')));const sort=localStorage.getItem('${directorySortStorageKey}');if(!hasCookie&&${JSON.stringify(directorySortModes)}.includes(sort)){const secure=location.protocol==='https:';const name=secure?'${secureCookieName}':'${developmentCookieName}';document.cookie=name+'='+sort+'; Path=/; Max-Age=${cookieMaxAge}; SameSite=Lax'+(secure?'; Secure':'');if(document.cookie.split(/;\\s*/).some(part=>part===name+'='+sort))location.reload()}}}catch{}`
}
