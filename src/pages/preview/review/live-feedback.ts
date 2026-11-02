/** What a view hides of the saved comments: those deleted this session, and stale ones when asked. */
export interface LiveFeedbackFilter {
  deletedFeedbackIds: ReadonlySet<string>;
  hideStale: boolean;
}

export function liveFeedback<T extends { id: string; stale: boolean }>(
  list: readonly T[],
  filter: LiveFeedbackFilter,
): T[] {
  return list.filter((f) => !filter.deletedFeedbackIds.has(f.id) && !(filter.hideStale && f.stale));
}
