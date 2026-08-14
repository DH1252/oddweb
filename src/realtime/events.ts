export type RealtimeEvent =
  | { type: 'directory.changed' }
  | { type: 'guestbook.changed' }
  | { type: 'site.viewed'; slug: string; views: number }

export function parseRealtimeEvent(value: unknown): RealtimeEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (
    event.type === 'directory.changed' ||
    event.type === 'guestbook.changed'
  ) {
    return { type: event.type }
  }
  if (
    event.type === 'site.viewed' &&
    typeof event.slug === 'string' &&
    event.slug.length > 0 &&
    event.slug.length <= 100 &&
    typeof event.views === 'number' &&
    Number.isSafeInteger(event.views) &&
    event.views >= 0
  ) {
    return { type: event.type, slug: event.slug, views: event.views }
  }
  return null
}
