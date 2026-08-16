import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

import {
  createDirectorySite,
  submitSite,
  updateDirectorySite,
} from './server/data'
import { createReleaseWriteBarrierMiddleware } from './server/release-barrier'
import { createUploadRequestSizeMiddleware } from './server/upload-request'

const releaseWriteBarrierMiddleware = createReleaseWriteBarrierMiddleware()
const uploadRequestSizeMiddleware = createUploadRequestSizeMiddleware(
  new Set([submitSite.url, createDirectorySite.url, updateDirectorySite.url]),
)
const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === 'serverFn',
})

export const startInstance = createStart(() => ({
  requestMiddleware: [
    uploadRequestSizeMiddleware,
    releaseWriteBarrierMiddleware,
    csrfMiddleware,
  ],
}))
