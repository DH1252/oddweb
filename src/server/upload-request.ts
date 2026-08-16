import { createMiddleware } from '@tanstack/react-start'

export const maxUploadRequestBytes = 9 * 1024 * 1024

type UploadRequestGuardInput<TResult> = {
  request: Request
  pathname: string
  handlerType: 'serverFn' | 'router'
  uploadPaths: ReadonlySet<string>
  next: () => TResult
}

export function enforceUploadRequestSize<TResult>({
  request,
  pathname,
  handlerType,
  uploadPaths,
  next,
}: UploadRequestGuardInput<TResult>): TResult | Response {
  if (
    handlerType !== 'serverFn' ||
    ![...uploadPaths].some((path) => isServerFunctionPath(pathname, path))
  ) {
    return next()
  }

  const contentLength = request.headers.get('content-length')
  if (contentLength === null || request.headers.has('transfer-encoding')) {
    return uploadErrorResponse(
      411,
      'A valid Content-Length header is required for uploads.',
    )
  }
  if (!/^\d+$/.test(contentLength)) {
    return uploadErrorResponse(400, 'Invalid Content-Length header.')
  }

  const bytes = Number(contentLength)
  if (!Number.isSafeInteger(bytes)) {
    return uploadErrorResponse(400, 'Invalid Content-Length header.')
  }
  if (bytes === 0) {
    return uploadErrorResponse(400, 'Upload request body is required.')
  }
  if (request.body === null) {
    return uploadErrorResponse(400, 'Upload request body is required.')
  }
  if (bytes > maxUploadRequestBytes) {
    return uploadErrorResponse(413, 'Upload request is too large.')
  }

  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (mediaType !== 'multipart/form-data') {
    return uploadErrorResponse(
      415,
      'Upload requests must use multipart/form-data.',
    )
  }

  return next()
}

function isServerFunctionPath(pathname: string, functionPath: string) {
  return pathname === functionPath || pathname.startsWith(`${functionPath}/`)
}

export function createUploadRequestSizeMiddleware(
  uploadPaths: ReadonlySet<string>,
) {
  const paths = new Set(uploadPaths)
  return createMiddleware().server(({ request, pathname, handlerType, next }) =>
    enforceUploadRequestSize({
      request,
      pathname,
      handlerType,
      uploadPaths: paths,
      next,
    }),
  )
}

function uploadErrorResponse(status: number, message: string) {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}
