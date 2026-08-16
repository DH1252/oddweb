import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export async function readQueueDeliveryState(
  queueName,
  env = process.env,
  request = fetch,
) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const token = env.CLOUDFLARE_API_TOKEN
  if (!accountId || !token) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to verify queue delivery state.',
    )
  }
  if (!queueName) throw new Error('A queue name is required.')

  const listUrl = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues`,
  )
  listUrl.searchParams.set('name', queueName)
  const headers = { Authorization: `Bearer ${token}` }
  const listed = await cloudflareJson(request, listUrl, headers)
  const matches = (listed.result ?? []).filter(
    (queue) => queue?.queue_name === queueName && queue.queue_id,
  )
  if (matches.length !== 1) {
    throw new Error(`Could not uniquely resolve queue ${queueName}.`)
  }

  const queue = await cloudflareJson(
    request,
    new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(matches[0].queue_id)}`,
    ),
    headers,
  )
  const paused = queue.result?.settings?.delivery_paused
  const modifiedOn = queue.result?.modified_on
  if (typeof paused === 'boolean' && typeof modifiedOn === 'string') {
    return { state: paused ? 'paused' : 'running', modifiedOn }
  }

  const declaredState = env.RELEASE_TAXONOMY_QUEUE_INITIAL_STATE
  if (!['running', 'paused'].includes(declaredState)) {
    throw new Error(
      `Queue ${queueName} did not expose delivery_paused and modified_on state. Set RELEASE_TAXONOMY_QUEUE_INITIAL_STATE to running or paused after verifying the production queue state.`,
    )
  }
  return { state: declaredState, modifiedOn: null, source: 'operator' }
}

async function cloudflareJson(request, url, headers) {
  const response = await request(url, { headers, redirect: 'error' })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) {
    throw new Error(
      `Cloudflare queue state request failed with HTTP ${response.status}.`,
    )
  }
  return body
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.stdout.write(
    `${JSON.stringify(await readQueueDeliveryState(process.argv[2], process.env))}\n`,
  )
}
