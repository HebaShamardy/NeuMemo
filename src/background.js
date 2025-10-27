import { summarizeTabs } from './firebase_ai.js';
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COLLECT_TABS") {
    console.log("🧠 Received collect tabs request. Starting the process...");
    // Start the process but don't make the listener async.
    // The response is sent back immediately.
    collectAndSummarizeAllTabs();
    sendResponse({ status: "Collection process initiated." });
    return false;
  }
  // The TAB_CONTENT message is now handled by chrome.tabs.sendMessage,
  // which resolves a promise inside injectAndGetContent. This simplifies the logic immensely.
});

async function collectAndSummarizeAllTabs() {
  try {
    // 1. Get all eligible tabs
    const allTabs = await chrome.tabs.query({});
    const injectableTabs = allTabs.filter(tab => {
      const url = tab.url || tab.pendingUrl || '';
      return tab.id && url && /^https?:\/\//.test(url);
    });

    if (injectableTabs.length === 0) {
      console.log('No injectable tabs found. Nothing to do.');
      return;
    }
    console.log(`✅ Found ${injectableTabs.length} injectable tabs.`);

    // 2. Inject scripts and collect content from all tabs in parallel
    const contentPromises = injectableTabs.map(tab => injectAndGetContent(tab));
    const tabContents = await Promise.all(contentPromises);

    // Filter out any tabs that failed to return content
    const validTabs = tabContents.filter(t => t !== null);
    console.log(`→ Collected content from ${validTabs.length} tabs.`);

    if (validTabs.length === 0) {
      console.log('No content was collected. Aborting summarization.');
      return;
    }

    // 3. Summarize all collected tabs in a single request
    console.log(`🧠 Running summarizeTabs for ${validTabs.length} tabs...`);
    const aiResults = await summarizeTabs(validTabs);
    console.log('🤖 Full AI Response:', JSON.stringify(aiResults));
    // 4. Save the results to IndexedDB
    await saveAISummaries(aiResults);
    console.log(`✅ Successfully saved AI summaries for ${aiResults.length} tabs.`);

  } catch (error) {
    console.error('❌ An error occurred during the collect and summarize process:', error);
  }
}

async function injectAndGetContent(tab) {
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));
  try {
    // Reload frozen/discarded tabs before injection
    if (tab.frozen || tab.discarded) {
      await chrome.tabs.reload(tab.id);
      await sleep(500); // Give tab a moment to start reloading
      console.log('→ Reloaded frozen/discarded tab:', tab.url);
    }

    // Inject the content script. It will automatically run.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });

    // After injection, send a message to the content script telling it to get the content
    // and send it back. This is more reliable than having the content script send a message
    // on its own.
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT' });
    
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
              session_name: s.session_name || null,
              summarized_content: s.summarized_content || null,
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