

import { summarizeTabs } from './firebase_ai.js';

// Bulk collection state: when collecting tabs, we buffer incoming TAB_CONTENT
// messages until all expected tabs have reported, then call summarizeTabs once.
let bulkExpected = 0;
let bulkCollected = [];
let bulkFallbackTimer = null;

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.type === "TAB_CONTENT") {
    // If we're not in bulk collection mode, ignore the message.
    if (bulkExpected === 0) {
      console.warn('⚠️ Received TAB_CONTENT message outside of bulk collection mode. Ignoring.');
      sendResponse({ success: false, error: 'not_in_bulk_mode' });
      return false;
    }

    const { title, url, content } = message.data || {};
    if (!url) {
      sendResponse({ success: false, error: 'missing_url' });
      return false;
    }

    // Dedupe by URL and add to the collection
    if (!bulkCollected.find((t) => t.url === url)) {
      bulkCollected.push({ title: title || '', url, content: content || '' });
      console.log(`→ Buffered TAB_CONTENT for bulk summary: ${bulkCollected.length}/${bulkExpected}`);
    }

    // Acknowledge receipt to the sender
    sendResponse({ success: true, buffered: true });

    // If we've gathered all expected tabs, run the bulk summarization.
    if (bulkCollected.length >= bulkExpected) {
      if (bulkFallbackTimer) {
        clearTimeout(bulkFallbackTimer);
        bulkFallbackTimer = null;
      }
      // Use a copy and reset state immediately
      const collected = bulkCollected.slice();
      bulkExpected = 0;
      bulkCollected = [];

      try {
        console.log('🧠 Running summarizeTabs for', collected.length, 'tabs');
        const aiResults = await summarizeTabs(collected);
        console.log('🤖 Full AI Response:', JSON.stringify(aiResults, null, 2));
        await saveAISummaries(aiResults);
        console.log('✅ Saved AI summaries for', aiResults.length, 'tabs');
      } catch (err) {
        console.error('❌ summarizeTabs failed for bulk collection:', err);
      }
    }
    return false; // we've already sent a response

  } else if (message.type === "COLLECT_TABS") {
    console.log("🧠 Received collect tabs request from viewer...");
    // Immediately start the collection process without waiting for it to finish
    collectAndSummarizeAllTabs();
    sendResponse({ status: "Collection process started." });
    return false; // No need to keep channel open
  }
});

async function collectAndSummarizeAllTabs() {
  // 1. Get all tabs first to determine the expected count
  let allTabs = [];
  try {
    allTabs = await chrome.tabs.query({});
  } catch (err) {
    console.error('Failed to query tabs:', err);
    return;
  }

  const injectableTabs = allTabs.filter(tab => {
    const url = tab.url || tab.pendingUrl || '';
    return tab.id && url && /^https?:\/\//.test(url);
  });

  if (injectableTabs.length === 0) {
    console.log('No injectable tabs found.');
    return;
  }

  // 2. Set up the bulk collection state BEFORE injecting any scripts
  bulkExpected = injectableTabs.length;
  bulkCollected = [];
  console.log(`→ Bulk collection started, expecting ${bulkExpected} tab contents`);

  // 3. Set a fallback timer to process whatever is collected after a timeout
  if (bulkFallbackTimer) clearTimeout(bulkFallbackTimer);
  bulkFallbackTimer = setTimeout(async () => {
    if (bulkExpected === 0) return; // Already processed
    
    const collected = bulkCollected.slice();
    console.log(`🕒 Bulk fallback triggered — summarizing ${collected.length} collected tabs`);
    
    // Reset state
    bulkExpected = 0;
    bulkCollected = [];
    bulkFallbackTimer = null;

    if (collected.length > 0) {
      try {
        const aiResults = await summarizeTabs(collected);
        await saveAISummaries(aiResults);
        console.log('✅ Saved AI summaries (fallback) for', aiResults.length, 'tabs');
      } catch (err) {
        console.error('❌ Bulk fallback summarizeTabs failed:', err);
      }
    }
  }, 15000); // 15-second timeout

  // 4. Now, inject scripts into the filtered list of tabs
  await injectContentScriptsIntoTabs(injectableTabs);
}


async function injectContentScriptsIntoTabs(tabs) {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let count = 1;
  for (const tab of tabs) {
    console.log(`⤷ [${count++}/${tabs.length}] Processing tab:`, tab.url);
    
    try {
      // Reload frozen/discarded tabs before injection
      if (tab.frozen || tab.discarded) {
        await chrome.tabs.reload(tab.id);
        await sleep(300); // Give tab time to reload
        console.log('→ Reloaded frozen/discarded tab:', tab.url);
      }
      
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      console.log('→ Injected into:', tab.url);
    } catch (err) {
      console.warn(`⚠️ Injection failed for`, tab.url, err);
      // If injection fails, we must decrement the expected count
      // or the bulk collection will never complete.
      bulkExpected--;
      saveRejectedTab(tab.url, 'injection_failed')
        .then(() => console.log('→ Saved rejected tab:', tab.url))
        .catch((saveErr) => console.error('❌ Failed to save rejected tab:', tab.url, saveErr));
    }
    
    // Throttle a bit between tabs
    await sleep(50);
  }
}

chrome.action.onClicked.addListener(async () => {
  console.log("🧠 NeuMemo icon clicked — opening viewer...");
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

function saveToIndexedDB(tabData) {
  const DB_NAME = "NeuMemoDB";
  const STORE_NAME = "tabs";

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
            url: tabData.url,
            title: tabData.title,
            content: tabData.content,
            summarized_content: tabData.summarized_content || null,
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
function saveAISummaries(summaries) {
  const DB_NAME = "NeuMemoDB";
  const STORE_NAME = "tabs";

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
          for (const s of summaries) {
            const url = s.tab_id || s.url || s.tabId;
            if (!url) continue;
            store.put({
              url,
              title: s.title || null,
              summarized_content: s.summarized_content || null,
              language: s.language || null,
              tags: s.tags || null,
              main_class: s.main_class || null,
              classes: s.classes || null,
              timestamp: new Date().toISOString(),
            });
          }
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