import type { reconcileThumbnailStorage } from '../server/data'

export type ReviewStatus = 'pending' | 'approved' | 'rejected'
export type EntryStatus = 'active' | 'archived'
export type ScanResult = Awaited<ReturnType<typeof reconcileThumbnailStorage>>
