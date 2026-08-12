export type ThumbnailUpload = {
  key: string
  url: string
}

export function thumbnailUrl(key: string) {
  return `/thumbnails/${encodeURIComponent(key)}`
}
