import { useEffect, useEffectEvent, useRef, useState } from 'react'

import { turnstileActions } from '../lib/turnstile'
import type { TurnstileAction } from '../lib/turnstile'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string
          action: string
          size?: 'normal' | 'compact' | 'flexible'
          execution?: 'render' | 'execute'
          appearance?: 'always' | 'execute' | 'interaction-only'
          callback: (token: string) => void
          'error-callback'?: () => void
          'expired-callback'?: () => void
          'timeout-callback'?: () => void
        },
      ) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
      execute?: (widgetId?: string) => void
    }
  }
}

export function ensureTurnstileScript(
  sitekey: string,
  onReady?: () => void,
): void {
  if (typeof window === 'undefined' || !sitekey) return
  if (window.turnstile) {
    onReady?.()
    return
  }
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-oddweb-turnstile]',
  )
  const script = existing ?? document.createElement('script')
  if (!existing) {
    script.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.setAttribute('data-oddweb-turnstile', 'true')
    document.head.appendChild(script)
  }
  if (onReady) {
    script.addEventListener('load', onReady, { once: true })
  }
}

export function requestInvisibleTurnstileToken(
  sitekey: string,
  action: TurnstileAction = turnstileActions.vote,
): Promise<string | null> {
  if (typeof window === 'undefined' || !sitekey) return Promise.resolve(null)

  return new Promise((resolve) => {
    ensureTurnstileScript(sitekey, () => {
      if (!window.turnstile) {
        resolve(null)
        return
      }

      const container = document.createElement('div')
      container.style.position = 'fixed'
      container.style.top = '-9999px'
      container.style.left = '-9999px'
      container.style.opacity = '0'
      container.style.pointerEvents = 'none'
      document.body.appendChild(container)

      let widgetId: string | undefined
      let resolved = false

      const cleanup = () => {
        if (widgetId && window.turnstile) {
          try {
            window.turnstile.remove(widgetId)
          } catch {}
        }
        if (container.parentNode) {
          container.parentNode.removeChild(container)
        }
      }

      const finish = (token: string | null) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        cleanup()
        resolve(token)
      }

      const timer = setTimeout(() => {
        finish(null)
      }, 8000)

      try {
        widgetId = window.turnstile.render(container, {
          sitekey,
          action,
          appearance: 'interaction-only',
          callback: (token) => finish(token),
          'error-callback': () => finish(null),
          'expired-callback': () => finish(null),
          'timeout-callback': () => finish(null),
        })
      } catch {
        finish(null)
      }
    })
  })
}

type TurnstileProps = {
  sitekey: string
  action: TurnstileAction | (string & {})
  disabled?: boolean
  resetKey?: number
  requestPending?: boolean
  onToken: (token: string | null) => void
}

export function Turnstile({
  sitekey,
  action,
  disabled = false,
  resetKey = 0,
  requestPending = false,
  onToken,
}: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | undefined>(undefined)
  const previousResetKeyRef = useRef(resetKey)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const handleToken = useEffectEvent(onToken)

  useEffect(() => {
    if (!sitekey) return
    ensureTurnstileScript(sitekey, () => setReady(true))
  }, [sitekey])

  useEffect(() => {
    if (
      !ready ||
      !window.turnstile ||
      !containerRef.current ||
      widgetIdRef.current
    )
      return
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey,
      action,
      callback: (token) => {
        setError(false)
        handleToken(token)
      },
      'error-callback': () => {
        setError(true)
        handleToken(null)
      },
      'expired-callback': () => handleToken(null),
      'timeout-callback': () => handleToken(null),
    })
    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = undefined
    }
  }, [action, ready, sitekey])

  useEffect(() => {
    if (previousResetKeyRef.current === resetKey) return
    previousResetKeyRef.current = resetKey
    if (!widgetIdRef.current || !window.turnstile) return
    setError(false)
    window.turnstile.reset(widgetIdRef.current)
    handleToken(null)
  }, [resetKey])

  if (!sitekey) {
    return (
      <p
        className="border border-danger bg-canvas px-2 py-1.5 font-mono text-xs text-danger"
        role="alert"
      >
        Verification is not configured for this deployment.
      </p>
    )
  }
  return (
    <div aria-busy={!ready || disabled || requestPending}>
      <div ref={containerRef} />
      {!ready ? (
        <p className="mt-1 font-mono text-xs text-muted">
          Loading verification...
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 font-mono text-xs text-danger" role="alert">
          Verification could not load. Try again.
        </p>
      ) : null}
    </div>
  )
}
