import { useEffect, useEffectEvent, useRef, useState } from 'react'

import { ensureTurnstileScript } from './turnstile-client'
import type { TurnstileAction } from '../lib/turnstile'

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
  const [errorKey, setErrorKey] = useState<number | null>(null)
  const handleToken = useEffectEvent(onToken)
  const handleError = useEffectEvent(() => {
    setErrorKey(resetKey)
    handleToken(null)
  })
  const error = errorKey === resetKey

  useEffect(() => {
    if (!sitekey) return
    return ensureTurnstileScript(sitekey, () => setReady(true))
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
        setErrorKey(null)
        handleToken(token)
      },
      'error-callback': handleError,
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
