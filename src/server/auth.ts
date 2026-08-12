import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const loginInput = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(500),
})

export const getAdminSession = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { readAdminSession } = await import('./auth.server')
    return readAdminSession()
  },
)

export const loginAdmin = createServerFn({ method: 'POST' })
  .validator((data) =>
    loginInput.parse(
      data instanceof FormData
        ? {
            username: data.get('username'),
            password: data.get('password'),
          }
        : data,
    ),
  )
  .handler(async ({ data }) => {
    const { authenticateAdmin } = await import('./auth.server')
    return authenticateAdmin(data)
  })

export const logoutAdmin = createServerFn({ method: 'POST' }).handler(
  async () => {
    const { destroyAdminSession } = await import('./auth.server')
    return destroyAdminSession()
  },
)

export const adminAuthMiddleware = createMiddleware({
  type: 'function',
}).server(async ({ next }) => {
  const { requireAdmin } = await import('./auth.server')
  const admin = await requireAdmin()
  return next({ context: { admin } })
})
