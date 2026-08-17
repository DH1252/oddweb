import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router'

import { adminOverviewQueryOptions } from '../queries/oddweb'
import { getAdminSession } from '../server/auth'

export const Route = createFileRoute('/admin')({
  shouldReload: false,
  beforeLoad: async ({ location }) => {
    const session = await getAdminSession()
    if (!session.authenticated) {
      throw redirect({
        to: '/admin/login',
        search: { redirect: location.href },
      })
    }
    return { admin: session }
  },
  head: () => ({
    meta: [
      { title: 'Oddweb Admin' },
      { name: 'description', content: 'Oddweb directory administration.' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(adminOverviewQueryOptions()),
  component: lazyRouteComponent(() => import('../components/admin-page')),
})
