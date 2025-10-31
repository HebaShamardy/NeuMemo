// Centralized configuration for tuning performance and cost profiles
// Adjust these values when moving to a different price tier or policy

export const config = {
  // Background tab capture/injection
  injection: {
    concurrency: 8,                 // parallel tabs to capture at once
    reloadWaitTimeoutMs: 20000,     // wait for reloaded tab to be fully ready
    injectTimeoutMs: 10000,         // executeScript timeout
    contentFetchTimeoutMs: 10000,   // message roundtrip timeout
    preventAutoDiscard: true        // temporarily set autoDiscardable=false during capture
  },

  // Lite pre-summarization (saves tokens before full grouping)
  liteSummary: {
    batchSize: 5,        // tabs per request
    concurrency: 10,     // concurrent requests to the lite model
    rpm: 15,             // requests per minute rate cap
    perTabMaxTokens: 1000
  },

  // Full summarization and grouping
  summarize: {
    maxTokens: 200000    // overall prompt token cap for summarizeTabs
  },

  // Search / retrieval settings
  search: {
    batchSize: 10,
    concurrency: 4,
    perTabMaxTokens: 200
  }
};
