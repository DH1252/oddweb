import { createFileRoute } from '@tanstack/react-router'

import { readPublicSitemapBatch } from '../db/public-repository'
import { buildSitemapXml } from '../lib/seo'

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        const sites = []
        let afterId = 0
        for (;;) {
          const batch = await readPublicSitemapBatch({ afterId, limit: 1000 })
          sites.push(...batch)
          if (batch.length < 1000) break
          afterId = batch[batch.length - 1].id
        }
        return new Response(buildSitemapXml(sites), {
          headers: {
            'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
            'Content-Type': 'application/xml; charset=utf-8',
          },
        })
      },
    },
  },
})
