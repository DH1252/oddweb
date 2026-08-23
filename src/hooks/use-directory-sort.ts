import { useSyncExternalStore } from 'react'

export type DirectorySortMode =
  'popular' | 'views' | 'newest' | 'oldest' | 'tags' | 'az' | 'za'

export type DirectorySortSnapshot = Readonly<{
  sort: DirectorySortMode
  revision: number
}>

export type DirectoryPageState = {
  sortRevision: number
  page: number
}

type DirectorySortPersistence = {
  read: () => string | null
  write: (sort: DirectorySortMode) => void
  subscribe: (onStoredSortChange: () => void) => () => void
}

export type DirectorySortStore = {
  getSnapshot: () => DirectorySortSnapshot
  setSort: (sort: DirectorySortMode) => DirectorySortSnapshot
  subscribe: (onStoreChange: () => void) => () => void
}

const sortStorageKey = 'oddweb-directory-sort'
const serverSortSnapshot: DirectorySortSnapshot = Object.freeze({
  sort: 'popular',
  revision: 0,
})
const sortModes = new Set<DirectorySortMode>([
  'popular',
  'views',
  'newest',
  'oldest',
  'tags',
  'az',
  'za',
])

function normalizeSort(storedSort: string | null): DirectorySortMode {
  return sortModes.has(storedSort as DirectorySortMode)
    ? (storedSort as DirectorySortMode)
    : 'popular'
}

export function createDirectorySortStore(
  persistence: DirectorySortPersistence,
): DirectorySortStore {
  let snapshot = serverSortSnapshot
  let unsubscribeFromPersistence: (() => void) | undefined
  const listeners = new Set<() => void>()

  function refreshSnapshot() {
    const sort = normalizeSort(persistence.read())
    if (sort !== snapshot.sort) {
      snapshot = Object.freeze({ sort, revision: snapshot.revision + 1 })
    }
    return snapshot
  }

  function notifyIfChanged() {
    const previousSnapshot = snapshot
    const nextSnapshot = refreshSnapshot()
    if (nextSnapshot === previousSnapshot) return
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: refreshSnapshot,
    setSort(sort) {
      const previousSnapshot = refreshSnapshot()
      persistence.write(sort)
      const nextSnapshot = refreshSnapshot()
      if (nextSnapshot !== previousSnapshot) {
        listeners.forEach((listener) => listener())
      }
      return nextSnapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribeFromPersistence = persistence.subscribe(notifyIfChanged)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribeFromPersistence?.()
          unsubscribeFromPersistence = undefined
        }
      }
    },
  }
}

const browserSortStore = createDirectorySortStore({
  read: () => window.localStorage.getItem(sortStorageKey),
  write: (sort) => window.localStorage.setItem(sortStorageKey, sort),
  subscribe: (onStoredSortChange) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === sortStorageKey || event.key === null) {
        onStoredSortChange()
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  },
})

export function useDirectorySortSnapshot(): DirectorySortSnapshot {
  return useSyncExternalStore(
    browserSortStore.subscribe,
    browserSortStore.getSnapshot,
    () => serverSortSnapshot,
  )
}

export function resolveDirectoryPage(
  pageState: DirectoryPageState,
  sortSnapshot: DirectorySortSnapshot,
) {
  return pageState.sortRevision === sortSnapshot.revision ? pageState.page : 0
}

export function setDirectorySort(sort: DirectorySortMode) {
  return browserSortStore.setSort(sort)
}
