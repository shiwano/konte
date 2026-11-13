// Below this the index lies over the page instead of beside it.
const NARROW = "(max-width: 48rem)";

export const isNarrow = (): boolean => window.matchMedia(NARROW).matches;
