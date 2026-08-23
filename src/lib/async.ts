export function mapSeries<TValue, TResult>(
  values: readonly TValue[],
  callback: (value: TValue, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  return values.reduce<Promise<TResult[]>>(
    (pendingResults, value, index) =>
      pendingResults.then(async (results) => {
        results.push(await callback(value, index))
        return results
      }),
    Promise.resolve([]),
  )
}

export function mapSettledSeries<TValue, TResult>(
  values: readonly TValue[],
  callback: (value: TValue, index: number) => Promise<TResult>,
): Promise<Array<PromiseSettledResult<TResult>>> {
  return mapSeries(values, async (value, index) => {
    try {
      return {
        status: 'fulfilled' as const,
        value: await callback(value, index),
      }
    } catch (reason) {
      return { status: 'rejected' as const, reason }
    }
  })
}
