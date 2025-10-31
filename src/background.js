import { summarizeTabs, summarizeTabsLiteBatch, searchRelevantTabs } from './firebase_ai.js';
import { config } from './config.js';

// ========== Excluded domains settings (loaded from IndexedDB) ==========
let excludedDomains = [];

const DB_NAME = "NeuMemoDB";
const DB_VERSION = 6;
const EXCLUDED_URLS_STORE = "excluded_urls";

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (event) => reject("Database error: " + event.target.error);
    request.onsuccess = (event) => resolve(event.target.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(EXCLUDED_URLS_STORE)) {
        db.createObjectStore(EXCLUDED_URLS_STORE, { keyPath: "domain" });
      }
    };
  });
}

async function loadExcludedDomains() {
  try {
    const db = await openDB();
    const domains = await new Promise((resolve, reject) => {
      const transaction = db.transaction(EXCLUDED_URLS_STORE, "readonly");
      const store = transaction.objectStore(EXCLUDED_URLS_STORE);
      const request = store.getAll();
      request.onerror = (event) => reject("Error loading rules: " + event.target.error);
      request.onsuccess = (event) => {
        const domainList = event.target.result.map(item => item.domain);
        resolve(domainList);
      };
      db.close();
    });
    excludedDomains = domains;
    console.log('🔧 Loaded excluded domains:', excludedDomains);
  } catch (e) {
    console.warn('Failed to load excluded domains:', e);
    excludedDomains = [];
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isUrlExcluded(url) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return false;
  for (const rule of excludedDomains) {
    if (hostname === rule || hostname.endsWith('.' + rule)) {
      return true;
    }
  }
  return false;
}

// Initial load
loadExcludedDomains();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COLLECT_TABS") {
    console.log("🧠 Received collect tabs request. Starting the process...");
    // Start the process but don't make the listener async.
    // The response is sent back immediately.
    collectAndSummarizeAllTabs();
    sendResponse({ status: "Collection process initiated." });
    return false;
  }
  if (message.type === "SEARCH_TABS") {
    console.log("🧠 Received search tabs request. Starting the process...");
    searchTabsLite(message.query, message.tabs).then(tabs => {
        sendResponse({ tabs: tabs });
    });
    return true; // Indicates that the response is sent asynchronously
  }
  // The TAB_CONTENT message is now handled by chrome.tabs.sendMessage,
  // which resolves a promise inside injectAndGetContent. This simplifies the logic immensely.
});

async function searchTabsLite(query, tabs) {
  try {
    const results = await searchRelevantTabs(tabs, query, 3);
    // searchRelevantTabs returns objects with {url,title,summary,score}. Viewer expects {url,title,summary}.
    return results.map(({ url, title, summary }) => ({ url, title, summary }));
  } catch (e) {
    console.error("Error during tab search:", e);
    return [];
  }
}

