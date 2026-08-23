import { useRef, useState } from 'react'

type AdminMutationOptions<TData, TVariables> = {
  mutationFn: (variables: TVariables) => Promise<TData>
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
  onLatestSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
}

export type AdminMutationState<TError, TVariables> = {
  error: TError | null
  latestRequestId: number
  pendingCount: number
  variables: TVariables
}

export type AdminMutationStateEvent<TError, TVariables> =
  | { type: 'started'; requestId: number; variables: TVariables }
  | { type: 'succeeded'; requestId: number }
  | { type: 'failed'; requestId: number; error: TError }

export function reduceAdminMutationState<TError, TVariables>(
  state: AdminMutationState<TError, TVariables>,
  event: AdminMutationStateEvent<TError, TVariables>,
): AdminMutationState<TError, TVariables> {
  if (event.type === 'started') {
    return {
      error: null,
      latestRequestId: event.requestId,
      pendingCount: state.pendingCount + 1,
      variables: event.variables,
    }
  }

  const pendingCount = Math.max(0, state.pendingCount - 1)
  if (event.requestId !== state.latestRequestId) {
    return { ...state, pendingCount }
  }
  return {
    ...state,
    error: event.type === 'failed' ? event.error : null,
    pendingCount,
  }
}

export async function executeAdminMutation<TData>({
  mutation,
  onSuccess,
  onLatestSuccess,
  isLatest,
  onError,
  onSuccessState,
}: {
  mutation: () => Promise<TData>
  onSuccess: (data: TData) => void | Promise<void>
  onLatestSuccess?: (data: TData) => void | Promise<void>
  isLatest: () => boolean
  onError: (cause: unknown) => void
  onSuccessState: () => void
}) {
  try {
    const data = await mutation()
    await onSuccess(data)
    if (isLatest()) await onLatestSuccess?.(data)
    onSuccessState()
    return data
  } catch (cause) {
    onError(cause)
    throw cause
  }
}

export function useAdminMutation<TData, TError = Error, TVariables = void>({
  mutationFn,
  onSuccess,
  onLatestSuccess,
}: AdminMutationOptions<TData, TVariables>) {
  const latestRequestIdRef = useRef(0)
  const [state, setState] = useState<AdminMutationState<TError, TVariables>>({
    error: null,
    latestRequestId: 0,
    pendingCount: 0,
    variables: undefined as TVariables,
  })

  function mutateAsync(nextVariables: TVariables): Promise<TData> {
    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId
    setState((current) =>
      reduceAdminMutationState(current, {
        type: 'started',
        requestId,
        variables: nextVariables,
      }),
    )
    return executeAdminMutation({
      mutation: () => mutationFn(nextVariables),
      onSuccess: async (data) => onSuccess?.(data, nextVariables),
      onLatestSuccess: async (data) => onLatestSuccess?.(data, nextVariables),
      isLatest: () => latestRequestIdRef.current === requestId,
      onSuccessState: () =>
        setState((current) =>
          reduceAdminMutationState(current, {
            type: 'succeeded',
            requestId,
          }),
        ),
      onError: (cause) =>
        setState((current) =>
          reduceAdminMutationState(current, {
            type: 'failed',
            requestId,
            error: cause as TError,
          }),
        ),
    })
  }

  return {
    error: state.error,
    isPending: state.pendingCount > 0,
    mutateAsync,
    variables: state.variables,
  }
}
