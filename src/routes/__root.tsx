import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

import { RouteError, RouteNotFound, RoutePending } from '../components/oddweb'
import {
  DEFAULT_DESCRIPTION,
  isProduction,
  seoHead,
  websiteStructuredData,
} from '../lib/seo'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

const DevelopmentDevtools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ TanStackDevtools }, { TanStackRouterDevtoolsPanel }, query] =
        await Promise.all([
          import('@tanstack/react-devtools'),
          import('@tanstack/react-router-devtools'),
          import('../integrations/tanstack-query/devtools'),
        ])

      return {
        default: function Devtools() {
          return (
            <TanStackDevtools
              config={{ position: 'bottom-right' }}
              plugins={[
                {
                  name: 'Tanstack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                },
                query.default,
              ]}
            />
          )
        },
      }
    })
  : null

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  'upgrade-insecure-requests',
].join('; ')

export const Route = createRootRouteWithContext<MyRouterContext>()({
  headers: ({ matches }) => {
    const privateOrError = matches.some(
      (match) =>
        /^\/(?:admin|health)(?:\/|$)/.test(match.pathname) ||
        Boolean(
          match.error &&
          typeof match.error === 'object' &&
          'isNotFound' in match.error,
        ) ||
        match.status === 'error' ||
        match.status === 'notFound',
    )
    return {
      'Cache-Control': privateOrError ? 'no-store' : 'no-cache',
      'Content-Security-Policy': contentSecurityPolicy,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...(!isProduction || privateOrError
        ? { 'X-Robots-Tag': 'noindex, nofollow' }
        : undefined),
    }
  },
  head: () => {
    const defaults = seoHead({
      title: "Oddweb - The web's odd corners",
      description: DEFAULT_DESCRIPTION,
      jsonLd: websiteStructuredData,
    })
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#2a1810' },
        { name: 'color-scheme', content: 'light' },
        ...defaults.meta.filter(
          (entry) => !('name' in entry && entry.name === 'robots'),
        ),
      ],
      links: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'stylesheet', href: appCss },
      ],
    }
  },
  shellComponent: RootDocument,
  pendingComponent: RoutePending,
  errorComponent: RouteError,
  notFoundComponent: RouteNotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Suspense>{DevelopmentDevtools && <DevelopmentDevtools />}</Suspense>
        <Scripts />
      </body>
    </html>
  )
}