async function collectAndSummarizeAllTabs() {
  await loadExcludedDomains(); // Reload rules before processing
  try {
    // 1. Get all eligible tabs
    const allTabs = await chrome.tabs.query({});
    const injectableTabs = allTabs.filter(tab => {
      const url = tab.url || tab.pendingUrl || '';
      if (!(tab.id && url && /^https?:\/\//.test(url))) return false;
      // Exclude tabs whose hostname is in user's exclusion list
      return !isUrlExcluded(url);
    });

    if (injectableTabs.length === 0) {
      console.log('No injectable tabs found. Nothing to do.');
      return;
    }
    console.log(`✅ Found ${injectableTabs.length} injectable tabs.`);

  // 2. Inject scripts and collect content with limited concurrency to avoid mass reload pressure
  const CONCURRENCY = config.injection.concurrency; // configurable
    const processWithConcurrency = async (items, concurrency, mapper) => {
      const results = new Array(items.length);
      let index = 0;
      const workers = Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) break;
          results[current] = await mapper(items[current], current);
        }
      });
      await Promise.all(workers);
      return results;
    };

    const tabContents = await processWithConcurrency(injectableTabs, CONCURRENCY, injectAndGetContent);

    // Filter out any tabs that failed to return content
    const validTabs = tabContents.filter(t => t !== null).map(t => ({ ...t, source: 'current' }));
    console.log(`→ Collected content from ${validTabs.length} tabs.`);

    if (validTabs.length === 0) {
      console.log('No content was collected. Aborting summarization.');
      return;
    }

    // 3. Fetch historical tabs from IndexedDB and combine with current tabs
  let historicalTabs = await fetchHistoricalTabsFromDB();
  // Filter out excluded domains from historical as well (won't be sent to AI)
  historicalTabs = historicalTabs.filter(t => !isUrlExcluded(t.url));
    console.log(`📚 Loaded ${historicalTabs.length} historical tabs from DB.`);

    // 3.5 Pre-summarize current tabs that are NOT in history using lite model (batched)
    const historyUrlSet = new Set(historicalTabs.map(t => t.url).filter(Boolean));
    const toSummarize = validTabs.filter(t => t && t.url && !historyUrlSet.has(t.url));
  console.log(`🪄 Pre-summarizing ${toSummarize.length} current tab(s) with lite model — auto-batched (${config.liteSummary.batchSize} tabs/request, up to ${config.liteSummary.concurrency} requests concurrently).`);

    const summaryByUrl = {};
    try {
      // summarizeTabsLiteBatch now handles batching and concurrency internally
      const batchResults = await summarizeTabsLiteBatch(toSummarize);
      for (const item of batchResults) {
        if (item && item.url) summaryByUrl[item.url] = item.summary || '';
      }
    } catch (e) {
      console.warn(`Lite summarization failed:`, String(e));
    }
    const summarizedCurrentTabs = validTabs.map(t => {
      if (!t || !t.url) return t;
      if (historyUrlSet.has(t.url)) return t; // will be skipped by history preference later
      const s = summaryByUrl[t.url];
      return s && s.length > 0 ? { ...t, content: s } : t;
    });

    // 4. Merge and de-duplicate by URL.
    // Prioritize historical DB entries over current open tabs because
    // historical entries already contain summaries (saving prompt tokens).
    const byUrl = new Map();
    for (const t of historicalTabs) {
      if (t && t.url) {
        byUrl.set(t.url, t);
      }
    }

    let skippedCurrentBecauseHistory = 0;
    for (const t of summarizedCurrentTabs) {
      if (t && t.url) {
        if (byUrl.has(t.url)) {
          // A historical entry exists for this URL; keep it and skip the current tab
          skippedCurrentBecauseHistory++;
          continue;
        }
        // No history for this URL, include the current tab
        byUrl.set(t.url, t);
      }
    }

    const combinedTabs = Array.from(byUrl.values());
    console.log(`🔗 Combined set for AI: ${combinedTabs.length} unique tabs (current provided: ${validTabs.length}, historical provided: ${historicalTabs.length}, skipped current due to history: ${skippedCurrentBecauseHistory}).`);

    // 5. Summarize all combined tabs in a single request
    console.log(`🧠 Running summarizeTabs for ${combinedTabs.length} tabs (current + history)...`);
  const aiResults = await summarizeTabs(combinedTabs);
    console.log('🤖 Full AI Response:', JSON.stringify(aiResults));
    // 6. Save the results to IndexedDB
    // Build a BEST-EFFORT title lookup using both current and history, preferring non-empty, non-"Untitled" titles
    const isGoodTitle = (s) => {
      const val = (s || "").trim();
      return val.length > 0 && val.toLowerCase() !== 'untitled';
    };

    const bestTitleByUrl = new Map();
    // Seed from history first
    for (const t of historicalTabs) {
      if (!t?.url) continue;
      if (isGoodTitle(t.title)) bestTitleByUrl.set(t.url, t.title.trim());
      else if (!bestTitleByUrl.has(t.url)) bestTitleByUrl.set(t.url, (t.title || 'Untitled').trim());
    }
    // Overlay current titles, preferring a good title
    for (const t of validTabs) {
      if (!t?.url) continue;
      const curr = (t.title || '').trim();
      const have = bestTitleByUrl.get(t.url);
      if (isGoodTitle(curr)) {
        // Prefer current good title over any existing
        bestTitleByUrl.set(t.url, curr);
      } else if (!have) {
        bestTitleByUrl.set(t.url, curr || 'Untitled');
      }
    }
    // Ensure every combined URL has some title value
    for (const t of combinedTabs) {
      if (!t?.url) continue;
      if (!bestTitleByUrl.has(t.url)) {
        bestTitleByUrl.set(t.url, (t.title || 'Untitled').trim() || 'Untitled');
      }
    }

    const titles = Object.fromEntries(bestTitleByUrl.entries());
  await saveAISummaries(aiResults, titles);
    console.log(`✅ Successfully saved AI summaries for ${aiResults.length} tabs.`);
    // Notify UI pages (e.g., viewer.html) that collection and summarization are complete
    try {
      chrome.runtime.sendMessage({ type: "COLLECT_TABS_DONE", count: aiResults.length });
    } catch (notifyErr) {
      console.warn("Failed to notify UI about completion:", notifyErr);
    }

  } catch (error) {
    console.error('❌ An error occurred during the collect and summarize process:', error);
    try {
      chrome.runtime.sendMessage({ type: "COLLECT_TABS_FAILED", error: String(error?.message || error) });
    } catch {}
  }
}

