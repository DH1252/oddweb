export type RealtimeEvent =
  | { type: 'directory.changed' }
  | { type: 'guestbook.changed' }
  | { type: 'submission.changed' }
  | { type: 'taxonomy.changed' }
  | { type: 'site.viewed'; slug: string; views: number }
  | { type: 'site.voted'; slug: string; votes: number }

export function parseRealtimeEvent(value: unknown): RealtimeEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (
    event.type === 'directory.changed' ||
    event.type === 'guestbook.changed' ||
    event.type === 'submission.changed' ||
    event.type === 'taxonomy.changed'
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
  if (
    event.type === 'site.voted' &&
    typeof event.slug === 'string' &&
    event.slug.length > 0 &&
    event.slug.length <= 100 &&
    typeof event.votes === 'number' &&
    Number.isSafeInteger(event.votes) &&
    event.votes >= 0
  ) {
    return { type: event.type, slug: event.slug, votes: event.votes }
  }
  return null
}
