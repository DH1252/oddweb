import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function readWorkerTriggerState(
  workerName,
  env = process.env,
  request = fetch,
) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const token = env.CLOUDFLARE_API_TOKEN
  if (!accountId || !token) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to verify Worker triggers.',
    )
  }
  if (!workerName) throw new Error('A Worker name is required.')

  const headers = { Authorization: `Bearer ${token}` }
  const script = encodeURIComponent(workerName)
  const account = encodeURIComponent(accountId)
  const schedules = await cloudflareJson(
    request,
    new URL(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/schedules`,
    ),
    headers,
  )
  const domainsUrl = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`,
  )
  domainsUrl.searchParams.set('service', workerName)
  domainsUrl.searchParams.set('per_page', '100')
  const domains = await cloudflareJson(request, domainsUrl, headers)

  return {
    crons: (schedules.result?.schedules ?? [])
      .map((schedule) => schedule?.cron)
      .filter((cron) => typeof cron === 'string')
      .sort(),
    customDomains: (domains.result ?? [])
      .filter((domain) => domain?.service === workerName)
      .map((domain) => domain?.hostname)
      .filter((hostname) => typeof hostname === 'string')
      .sort(),
  }
}

async function cloudflareJson(request, url, headers) {
  const response = await request(url, { headers, redirect: 'error' })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) {
    throw new Error(
      `Cloudflare Worker trigger request failed with HTTP ${response.status}.`,
    )
  }
  return body
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.stdout.write(
    `${JSON.stringify(await readWorkerTriggerState(process.argv[2]))}\n`,
  )
}