async function injectAndGetContent(tab) {
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  const withTimeout = (promise, ms, label = "operation") => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out")), ms))
    ]);
  };

  const waitForTabReady = async (tabId, expectedUrl, timeoutMs = config.injection.reloadWaitTimeoutMs) => {
    // Resolve when tab is fully loaded (status 'complete') and not discarded/frozen
    return withTimeout(new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
      };
      const check = async () => {
        try {
          const t = await chrome.tabs.get(tabId);
          const url = t.url || t.pendingUrl || '';
          const httpOk = /^https?:\/\//.test(url);
          if (t.status === 'complete' && !t.discarded && !t.frozen && httpOk) {
            cleanup();
            resolve(true);
          }
        } catch (e) {
          cleanup();
          reject(e);
        }
      };
      const onUpdated = (updatedTabId, info, updatedTab) => {
        if (updatedTabId !== tabId) return;
        if (info.status === 'complete') {
          // status complete fired; double-check flags
          check();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      // Initial small poll in case it's already ready
      check();
    }), timeoutMs, 'waitForTabReady');
  };
  try {
    // Reload frozen/discarded tabs before injection
    if (tab.frozen || tab.discarded) {
      try {
        // Temporarily prevent auto-discarding during capture
        await chrome.tabs.update(tab.id, { autoDiscardable: false });
      } catch {}
      await chrome.tabs.reload(tab.id);
      console.log('→ Reloaded frozen/discarded tab:', tab.url);
      // Wait for the tab to be fully loaded and active in memory
      await waitForTabReady(tab.id, tab.url).catch(() => {});
    }

    // Inject the content script. It will automatically run.
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      }),
      config.injection.injectTimeoutMs,
      'script injection'
    );

    // After injection, send a message to the content script telling it to get the content
    // and send it back. This is more reliable than having the content script send a message
    // on its own.
    const response = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT' }),
      config.injection.contentFetchTimeoutMs,
      'content fetch'
    );

    if (response && response.url) {
      return {
        title: response.title,
        url: response.url,
        content: response.content,
      };
    } else {
      throw new Error('Invalid or empty response from content script');
    }
  } catch (err) {
    console.warn(`⚠️ Failed to get content from tab: ${tab.url}`, String(err));
    saveRejectedTab(tab.url, 'content_script_failed')
      .catch(saveErr => console.error('❌ Failed to save rejected tab:', tab.url, saveErr));
    return null; // Return null for failed tabs so Promise.all doesn't reject.
  }
}

