import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

import { RouteError, RouteNotFound, RoutePending } from '../components/oddweb'
import { RealtimeSync } from '../components/realtime-sync'
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
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
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
      'Cache-Control': 'no-cache, no-store, must-revalidate',
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
        { rel: 'preconnect', href: 'https://challenges.cloudflare.com' },
        { rel: 'dns-prefetch', href: 'https://challenges.cloudflare.com' },
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        {
          rel: 'icon',
          href: '/favicon-48x48.png',
          type: 'image/png',
          sizes: '48x48',
        },
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
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
        <RealtimeSync />
        {children}
        <Suspense>{DevelopmentDevtools && <DevelopmentDevtools />}</Suspense>
        <Scripts />
      </body>
    </html>
  )
}
