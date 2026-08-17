import { useEffect, useState } from 'react'

type LocalTimeStyle = 'date' | 'dateTime'

export function LocalTime({
  seconds,
  fallback,
  style = 'date',
}: {
  seconds: number | undefined
  fallback: string
  style?: LocalTimeStyle
}) {
  const [label, setLabel] = useState(fallback)
  const valid = Number.isFinite(seconds)

  useEffect(() => {
    if (!valid || seconds === undefined) return
    setLabel(
      new Intl.DateTimeFormat(undefined, {
        ...(style === 'date'
          ? { month: 'short', day: 'numeric' }
          : { dateStyle: 'medium', timeStyle: 'short' }),
      }).format(new Date(seconds * 1_000)),
    )
  }, [seconds, style, valid])

  if (!valid || seconds === undefined) return fallback
  return <time dateTime={new Date(seconds * 1_000).toISOString()}>{label}</time>
}