chrome.action.onClicked.addListener(async () => {
  console.log("🧠 NeuMemo icon clicked — opening viewer...");
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

// Read historical tabs (previous AI summaries) from IndexedDB and convert to summarizeTabs input shape
async function fetchHistoricalTabsFromDB() {
  const DB_NAME = "NeuMemoDB";
  const DB_VERSION = 6;
  const TABS_STORE = "tabs";

  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = (e) => reject(e.target?.error || e);
      req.onsuccess = (e) => resolve(e.target.result);
    });

    // If the store doesn't exist yet, treat as empty history
    if (!db.objectStoreNames.contains(TABS_STORE)) {
      db.close();
      return [];
    }

    const tabs = await new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(TABS_STORE, "readonly");
        const store = tx.objectStore(TABS_STORE);
        const req = store.getAll();
        req.onerror = (e) => reject(e.target?.error || e);
        req.onsuccess = (e) => resolve(e.target.result || []);
        tx.oncomplete = () => db.close();
      } catch (err) {
        db.close();
        reject(err);
      }
    });

    // Map DB records to summarizeTabs input structure
    // Use the stored summary as the content fed back into the AI context
    return tabs
      .filter(Boolean)
      .map(t => ({
        title: t.title || "Untitled",
        url: t.url,
        content: t.summary || "",
        source: 'history'
      }))
      .filter(t => t.url); // ensure URL exists
  } catch (err) {
    console.warn("⚠️ Failed to read historical tabs from DB; proceeding with current tabs only.", String(err));
    return [];
  }
}

function saveRejectedTab(url, reason) {
  const DB_NAME = "NeuMemoDB";
  const STORE_NAME = "rejected_tabs";

  function openAndEnsureStore() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);

      req.onerror = (e) => reject(e.target.error);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "url" });
        }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (db.objectStoreNames.contains(STORE_NAME)) {
          return resolve(db);
        }
        const newVersion = db.version + 1;
        db.close();
        const req2 = indexedDB.open(DB_NAME, newVersion);
        req2.onerror = (ev) => reject(ev.target.error);
        req2.onupgradeneeded = (ev) => {
          const upgradeDb = ev.target.result;
          if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
            upgradeDb.createObjectStore(STORE_NAME, { keyPath: "url" });
          }
        };
        req2.onsuccess = (ev) => resolve(ev.target.result);
      };
    });
  }

  return new Promise((resolve, reject) => {
    openAndEnsureStore()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        try {
          store.put({
            url,
            reason,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          db.close();
          return reject(err);
        }

        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = (ev) => {
          db.close();
          reject(ev.target ? ev.target.error : ev);
        };
      })
      .catch((err) => reject(err));
  });
}

