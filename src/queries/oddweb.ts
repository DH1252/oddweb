import { queryOptions } from '@tanstack/react-query'

import { getAdminData, getDirectoryData } from '../server/data'

export const directoryQueryOptions = () =>
  queryOptions({
    queryKey: ['oddweb', 'directory'],
    queryFn: () => getDirectoryData(),
    staleTime: 30_000,
  })

export const adminQueryOptions = () =>
  queryOptions({
    queryKey: ['oddweb', 'admin'],
    queryFn: () => getAdminData(),
    staleTime: 10_000,
  })
