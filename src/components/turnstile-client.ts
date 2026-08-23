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

const noCleanup = () => undefined

export function ensureTurnstileScript(
  sitekey: string,
  onReady?: () => void,
): () => void {
  if (typeof window === 'undefined' || !sitekey) return noCleanup
  if (window.turnstile) {
    onReady?.()
    return noCleanup
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
  if (!onReady) return noCleanup
  script.addEventListener('load', onReady, { once: true })
  return () => script.removeEventListener('load', onReady)
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