// Save AI-produced summaries (array of objects that contain at least tab_id)
async function saveAISummaries(aiResults, tabTitles) {
  const DB_NAME = "NeuMemoDB";
  const DB_VERSION = 6;
  const SESSIONS_STORE = "sessions";
  const TABS_STORE = "tabs";

  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = e => reject(e.target.error);
    request.onsuccess = e => resolve(e.target.result);
    // onupgradeneeded is handled in viewer.js, so it should be up-to-date
  });

  try {
    // 1) Build a set of VALID URLs from AI results for reconciliation (only those we have titles for)
    const urlsFromAI = new Set(
      aiResults
        .map(r => r.tab_id)
        .filter(u => typeof u === 'string' && !!u && tabTitles && Object.prototype.hasOwnProperty.call(tabTitles, u))
    );

    // 2) Remove tabs not present in the AI output (full reconcile)
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TABS_STORE, "readwrite");
      const store = tx.objectStore(TABS_STORE);
      const getAllReq = store.getAll();
      getAllReq.onerror = (e) => reject(e.target?.error || e);
      getAllReq.onsuccess = (e) => {
        const existing = e.target.result || [];
        existing.forEach(tab => {
          if (tab && tab.url && !urlsFromAI.has(tab.url)) {
            store.delete(tab.url);
          }
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target?.error || e);
    });

    // 3) Ensure sessions exist and cache name->id
    const sessions = {};
    // Load existing sessions using a dedicated readonly transaction
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSIONS_STORE, "readonly");
      const store = tx.objectStore(SESSIONS_STORE);
      const idx = store.index("name");
      idx.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          sessions[cursor.value.name] = cursor.value.id;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target?.error || e);
    });

    // Helper to get or create a session id safely with its own transaction
    const getOrCreateSessionId = async (sessionName) => {
      if (sessions[sessionName]) return sessions[sessionName];
      // Check again via readonly in case of concurrent writers
      const existingId = await new Promise((resolve, reject) => {
        const tx = db.transaction(SESSIONS_STORE, "readonly");
        const store = tx.objectStore(SESSIONS_STORE);
        const idx = store.index("name");
        const req = idx.get(sessionName);
        req.onsuccess = (e) => resolve(e.target.result ? e.target.result.id : undefined);
        req.onerror = (e) => reject(e.target?.error || e);
      });
      if (existingId) {
        sessions[sessionName] = existingId;
        return existingId;
      }
      // Create new session in its own write transaction
      const createdId = await new Promise((resolve, reject) => {
        const tx = db.transaction(SESSIONS_STORE, "readwrite");
        const store = tx.objectStore(SESSIONS_STORE);
        const addReq = store.add({ name: sessionName });
        addReq.onsuccess = (e) => resolve(e.target.result);
        addReq.onerror = (e) => {
          const err = e.target?.error;
          if (err && err.name === 'ConstraintError') {
            // Another writer added it; fetch it
            tx.abort();
          } else {
            reject(err || e);
          }
        };
        tx.onabort = async () => {
          try {
            const id = await new Promise((resolve2, reject2) => {
              const tx2 = db.transaction(SESSIONS_STORE, "readonly");
              const store2 = tx2.objectStore(SESSIONS_STORE);
              const idx2 = store2.index("name");
              const req2 = idx2.get(sessionName);
              req2.onsuccess = (ev) => resolve2(ev.target.result ? ev.target.result.id : undefined);
              req2.onerror = (ev) => reject2(ev.target?.error || ev);
            });
            resolve(id);
          } catch (fetchErr) {
            reject(fetchErr);
          }
        };
      });
      if (!createdId) throw new Error("Failed to resolve session id after creation attempt");
      sessions[sessionName] = createdId;
      return createdId;
    };

    // 4) Upsert tabs according to AI results with updated session mapping
    for (const result of aiResults) {
      const sessionName = result.session_name || "Uncategorized";
      const sessionId = await getOrCreateSessionId(sessionName);

      // Skip any AI rows that don't map to a known URL we provided
      const url = (result && typeof result.tab_id === 'string') ? result.tab_id : '';
      if (!url || !Object.prototype.hasOwnProperty.call(tabTitles, url)) {
        continue;
      }
      // Final safety: never persist excluded domains
      if (isUrlExcluded(url)) {
        continue;
      }

      await new Promise((resolve, reject) => {
        const tabTx = db.transaction(TABS_STORE, "readwrite");
        const tabStore = tabTx.objectStore(TABS_STORE);
        const putReq = tabStore.put({
          sessionId,
          url,
          title: tabTitles[url] || "Untitled",
          summary: result.summarized_content,
          timestamp: new Date().toISOString(),
        });
        putReq.onerror = (e) => reject(e.target?.error || e);
        tabTx.oncomplete = () => resolve();
        tabTx.onerror = (e) => reject(e.target?.error || e);
      });
    }

    // 5) Remove empty sessions (no tabs referencing them)
    await new Promise((resolve, reject) => {
      const tx = db.transaction([SESSIONS_STORE, TABS_STORE], "readwrite");
      const sessionStore2 = tx.objectStore(SESSIONS_STORE);
      const tabStore2 = tx.objectStore(TABS_STORE);
      const tabIndex = tabStore2.index("sessionId");

      sessionStore2.getAll().onsuccess = (e) => {
        const allSessions = e.target.result || [];
        let pending = allSessions.length;
        if (pending === 0) return; // nothing to clean
        allSessions.forEach(sess => {
          const req = tabIndex.get(sess.id);
          req.onsuccess = (ev) => {
            const anyTab = ev.target.result; // undefined if none
            if (!anyTab) {
              sessionStore2.delete(sess.id);
            }
            if (--pending === 0) {
              // Wait for deletes to be queued; tx will complete
            }
          };
          req.onerror = () => {
            if (--pending === 0) {
              // ignore errors silently here
            }
          };
        });
      };

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target?.error || e);
    });

  } finally {
    db.close();
  }
}