const DB_NAME = "NeuMemoDB";
const COLLECTED_STORE = "tabs";
const REJECTED_STORE = "rejected_tabs";

document.addEventListener("DOMContentLoaded", () => {
  loadTabs();
  document.getElementById("collect-tabs").addEventListener("click", collectCurrentTabs);
});

function loadTabs() {
  Promise.all([loadCollectedTabs(), loadRejectedTabs()])
    .then(([collectedTabs, rejectedTabs]) => {
      populateTable("collected-tabs", collectedTabs);
      populateTable("rejected-tabs", rejectedTabs);
    })
    .catch(err => console.error("Failed to load tabs:", err));
}

function populateTable(tableId, tabs) {
  const tableBody = document.getElementById(tableId).getElementsByTagName("tbody")[0];
  tableBody.innerHTML = ""; // Clear existing rows

  tabs.forEach(tab => {
    const row = tableBody.insertRow();
    if (tableId === 'collected-tabs') {
        row.insertCell(0).textContent = tab.title;
        const urlCell = row.insertCell(1);
        urlCell.innerHTML = `<a href="${tab.url}" target="_blank" rel="noopener noreferrer">${tab.url}</a>`;
        row.insertCell(2).textContent = tab.summarized_content || '';
        row.insertCell(3).textContent = tab.language || '';
        row.insertCell(4).textContent = (tab.tags || []).join(', ');
        row.insertCell(5).textContent = tab.main_class || '';
        row.insertCell(6).textContent = (tab.classes || []).join(', ');
        row.insertCell(7).textContent = tab.timestamp;
    } else { // rejected-tabs
        const urlCell = row.insertCell(0);
        urlCell.innerHTML = `<a href="${tab.url}" target="_blank" rel="noopener noreferrer">${tab.url}</a>`;
        row.insertCell(1).textContent = tab.reason;
        row.insertCell(2).textContent = tab.timestamp;
    }
  });
}

function loadCollectedTabs() {
  return loadTabsFromStore(COLLECTED_STORE);
}

function loadRejectedTabs() {
  return loadTabsFromStore(REJECTED_STORE);
}

function loadTabsFromStore(storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onerror = (e) => reject(e.target.error);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]); // Store doesn't exist, return empty array
        return;
      }
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const getAllReq = store.getAll();

      getAllReq.onsuccess = () => {
        resolve(getAllReq.result);
      };
      getAllReq.onerror = (event) => {
        reject(event.target.error);
      };
      tx.oncomplete = () => {
        db.close();
      };
    };
    // This handles DB creation/upgrade if needed, but the main logic is onsuccess
    req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(COLLECTED_STORE)) {
          db.createObjectStore(COLLECTED_STORE, { keyPath: "url" });
        }
        if (!db.objectStoreNames.contains(REJECTED_STORE)) {
          db.createObjectStore(REJECTED_STORE, { keyPath: "url" });
        }
    };
  });
}

function collectCurrentTabs() {
  // This function now needs to trigger the background script to inject content.js
  chrome.runtime.sendMessage({ type: "COLLECT_TABS" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error sending collect message:", chrome.runtime.lastError);
      return;
    }
    console.log(response.status);
    // Optionally, refresh the view after a delay to allow for processing
    setTimeout(loadTabs, 2000);
  });
}

function saveCollectedTabs(tabs) {
  const req = indexedDB.open(DB_NAME);
  req.onerror = (e) => console.error("Failed to open DB:", e.target.error);
  req.onsuccess = (e) => {
    const db = e.target.result;
    const tx = db.transaction(COLLECTED_STORE, "readwrite");
    const store = tx.objectStore(COLLECTED_STORE);

    tabs.forEach(tab => {
      store.put(tab);
    });

    tx.oncomplete = () => {
      console.log("Collected tabs saved successfully.");
      loadTabs(); // Refresh the displayed tables
    };
    tx.onerror = (e) => console.error("Failed to save collected tabs:", e.target.error);
  };
}