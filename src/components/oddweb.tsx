import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { thumbnailUrl } from '../lib/thumbnails'

import type { ReactNode } from 'react'
import type { SiteEntry } from '../data/sites'

export const buttonClass =
  'inline-flex min-h-11 cursor-pointer items-center justify-center border border-ink bg-paper px-3 text-sm font-bold text-ink no-underline shadow-[2px_2px_0_#d9aa7a] transition-[background-color,color,transform] hover:bg-warm active:translate-x-px active:translate-y-px active:shadow-none disabled:cursor-not-allowed disabled:opacity-45'

export const primaryButtonClass = `${buttonClass} bg-rust text-white hover:bg-[#9f3516]`

export function SiteHeader({
  directoryLink = false,
}: {
  directoryLink?: boolean
}) {
  return (
    <header className="bg-ink text-paper" data-od-id="site-header">
      <nav
        className="odd-shell flex min-h-12 items-center justify-between gap-3"
        aria-label="Main navigation"
      >
        <Link
          to="/"
          className="inline-flex min-h-11 items-center gap-1.5 font-mono text-lg font-bold no-underline"
          data-od-id="brand-link"
        >
          <span
            className="grid size-5 place-items-center border border-line bg-paper text-xs text-ink"
            aria-hidden="true"
          >
            !
          </span>
          <span>ODDWEB</span>
        </Link>
        <div className="flex items-center gap-1 font-mono text-xs text-ink">
          {directoryLink ? (
            <Link
              to="/"
              className="inline-flex min-h-11 items-center border border-line bg-paper px-2 no-underline hover:bg-brown hover:text-paper"
              data-od-id="directory-link"
            >
              &larr; Directory
            </Link>
          ) : (
            <Link
              to="/admin"
              className="inline-flex min-h-11 items-center border border-line bg-paper px-2 no-underline hover:bg-brown hover:text-paper"
              data-od-id="admin-link"
            >
              Admin
            </Link>
          )}
        </div>
      </nav>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer
      className="odd-shell mb-4 border border-ink bg-paper p-2 font-mono text-xs tracking-wide"
      data-od-id="site-footer"
    >
      ODDWEB / AN INDEX OF THE WEB'S ODD CORNERS
    </footer>
  )
}

export function PageShell({
  children,
  patterned = false,
}: {
  children: ReactNode
  patterned?: boolean
}) {
  return (
    <div className={patterned ? 'odd-grid-bg min-h-screen' : 'min-h-screen'}>
      <a
        href="#main-content"
        className="fixed top-2 left-2 z-50 -translate-y-20 border-2 border-ink bg-paper px-3 py-2 font-mono font-bold text-ink focus:translate-y-0"
      >
        Skip to main content
      </a>
      {children}
    </div>
  )
}

export function Panel({
  title,
  label,
  children,
  className = '',
  id,
}: {
  title: string
  label?: string
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section className={`min-w-0 border border-ink bg-paper ${className}`}>
      <div className="flex min-h-11 items-center justify-between gap-2 bg-brown px-2.5 py-1.5 text-paper">
        <h2
          id={id}
          className="m-0 font-mono text-sm font-bold tracking-[0.08em] uppercase"
        >
          {title}
        </h2>
        {label ? (
          <span className="font-mono text-xs text-warm">{label}</span>
        ) : null}
      </div>
      <div className="p-2.5">{children}</div>
    </section>
  )
}

export function SiteThumbnail({
  site,
  compact = false,
  thumbnailKey = site.thumbnailKey,
}: {
  site: SiteEntry
  compact?: boolean
  thumbnailKey?: string
}) {
  return (
    <ItemThumbnail
      thumbnailKey={thumbnailKey}
      alt={site.thumbnailAlt || `Thumbnail for ${site.name}`}
      label={site.name}
      className={compact ? 'aspect-4/3 w-16' : 'h-[78px] w-full'}
      fallbackClassName={site.accent}
    />
  )
}

