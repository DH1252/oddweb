import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import {
  FieldLabel,
  PageShell,
  SiteFooter,
  SiteHeader,
  fieldClass,
  primaryButtonClass,
} from '../components/oddweb'
import { getAdminSession, loginAdmin } from '../server/auth'

import type { FormEvent } from 'react'

type LoginSearch = {
  redirect?: string
}

export const Route = createFileRoute('/admin_/login')({
  validateSearch: (search): LoginSearch => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: async ({ search }) => {
    const session = await getAdminSession()
    if (session.authenticated) {
      throw redirect({ href: safeRedirect(search.redirect) || '/admin' })
    }
    return { configured: session.configured }
  },
  head: () => ({
    meta: [
      { title: 'Admin login / Oddweb' },
      {
        name: 'description',
        content: 'Sign in to the Oddweb operations desk.',
      },
    ],
  }),
  component: AdminLoginPage,
})

function AdminLoginPage() {
  const { redirect: redirectTo = '/admin' } = Route.useSearch()
  const { configured } = Route.useRouteContext()
  const [error, setError] = useState('')
  const loginMutation = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      loginAdmin({ data: credentials }),
  })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      await loginMutation.mutateAsync({
        username: String(form.get('username') || ''),
        password: String(form.get('password') || ''),
      })
      window.location.assign(redirectTo)
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : 'Invalid username or password.',
      )
    }
  }

  return (
    <PageShell patterned>
      <SiteHeader directoryLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-6 mb-8 grid place-items-center"
      >
        <section className="w-full max-w-md border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]">
          <div className="mb-3 border border-ink bg-rust px-4 py-3 text-white">
            <p className="mb-1 font-mono text-xs font-bold tracking-[0.08em] uppercase">
              Restricted drawer
            </p>
            <h1 className="m-0 font-mono text-3xl leading-none font-bold tracking-[-0.04em]">
              Admin login
            </h1>
            <p className="mt-2 mb-0 text-sm">
              Sign in to review submissions and maintain D1 records.
            </p>
          </div>

          {!configured ? (
            <p
              className="mb-3 border border-danger bg-red-50 p-2 font-mono text-xs text-danger"
              role="alert"
            >
              Admin authentication is not configured. Set ADMIN_USERNAME,
              ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET before signing in.
            </p>
          ) : null}

          <form onSubmit={submit} className="grid gap-3">
            <div>
              <FieldLabel htmlFor="admin-username">Username</FieldLabel>
              <input
                id="admin-username"
                name="username"
                type="text"
                autoComplete="username"
                required
                maxLength={100}
                className={fieldClass}
                disabled={!configured || loginMutation.isPending}
              />
            </div>
            <div>
              <FieldLabel htmlFor="admin-password">Password</FieldLabel>
              <input
                id="admin-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={500}
                className={fieldClass}
                disabled={!configured || loginMutation.isPending}
              />
            </div>
            {error ? (
              <p
                className="m-0 border border-danger bg-red-50 p-2 font-mono text-xs text-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={!configured || loginMutation.isPending}
            >
              {loginMutation.isPending
                ? 'Checking credentials...'
                : 'Open operations desk'}
            </button>
          </form>
        </section>
      </main>
      <SiteFooter />
    </PageShell>
  )
}

function safeRedirect(value: unknown) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//')
    ? value
    : undefined
}
