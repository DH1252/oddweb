import { Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'

import { buttonClass } from '../../components/oddweb'
import { getPublicSurprise } from '../../server/public-data'

export function DirectoryToolbar({
  query,
  include,
  exclude,
  onOpenSubmission,
  setNotice,
  setNoticeError,
}: {
  query: string
  include: string[]
  exclude: string[]
  onOpenSubmission: () => void
  setNotice: (notice: string) => void
  setNoticeError: (isError: boolean) => void
}) {
  const navigate = useNavigate({ from: '/' })
  const pendingRef = useRef(false)
  const [isPending, setIsPending] = useState(false)

  async function handleSurprise() {
    if (isPending || pendingRef.current) return
    pendingRef.current = true
    setIsPending(true)
    setNotice('')
    setNoticeError(false)

    let site: Awaited<ReturnType<typeof getPublicSurprise>>
    try {
      site = await getPublicSurprise({ data: { query, include, exclude } })
    } catch {
      pendingRef.current = false
      setIsPending(false)
      setNotice('Could not find a surprise site. Please try again.')
      setNoticeError(true)
      return
    }

    pendingRef.current = false
    setIsPending(false)
    if (!site) {
      setNotice('No matching sites are available to surprise you.')
      setNoticeError(true)
      return
    }
    navigate({ to: '/sites/$slug', params: { slug: site.slug } })
  }

  return (
    <div className="mb-2.5 flex min-h-12 flex-wrap items-center justify-end gap-1.5 border border-dotted border-brown bg-canvas p-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Link
          to="/tags"
          search={{
            include: include.length ? include : undefined,
            exclude: exclude.length ? exclude : undefined,
          }}
          className={buttonClass}
          data-od-id="browse-tags"
        >
          Tag List
        </Link>
        <button
          type="button"
          className={buttonClass}
          onClick={onOpenSubmission}
          data-od-id="submit-button"
        >
          Submit a Site
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={handleSurprise}
          disabled={isPending}
          aria-busy={isPending}
          data-od-id="shuffle-button"
        >
          {isPending ? 'Finding a site...' : 'Surprise Me'}
        </button>
      </div>
    </div>
  )
}
