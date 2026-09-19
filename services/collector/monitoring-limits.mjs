// Operational safety margin below GOAL's documented 25-subscription ceiling.
// Keep every admission path on the same limit so a busy session never reaches
// the provider ceiling merely because fixtures were added from different UI flows.
export const MAX_CONCURRENT_LIVE_FIXTURES = 20;
