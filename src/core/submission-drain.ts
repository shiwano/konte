// A daemon that is stopping sends nothing new, and lets a submit already sent commit its backend
// job id: one cut off between the two is SUBMISSION_UNCONFIRMED, its result unrecoverable.
let stopped = false;
const inFlight = new Set<Promise<unknown>>();

export function submittingStopped(): boolean {
  return stopped;
}

export function trackSubmission<T>(submission: Promise<T>): Promise<T> {
  inFlight.add(submission);
  void submission.finally(() => inFlight.delete(submission)).catch(() => {});
  return submission;
}

/** Stop new submits and wait up to `timeoutMs` for the ones in flight to commit. */
export async function drainSubmissions(timeoutMs: number): Promise<void> {
  stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
  ]);
  clearTimeout(timer);
}
