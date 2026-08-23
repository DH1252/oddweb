type JobSnapshot = {
  page: number
  total: number
  items: Array<Record<string, unknown>>
}

export function jobSnapshotIdentity(
  jobs: JobSnapshot,
  status: string | null,
  kind: string | null,
) {
  return [
    jobs.page,
    jobs.total,
    status ?? '',
    kind ?? '',
    ...jobs.items.map(
      (job) =>
        `${String(job.id)}:${String(job.status)}:${String(job.updatedAt)}`,
    ),
  ].join('|')
}
