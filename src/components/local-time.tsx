import { useSyncExternalStore } from 'react'

type LocalTimeStyle = 'date' | 'dateTime'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const subscribeToHydration = () => () => undefined

function formatLocalTime(date: Date, style: LocalTimeStyle) {
  return style === 'date'
    ? dateFormatter.format(date)
    : dateTimeFormatter.format(date)
}

function useEffectSafeHydration() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  )
}

export function LocalTime({
  seconds,
  fallback,
  style = 'date',
}: {
  seconds: number | undefined
  fallback: string
  style?: LocalTimeStyle
}) {
  const valid = Number.isFinite(seconds)
  const hydrated = useEffectSafeHydration()

  if (!valid || seconds === undefined) return fallback
  const date = new Date(seconds * 1_000)
  const label = hydrated ? formatLocalTime(date, style) : fallback
  return <time dateTime={date.toISOString()}>{label}</time>
}
