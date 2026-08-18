import type {
  TaxonomyCandidateKind,
  TaxonomyCandidateStatus,
} from '../db/taxonomy-admin-repository'
import type { TaxonomyMode } from './taxonomy-types'

export function canTransitionMode(
  current: TaxonomyMode,
  target: TaxonomyMode,
  readyForGradual: boolean,
  circuitState: string,
) {
  if (target === 'disabled') return current !== 'disabled'
  if (circuitState !== 'closed' || current === 'degraded') return false
  if (current === 'disabled') return target === 'shadow'
  if (current === 'shadow') return target === 'gradual' && readyForGradual
  if (current === 'gradual')
    return target === 'shadow' || target === 'autonomous'
  return target === 'shadow'
}

export function numberFromForm(data: FormData, name: string) {
  return Number(data.get(name))
}

export function removeEmptyFile(data: FormData, name: string) {
  const value = data.get(name)
  if (value === '' || (value instanceof File && value.size === 0)) {
    data.delete(name)
  }
}

export function isCreatedSite(
  value: unknown,
): value is { created: true; id: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'created' in value &&
    value.created === true &&
    'id' in value &&
    typeof value.id === 'number' &&
    Number.isInteger(value.id) &&
    value.id > 0
  )
}

export function isProviderKind(
  value: string,
): value is 'openai_compatible' | 'gemini' {
  return value === 'openai_compatible' || value === 'gemini'
}

export function isRoutingRole(
  value: string,
): value is 'primary' | 'failover' | 'consensus' {
  return value === 'primary' || value === 'failover' || value === 'consensus'
}

export function parseProviderDialect(
  value: FormDataEntryValue | null,
): 'responses' | 'chat_completions' {
  const dialect = String(value)
  if (dialect !== 'responses' && dialect !== 'chat_completions')
    throw new Error('Invalid provider dialect')
  return dialect
}

export function isCandidateDecision(
  value: string,
): value is 'accepted' | 'rejected' | 'deferred' | 'conflict' {
  return (
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'deferred' ||
    value === 'conflict'
  )
}

export function parseCandidateStatus(
  value: string,
): TaxonomyCandidateStatus | null {
  if (value === 'proposed') return value
  if (value === 'accepted') return value
  if (value === 'rejected') return value
  if (value === 'deferred') return value
  if (value === 'conflict') return value
  return null
}

export function parseCandidateKind(
  value: string,
): TaxonomyCandidateKind | null {
  if (value === 'existing_tag') return value
  if (value === 'novel_concept') return value
  if (value === 'alias') return value
  if (value === 'merge') return value
  if (value === 'parent_edge') return value
  return null
}

export function isRetryableJobStatus(status: unknown): boolean {
  return (
    status === 'pending' ||
    status === 'retry_wait' ||
    status === 'leased' ||
    status === 'dead' ||
    status === 'settled' ||
    status === 'degraded'
  )
}
