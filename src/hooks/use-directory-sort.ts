import { useState, useSyncExternalStore } from 'react'

import {
  directorySortStorageKey,
  normalizeDirectorySort,
  persistDirectorySort,
  readBrowserDirectorySortPreference,
} from '../lib/directory-sort'

import type {
  DirectorySortMode,
  DirectorySortPreference,
} from '../lib/directory-sort'

export type { DirectorySortMode } from '../lib/directory-sort'

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
  getServerSnapshot: () => DirectorySortSnapshot
  setSort: (sort: DirectorySortMode) => DirectorySortSnapshot
  subscribe: (onStoreChange: () => void) => () => void
}

function normalizeSort(storedSort: string | null): DirectorySortMode {
  return normalizeDirectorySort(storedSort) ?? 'popular'
}

export function createDirectorySortStore(
  persistence: DirectorySortPersistence,
  initialSort: DirectorySortMode = 'popular',
): DirectorySortStore {
  const serverSnapshot: DirectorySortSnapshot = Object.freeze({
    sort: initialSort,
    revision: 0,
  })
  let snapshot = serverSnapshot
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
    getServerSnapshot: () => serverSnapshot,
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

function browserSortPersistence(preference: DirectorySortPreference) {
  let currentSort = preference.sort
  let pendingSort: DirectorySortMode | undefined
  return {
    read: () => {
      if (pendingSort) return pendingSort
      currentSort = readBrowserDirectorySortPreference().sort
      return currentSort
    },
    write: (sort: DirectorySortMode) => {
      currentSort = sort
      pendingSort = sort
      persistDirectorySort(sort)
      const persisted = readBrowserDirectorySortPreference()
      if (persisted.status === 'valid' && persisted.sort === sort) {
        pendingSort = undefined
      }
    },
    subscribe: (onStoredSortChange: () => void) => {
      const initialSort = readBrowserDirectorySortPreference().sort
      currentSort = initialSort
      persistDirectorySort(initialSort)
      const handleStorage = (event: StorageEvent) => {
        if (event.key === directorySortStorageKey || event.key === null) {
          pendingSort = undefined
          currentSort = normalizeDirectorySort(event.newValue) ?? currentSort
          onStoredSortChange()
        }
      }
      window.addEventListener('storage', handleStorage)
      return () => window.removeEventListener('storage', handleStorage)
    },
  }
}

export function useDirectorySortPreference(
  preference: DirectorySortPreference,
) {
  const [store] = useState(() =>
    createDirectorySortStore(
      browserSortPersistence(preference),
      preference.sort,
    ),
  )
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  return { setSort: store.setSort, snapshot }
}

export function resolveDirectoryPage(
  pageState: DirectoryPageState,
  sortSnapshot: DirectorySortSnapshot,
) {
  return pageState.sortRevision === sortSnapshot.revision ? pageState.page : 0
}
