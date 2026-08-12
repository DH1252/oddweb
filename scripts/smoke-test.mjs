import { execFileSync } from 'node:child_process'

const staging = process.argv.includes('--staging')
const baseUrl =
  process.env[staging ? 'STAGING_URL' : 'PRODUCTION_URL'] ??
  (staging ? '' : 'https://oddweb.oddweb.workers.dev')
const expectedRelease = process.env.RELEASE_SHA

if (
  !baseUrl ||
  !URL.canParse(baseUrl) ||
  new URL(baseUrl).protocol !== 'https:'
) {
  throw new Error(
    `${staging ? 'STAGING_URL' : 'PRODUCTION_URL'} must be an HTTPS URL.`,
  )
}

await retry(async () => {
  const health = await fetch(new URL('/health', baseUrl), {
    headers: { Accept: 'application/json' },
  })
  if (!health.ok) throw new Error(`/health returned ${health.status}`)
  const marker = await health.json()
  if (marker.status !== 'ok') throw new Error('/health did not report ok')
  if (!marker.checks?.d1 || !marker.checks?.r2) {
    throw new Error('/health did not confirm D1 and R2 bindings')
  }
  if (expectedRelease && marker.release !== expectedRelease) {
    throw new Error(
      `expected release ${expectedRelease}, received ${marker.release}`,
    )
  }

  const home = await fetch(baseUrl, { headers: { Accept: 'text/html' } })
  if (!home.ok) throw new Error(`/ returned ${home.status}`)
  const body = await home.text()
  if (!body.includes('Oddweb'))
    throw new Error('/ did not contain the application marker')

  const missing = await fetch(new URL('/sites/not-a-real-site', baseUrl), {
    redirect: 'manual',
  })
  if (missing.status !== 404) throw new Error('unknown site did not return 404')

  const admin = await fetch(new URL('/admin', baseUrl), { redirect: 'manual' })
  if (admin.status !== 307 && admin.status !== 302) {
    throw new Error(`anonymous /admin returned ${admin.status}`)
  }
  const location = admin.headers.get('location') || ''
  if (!location.includes('/admin/login')) {
    throw new Error('anonymous /admin did not redirect to login')
  }
})

console.log(`Smoke test passed for ${baseUrl}.`)

async function retry(check) {
  let lastError
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      if (attempt < 6)
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
    }
  }
  throw lastError
}
