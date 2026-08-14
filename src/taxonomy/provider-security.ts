import type { ProviderConfig } from './runtime-types'

const providerHosts: Readonly<
  Record<ProviderConfig['providerKind'], readonly string[]>
> = {
  openai_compatible: ['api.openai.com'],
  gemini: ['generativelanguage.googleapis.com'],
}

export function allowedProviderHosts(
  kind: ProviderConfig['providerKind'],
): readonly string[] {
  return providerHosts[kind]
}

export function providerHostAllowed(config: ProviderConfig): boolean {
  const hostname = new URL(config.endpoint).hostname.toLowerCase()
  return allowedProviderHosts(config.providerKind).includes(hostname)
}
