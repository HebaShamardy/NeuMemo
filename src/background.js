chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TAB_CONTENT") {
    saveToIndexedDB(message.data)
      .then(() => {
        console.log("✅ Saved tab data (service worker):", message.data.url);
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("❌ Failed to save tab data:", err);
        sendResponse({ success: false, error: String(err) });
      });
    return true; // keep the message channel (and SW) alive until sendResponse is called
  } else if (message.type === "COLLECT_TABS") {
    console.log("🧠 Received collect tabs request from viewer...");
    injectContentScriptsIntoAllTabs();
    sendResponse({ status: "Collection process started." });
    return false; // No need to keep channel open
  }
});

async function injectContentScriptsIntoAllTabs() {
  // Collect tabs from all windows to avoid missing tabs in other windows or
  // special window states. Use windows.getAll({populate:true}) which returns
  // tabs for each window, and fall back to tabs.query if needed.
  let allTabs = [];
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (Array.isArray(w.tabs)) allTabs.push(...w.tabs);
    }
  } catch (err) {
    console.warn('Could not get windows with tabs, falling back to tabs.query', err);
  }

  if (allTabs.length === 0) {
    try {
      allTabs = await chrome.tabs.query({});
    } catch (err) {
      console.error('Failed to query tabs:', err);
      return;
    }
  }

  // Helper: small sleep to avoid spamming many injections at once
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  for (const tab of allTabs) {
    const tabId = tab.id;
    const url = tab.url || tab.pendingUrl || '';
    if (!tabId || !url) {
      console.log('⤷ Skipping (no id or url):', tab);
      continue;
    }

    // only attempt real web pages
    if (!/^https?:\/\//.test(url)) {
      console.log('⤷ Skipping (unsupported URL):', url);
      continue;
    }

    // Try injection with a couple retries and a small delay between attempts
    let injected = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        console.log('→ Injected into:', url);
        injected = true;
        break;
      } catch (err) {
        console.warn(`⚠️ Injection attempt ${attempt} failed for`, url, err);
        // small backoff before retrying
        await sleep(250 * attempt);
      }
    }

    if (!injected) {
      // Save as rejected once retries exhausted
      saveRejectedTab(url, 'injection_failed')
        .then(() => console.log('→ Saved rejected tab:', url))
        .catch((saveErr) => console.error('❌ Failed to save rejected tab:', url, saveErr));
    }

    // Throttle a bit between tabs to reduce contention
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