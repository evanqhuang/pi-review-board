export interface ReviewCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function startReviewCancellation(active: Set<AbortController>, externalSignal?: AbortSignal): ReviewCancellation {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  active.add(controller);

  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: (): void => {
      externalSignal?.removeEventListener("abort", forwardAbort);
      active.delete(controller);
    },
  };
}

export function cancelActiveReviews(active: Set<AbortController>): number {
  let canceled = 0;
  for (const controller of active) {
    if (controller.signal.aborted) continue;
    controller.abort();
    canceled += 1;
  }
  return canceled;
}
