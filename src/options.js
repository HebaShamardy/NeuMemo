(function(){
  const DB_NAME = "NeuMemoDB";
  const DB_VERSION = 6;
  const EXCLUDED_URLS_STORE = "excluded_urls";
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) {
        return resolve(db);
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = (event) => reject("Database error: " + event.target.error);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(EXCLUDED_URLS_STORE)) {
          db.createObjectStore(EXCLUDED_URLS_STORE, { keyPath: "domain" });
        }
      };
      request.onsuccess = (event) => {
        db = event.target.result;
        resolve(db);
      };
    });
  }

  async function ensureStoreExists() {
    const current = await openDB();
    if (current.objectStoreNames && !current.objectStoreNames.contains(EXCLUDED_URLS_STORE)) {
      const newVersion = current.version + 1;
      current.close();
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, newVersion);
        req.onerror = (e) => reject(e.target.error);
        req.onupgradeneeded = (ev) => {
          const upgradeDb = ev.target.result;
          if (!upgradeDb.objectStoreNames.contains(EXCLUDED_URLS_STORE)) {
            upgradeDb.createObjectStore(EXCLUDED_URLS_STORE, { keyPath: "domain" });
          }
        };
        req.onsuccess = (ev) => {
          db = ev.target.result;
          resolve();
        };
      });
    }
  }

  function normalizeRule(rule){
    if(!rule || typeof rule !== 'string') return '';
    let r = rule.trim().toLowerCase();
    try {
      if (r.startsWith('http://') || r.startsWith('https://')) {
        r = new URL(r).hostname;
      }
    } catch {}
    if(r.startsWith('*.')) r = r.slice(2);
    if(r.endsWith('/')) r = r.replace(/\/+$/, '');
    return r;
  }

  async function loadRules(){
    await ensureStoreExists();
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(EXCLUDED_URLS_STORE, "readonly");
      const store = transaction.objectStore(EXCLUDED_URLS_STORE);
      const request = store.getAll();
      request.onerror = (event) => reject("Error loading rules: " + event.target.error);
      request.onsuccess = (event) => {
        const domains = event.target.result.map(item => item.domain);
        resolve(domains);
      };
    });
  }

  async function addRule(domain) {
    await ensureStoreExists();
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(EXCLUDED_URLS_STORE, "readwrite");
      const store = transaction.objectStore(EXCLUDED_URLS_STORE);
      const request = store.add({ domain });
      request.onerror = (event) => reject("Error adding rule: " + event.target.error);
      transaction.oncomplete = () => resolve();
    });
  }

  async function removeRule(domain) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(EXCLUDED_URLS_STORE, "readwrite");
      const store = transaction.objectStore(EXCLUDED_URLS_STORE);
      const request = store.delete(domain);
       request.onerror = (event) => reject("Error removing rule: " + event.target.error);
      transaction.oncomplete = () => resolve();
    });
  }

  function render(list){
    const ul = document.getElementById('exclude-list');
    const empty = document.getElementById('empty-state');
    ul.innerHTML = '';
    if(!list || list.length === 0){
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.forEach((rule) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = rule;
      left.className = 'rule';

      const btn = document.createElement('button');
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        await removeRule(rule);
        const newList = await loadRules();
        render(newList);
      });

      li.appendChild(left);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  async function onAdd(){
    const input = document.getElementById('domain-input');
    const raw = input.value;
    const norm = normalizeRule(raw);
    if(!norm){
      input.focus();
      return;
    }
    const current = await loadRules();
    if(current.includes(norm)){
      input.value = '';
      input.focus();
      return;
    }
    await addRule(norm);
    const newList = await loadRules();
    render(newList);
    input.value = '';
    input.focus();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await openDB();
      const list = await loadRules();
      render(list);

      document.getElementById('add-btn').addEventListener('click', onAdd);
      document.getElementById('domain-input').addEventListener('keydown', (e)=>{
        if(e.key === 'Enter') onAdd();
      });
    } catch (error) {
      console.error("Failed to initialize settings page:", error);
      const container = document.querySelector('.container');
      if (container) {
        container.innerHTML = '<p style="color: red; font-weight: bold;">Error: Could not connect to the database. Please ensure the extension is running correctly.</p>';
      }
    }
  });
})();
