import type { TaxonomyMode } from './taxonomy-types'
import { canTransitionMode } from './admin-parsers'

export function optionalBasisPoints(value: number | null) {
  return value === null ? 'not configured' : basisPoints(value)
}

export function microsPercent(value: number) {
  return `${(value / 10_000).toFixed(2)}%`
}

export function modeDisabledReason(
  state: {
    mode: TaxonomyMode
    circuitState: string
    activeProviderConfigId: number | null
    activePolicyConfigId: number | null
  },
  target: TaxonomyMode,
  readyForGradual: boolean,
) {
  if (state.mode === target) return 'Current mode.'
  if (target === 'disabled') return 'Disable automation.'
  if (state.circuitState !== 'closed' || state.mode === 'degraded')
    return 'Circuit must be closed; reset the circuit first.'
  if (
    state.activeProviderConfigId === null ||
    state.activePolicyConfigId === null
  )
    return 'An active provider and policy are required.'
  if (state.mode === 'disabled' && target !== 'shadow')
    return 'Shadow mode must be enabled first.'
  if (state.mode === 'shadow' && target === 'gradual' && !readyForGradual)
    return 'Shadow readiness thresholds have not been met.'
  if (state.mode === 'gradual' && target === 'autonomous')
    return 'Autonomous mode follows gradual mode.'
  if (
    canTransitionMode(state.mode, target, readyForGradual, state.circuitState)
  )
    return `Switch automation to ${modeLabel(target)} mode.`
  return `Cannot transition directly from ${modeLabel(state.mode)} to ${modeLabel(target)}.`
}

export function modeLabel(mode: TaxonomyMode) {
  return mode === 'disabled'
    ? 'Disabled'
    : mode === 'shadow'
      ? 'Shadow'
      : mode === 'gradual'
        ? 'Gradual'
        : mode === 'autonomous'
          ? 'Autonomous'
          : 'Degraded'
}

export function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase())
}

export function basisPoints(value: number) {
  return `${(value / 100).toFixed(2).replace(/\.00$/, '')}%`
}

export function formatTimestamp(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(numeric * 1_000))
}

export function commaList(value: FormDataEntryValue | null) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
