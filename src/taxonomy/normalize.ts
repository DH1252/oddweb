const textEncoder = new TextEncoder()

export interface TaxonomySiteInput {
  siteId: string | number
  name: string
  description: string
  tags: readonly string[]
  url?: string | null
}

export interface NormalizedTaxonomySiteInput {
  siteId: string
  name: string
  description: string
  tags: string[]
  url?: string
}

export function normalizeTaxonomyText(value: string): string {
  return [...value.normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeTaxonomyTag(value: string): string {
  return normalizeTaxonomyText(value).toLocaleLowerCase('en-US')
}

export function normalizeTaxonomySiteInput(
  input: TaxonomySiteInput,
): NormalizedTaxonomySiteInput {
  const tags = [
    ...new Set(input.tags.map(normalizeTaxonomyTag).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right, 'en-US'))

  const normalized: NormalizedTaxonomySiteInput = {
    siteId: String(input.siteId),
    name: normalizeTaxonomyText(input.name),
    description: normalizeTaxonomyText(input.description),
    tags,
  }

  if (input.url) {
    normalized.url = new URL(input.url).href
  }

  return normalized
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function hashTaxonomyInput(
  input: TaxonomySiteInput,
): Promise<string> {
  return sha256Hex(stableJson(normalizeTaxonomySiteInput(input)))
}

function jobPart(value: string | number): string {
  return encodeURIComponent(String(value))
}

export function taxonomyJobKey(input: {
  siteId: string | number
  inputHash: string
  taxonomyVersion: string | number
  classifierVersion: string | number
}): string {
  if (!/^[a-f0-9]{64}$/i.test(input.inputHash)) {
    throw new TypeError('inputHash must be a SHA-256 hex digest')
  }

  return [
    `site:${jobPart(input.siteId)}`,
    `input:${input.inputHash.toLowerCase()}`,
    `taxonomy:${jobPart(input.taxonomyVersion)}`,
    `classifier:${jobPart(input.classifierVersion)}`,
  ].join(':')
}
