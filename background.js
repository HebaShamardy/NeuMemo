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
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    // only attempt real web pages
    if (!/^https?:\/\//.test(tab.url)) {
      console.log("⤷ Skipping (unsupported URL):", tab.url);
      continue;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      console.log("→ Injected into:", tab.url);
    } catch (err) {
      console.warn("⚠️ Injection failed for", tab.url, err);
      // Your existing retry/rejection logic can be placed here or called from here
      saveRejectedTab(tab.url, String(err))
        .then(() => console.log("→ Saved rejected tab:", tab.url))
        .catch((saveErr) => console.error("❌ Failed to save rejected tab:", tab.url, saveErr));
    }
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