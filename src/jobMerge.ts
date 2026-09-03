export type JobDetailState = {
  detailsLoaded?: boolean
  detailsLoading?: boolean
  detailsError?: string
}

export type MergeableJob = JobDetailState & {
  id: string
  financeItems: unknown[]
  payments: unknown[]
  modelPhotoAttachments?: unknown[]
}

export function canUseJobDetails(job?: JobDetailState | null) {
  return Boolean(job?.detailsLoaded) && !job?.detailsLoading && !job?.detailsError
}

export function mergeJobListRows<Job extends MergeableJob, Row extends { id: string }>(
  currentJobs: Job[],
  incomingRows: Row[],
  rowToJob: (row: Row) => Job,
  dirtyIds: ReadonlySet<string>,
) {
  const currentById = new Map(currentJobs.map((job) => [job.id, job]))

  return incomingRows.map((row) => {
    const incomingJob = rowToJob(row)
    const currentJob = currentById.get(incomingJob.id)

    if (!currentJob) {
      return {
        ...incomingJob,
        detailsLoaded: Boolean(incomingJob.detailsLoaded),
        detailsLoading: false,
        detailsError: '',
      }
    }

    if (dirtyIds.has(incomingJob.id)) return currentJob

    if (!currentJob.detailsLoaded) {
      return {
        ...currentJob,
        ...incomingJob,
        detailsLoaded: Boolean(incomingJob.detailsLoaded),
        detailsLoading: currentJob.detailsLoading || incomingJob.detailsLoading || false,
        detailsError: currentJob.detailsError || incomingJob.detailsError || '',
      }
    }

    if (incomingJob.detailsLoaded) {
      return {
        ...currentJob,
        ...incomingJob,
        detailsLoaded: true,
        detailsLoading: false,
        detailsError: '',
      }
    }

    return {
      ...currentJob,
      ...incomingJob,
      financeItems: currentJob.financeItems,
      payments: currentJob.payments,
      modelPhotoAttachments: currentJob.modelPhotoAttachments,
      detailsLoaded: true,
      detailsLoading: currentJob.detailsLoading || false,
      detailsError: currentJob.detailsError || '',
    }
  })
}
