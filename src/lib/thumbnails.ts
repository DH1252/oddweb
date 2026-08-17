export type ThumbnailUpload = {
  key: string
  url: string
}

export const thumbnailWidths = [64, 128, 256, 512, 1024, 1600] as const

export type ThumbnailFormat = 'avif' | 'webp' | 'jpeg'

export type ThumbnailVariant = {
  width: (typeof thumbnailWidths)[number]
  format: ThumbnailFormat
}

export function thumbnailUrl(key: string, variant?: ThumbnailVariant) {
  const path = `/thumbnails/${encodeURIComponent(key)}`
  if (!variant) return path
  const search = new URLSearchParams({
    width: String(variant.width),
    format: variant.format,
  })
  return `${path}?${search}`
}

export function thumbnailSrcSet(key: string, format: ThumbnailFormat) {
  return thumbnailWidths
    .map((width) => `${thumbnailUrl(key, { width, format })} ${width}w`)
    .join(', ')
}

export function thumbnailVariant(url: URL): ThumbnailVariant | null {
  const width = url.searchParams.get('width')
  const format = url.searchParams.get('format')
  if (width === null && format === null) return null
  if (width === null || format === null) return null

  const parsedWidth = Number(width)
  if (!thumbnailWidths.includes(parsedWidth as ThumbnailVariant['width'])) {
    return null
  }
  if (format !== 'avif' && format !== 'webp' && format !== 'jpeg') {
    return null
  }
  return { width: parsedWidth as ThumbnailVariant['width'], format }
}
