import { useEffect, useEffectEvent, useRef, useState } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string
          action: string
          callback: (token: string) => void
          'error-callback': () => void
          'expired-callback': () => void
          'timeout-callback': () => void
        },
      ) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

type TurnstileProps = {
  sitekey: string
  action: string
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
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const handleToken = useEffectEvent(onToken)

  useEffect(() => {
    if (!sitekey) return
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-oddweb-turnstile]',
    )
    const script =
      existing ??
      Object.assign(document.createElement('script'), {
        src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        async: true,
        defer: true,
        dataset: { oddwebTurnstile: 'true' },
      })
    const onLoad = () => setReady(true)
    script.addEventListener('load', onLoad)
    if (!existing) document.head.appendChild(script)
    if (window.turnstile) setReady(true)
    return () => script.removeEventListener('load', onLoad)
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
  }, [action, handleToken, ready, sitekey])

  useEffect(() => {
    if (!widgetIdRef.current || !window.turnstile) return
    window.turnstile.reset(widgetIdRef.current)
    handleToken(null)
  }, [handleToken, resetKey])

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
