import { normalizeTaxonomyTag } from './normalize'
import type { TaxonomyMode } from './runtime-types'

export function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Limit must be a positive safe integer')
  }
  return Math.min(value, maximum)
}

export function retryDelaySeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return baseSeconds
  return Math.min(baseSeconds * 2 ** Math.min(attempt - 1, 20), maxSeconds)
}

export async function rolloutSelected(
  stableKey: string,
  basisPoints: number,
): Promise<boolean> {
  if (basisPoints <= 0) return false
  if (basisPoints >= 10_000) return true
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableKey),
  )
  const view = new DataView(digest)
  return view.getUint32(0) % 10_000 < basisPoints
}

export async function permitsMutation(
  mode: TaxonomyMode,
  stableKey: string,
  rolloutBasisPoints: number,
): Promise<boolean> {
  if (mode === 'autonomous') return true
  if (mode !== 'gradual') return false
  return rolloutSelected(stableKey, rolloutBasisPoints)
}

export function normalizeProposedSlug(value: string): string {
  const slug = normalizeTaxonomyTag(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new TypeError('Invalid taxonomy slug')
  }
  return slug
}

export function consensusValues<T>(
  groups: readonly (readonly T[])[],
  key: (value: T) => string,
  threshold: number,
): T[] {
  const counts = new Map<string, { count: number; value: T }>()
  for (const group of groups) {
    const seen = new Set<string>()
    for (const value of group) {
      const candidateKey = key(value)
      if (seen.has(candidateKey)) continue
      seen.add(candidateKey)
      const current = counts.get(candidateKey)
      counts.set(candidateKey, {
        count: (current?.count ?? 0) + 1,
        value: current?.value ?? value,
      })
    }
  }
  const values: T[] = []
  for (const { count, value } of counts.values()) {
    if (count >= threshold) values.push(value)
  }
  return values
}

export function requiredConsensus<T>(
  groups: readonly (readonly T[])[],
  key: (value: T) => string,
  requiredVoters: number,
): T[] {
  if (!Number.isSafeInteger(requiredVoters) || requiredVoters < 1) {
    throw new TypeError('Consensus requires at least one voter')
  }
  if (groups.length !== requiredVoters) return []
  return consensusValues(groups, key, requiredVoters)
}

export function graphAcceptsParent(
  edges: readonly { parentId: number; childId: number }[],
  parentId: number,
  childId: number,
  maxDepth: number,
  maxFanout: number,
): boolean {
  if (parentId === childId) return false
  const children = new Map<number, Set<number>>()
  for (const edge of edges) {
    const values = children.get(edge.parentId) ?? new Set<number>()
    values.add(edge.childId)
    children.set(edge.parentId, values)
  }
  const direct = children.get(parentId) ?? new Set<number>()
  if (!direct.has(childId) && direct.size >= maxFanout) return false
  direct.add(childId)
  children.set(parentId, direct)

  const visit = (node: number, path: Set<number>, depth: number): boolean => {
    if (depth > maxDepth || path.has(node)) return false
    const nextPath = new Set(path).add(node)
    for (const next of children.get(node) ?? []) {
      if (!visit(next, nextPath, depth + 1)) return false
    }
    return true
  }
  const nodes = new Set<number>([parentId, childId])
  for (const [parent, descendants] of children) {
    nodes.add(parent)
    for (const descendant of descendants) nodes.add(descendant)
  }
  return [...nodes].every((node) => visit(node, new Set(), 1))
}

export function parseQueueMessage(value: unknown): { jobId: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    typeof (value as { jobId?: unknown }).jobId !== 'string' ||
    !(value as { jobId: string }).jobId.trim()
  ) {
    throw new TypeError('Taxonomy queue messages must contain only jobId')
  }
  return { jobId: (value as { jobId: string }).jobId }
}