export function ItemThumbnail({
  thumbnailKey,
  alt,
  label,
  className = 'aspect-4/3 w-full',
  fallbackClassName = 'from-[#63396d] to-[#d27a3e]',
}: {
  thumbnailKey?: string
  alt: string
  label: string
  className?: string
  fallbackClassName?: string
}) {
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => setImageFailed(false), [thumbnailKey])

  const labelSizeClass =
    label.length > 36
      ? 'text-[9px] leading-tight tracking-normal'
      : label.length > 24
        ? 'text-[10px] leading-tight tracking-normal'
        : label.length > 16
          ? 'text-[11px] leading-tight tracking-wide'
          : 'text-xs leading-tight tracking-widest'

  return (
    <div
      className={`relative grid shrink-0 place-items-center overflow-hidden border border-ink bg-linear-to-br ${fallbackClassName} ${className}`}
    >
      {thumbnailKey && !imageFailed ? (
        <img
          src={thumbnailUrl(thumbnailKey)}
          alt={alt}
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <>
          <div className="absolute inset-0 opacity-25 odd-crosshatch" />
          <span
            className={`relative mx-1 max-w-[calc(100%_-_0.5rem)] -rotate-2 border border-white/70 bg-ink/70 px-1.5 py-1 text-center font-mono font-bold whitespace-normal text-white [overflow-wrap:anywhere] ${labelSizeClass}`}
          >
            {label}
          </span>
        </>
      )}
    </div>
  )
}

export function ModalDialog({
  children,
  onClose,
  closeDisabled = false,
  labelledBy,
}: {
  children: ReactNode
  onClose: () => void
  closeDisabled?: boolean
  labelledBy: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    dialog.showModal()
    const initialFocus = dialog.querySelector<HTMLElement>(
      '[data-dialog-initial-focus], input:not([type="hidden"]), textarea, select, button',
    )
    initialFocus?.focus()

    return () => {
      if (dialog.open) dialog.close()
      restoreFocusRef.current?.focus()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      className="m-auto h-full max-h-none w-full max-w-none place-items-center overflow-y-auto border-0 bg-transparent p-3 text-ink open:grid backdrop:bg-ink/55"
      onCancel={(event) => {
        event.preventDefault()
        if (!closeDisabled) onClose()
      }}
      onClick={(event) => {
        if (closeDisabled || event.target !== event.currentTarget) return
        onClose()
      }}
    >
      {children}
    </dialog>
  )
}

export function RoutePending() {
  return (
    <RouteState eyebrow="Opening drawer" title="Finding that file...">
      The filing cabinet is catching up.
    </RouteState>
  )
}

export function RouteError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  return (
    <RouteState
      eyebrow="Drawer jammed"
      title="This page could not be opened."
      action={
        <button type="button" className={primaryButtonClass} onClick={reset}>
          Try again
        </button>
      }
    >
      {import.meta.env.DEV
        ? error.message || 'An unexpected runtime error interrupted this page.'
        : 'An unexpected runtime error interrupted this page.'}
    </RouteState>
  )
}

export function RouteNotFound() {
  return (
    <RouteState
      eyebrow="File not found"
      title="That drawer is empty."
      action={
        <Link to="/" className={primaryButtonClass}>
          Return to directory
        </Link>
      }
    >
      The requested Oddweb record does not exist.
    </RouteState>
  )
}

function RouteState({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <PageShell patterned>
      <SiteHeader directoryLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="odd-shell my-6 border-2 border-ink bg-paper p-3 shadow-[6px_6px_0_#2a1810]"
      >
        <div className="border border-ink bg-rust px-5 py-6 text-white">
          <p className="mb-1 font-mono text-xs font-bold tracking-widest uppercase">
            {eyebrow}
          </p>
          <h1 className="m-0 font-mono text-[clamp(28px,6vw,46px)] leading-none font-bold tracking-[-0.04em]">
            {title}
          </h1>
        </div>
        <div className="border-x border-b border-ink bg-canvas p-5">
          <p className="mt-0 text-brown">{children}</p>
          {action}
        </div>
      </main>
      <SiteFooter />
    </PageShell>
  )
}

export function FieldLabel({
  children,
  htmlFor,
}: {
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block font-mono text-xs font-bold tracking-[0.06em] uppercase"
    >
      {children}
    </label>
  )
}

export const fieldClass =
  'min-h-11 w-full border border-brown bg-paper px-2 py-1.5 text-[15px] text-ink shadow-[inset_1px_1px_0_#d9aa7a] placeholder:text-muted focus:border-rust'
