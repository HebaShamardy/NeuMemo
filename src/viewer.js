const DB_NAME = "NeuMemoDB";
const DB_VERSION = 6; // Incremented version to trigger onupgradeneeded
const SESSIONS_STORE = "sessions";
const TABS_STORE = "tabs";
const EXCLUDED_URLS_STORE = "excluded_urls";

let db;

document.addEventListener("DOMContentLoaded", () => {
    initDatabase().then(() => {
        loadSessions();
        document.getElementById("save-session").addEventListener("click", saveCurrentSession);
        document.getElementById("new-session").addEventListener("click", createNewSession);
        document.getElementById("search-input").addEventListener("keydown", handleSearch);
    });
    initResizeableSidebar();
    // Listen for background completion/failure notifications
    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === "COLLECT_TABS_DONE") {
            showLoading(false);
            loadSessions();
        } else if (message?.type === "COLLECT_TABS_FAILED") {
            showLoading(false);
            console.warn("Tab collection/summarization failed:", message?.error || "Unknown error");
            alert("Failed to organize tabs. Please try again.");
        }
    });
});

function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("Database error:", event.target.error);
            reject(event.target.error);
        };

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
                const sessionStore = db.createObjectStore(SESSIONS_STORE, { keyPath: "id", autoIncrement: true });
                sessionStore.createIndex("name", "name", { unique: true });
            }
            if (!db.objectStoreNames.contains(TABS_STORE)) {
                const tabStore = db.createObjectStore(TABS_STORE, { keyPath: "url" });
                tabStore.createIndex("sessionId", "sessionId", { unique: false });
            }
            if (!db.objectStoreNames.contains(EXCLUDED_URLS_STORE)) {
                db.createObjectStore(EXCLUDED_URLS_STORE, { keyPath: "domain" });
            }
            
            // Data migration from old structure if necessary
            if (event.oldVersion === 1) {
                // Logic to migrate old 'tabs' data to new 'sessions' and 'tabs' stores
                const tx = event.target.transaction;
                if (tx.objectStoreNames.contains("tabs")) {
                    const oldTabsStore = tx.objectStore("tabs");
                    const newTabsStore = tx.objectStore(TABS_STORE);
                    const newSessionStore = tx.objectStore(SESSIONS_STORE);

                    oldTabsStore.getAll().onsuccess = (e) => {
                        const oldTabs = e.target.result;
                        const sessions = {}; // Group tabs by session_name

                        oldTabs.forEach(tab => {
                            const sessionName = tab.session_name || "Uncategorized";
                            if (!sessions[sessionName]) {
                                sessions[sessionName] = [];
                            }
                            sessions[sessionName].push(tab);
                        });

                        Object.keys(sessions).forEach(sessionName => {
                            newSessionStore.add({ name: sessionName }).onsuccess = (e) => {
                                const sessionId = e.target.result;
                                sessions[sessionName].forEach(tab => {
                                    newTabsStore.add({
                                        sessionId: sessionId,
                                        title: tab.title,
                                        url: tab.url,
                                        summary: tab.summarized_content
                                    });
                                });
                            };
                        });
                    };
                }
                 if (tx.objectStoreNames.contains("collected_tabs")) {
                    db.deleteObjectStore("collected_tabs");
                }
                if (tx.objectStoreNames.contains("rejected_tabs")) {
                    db.deleteObjectStore("rejected_tabs");
                }
            }

            if (event.oldVersion < 5) {
                const tx = event.target.transaction;
                if (tx.objectStoreNames.contains(TABS_STORE)) {
                    const tabStore = tx.objectStore(TABS_STORE);
                    if (tabStore.keyPath !== 'url') {
                        // This is a destructive operation, but necessary to fix the key path.
                        db.deleteObjectStore(TABS_STORE);
                        const newTabStore = db.createObjectStore(TABS_STORE, { keyPath: "url" });
                        newTabStore.createIndex("sessionId", "sessionId", { unique: false });
                    }
                }
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve();
        };
    });
}

function loadSessions() {
    const transaction = db.transaction(SESSIONS_STORE, "readonly");
    const store = transaction.objectStore(SESSIONS_STORE);
    const request = store.getAll();

    request.onsuccess = (event) => {
        const sessions = event.target.result;
        const sessionsList = document.getElementById("sessions-list");
        sessionsList.innerHTML = "";

        sessions.forEach(session => {
            const li = document.createElement("li");
            li.dataset.sessionId = session.id;

            const sessionNameSpan = document.createElement('span');
            sessionNameSpan.className = 'session-name';
            sessionNameSpan.textContent = session.name;
            li.appendChild(sessionNameSpan);

            li.addEventListener("click", () => {
                document.getElementById("search-input").value = ""; // Clear search
                loadTabsForSession(session.id);
                document.querySelectorAll("#sessions-list li").forEach(item => item.classList.remove("active"));
                li.classList.add("active");
            });
            
            const actions = document.createElement('div');
            actions.className = 'session-actions';

            const editButton = document.createElement('button');
            editButton.textContent = '✏️';
            editButton.className = 'edit-session';
            editButton.onclick = (e) => {
                e.stopPropagation();
                editSessionName(session.id, session.name);
            };

            const deleteButton = document.createElement('button');
            deleteButton.textContent = '🗑️';
            deleteButton.className = 'delete-session';
            deleteButton.onclick = (e) => {
                e.stopPropagation();
                deleteSession(session.id);
            };
            
            const openButton = document.createElement('button');
            openButton.textContent = '↗️';
            openButton.title = 'Open all tabs in new window';
            openButton.onclick = (e) => {
                e.stopPropagation();
                openSessionInNewWindow(session.id);
            };

            actions.appendChild(openButton);
            actions.appendChild(editButton);
            actions.appendChild(deleteButton);
            li.appendChild(actions);

            sessionsList.appendChild(li);
        });

        if (sessions.length > 0) {
            loadTabsForSession(sessions[0].id);
            sessionsList.firstChild.classList.add("active");
        }
    };
}

function loadTabsForSession(sessionId) {
    const searchInput = document.getElementById("search-input");
    if (searchInput.value.trim().length > 0) {
        // If there is a search query, don't load session tabs
        return;
    }
    const transaction = db.transaction(TABS_STORE, "readonly");
    const store = transaction.objectStore(TABS_STORE);
    const index = store.index("sessionId");
    const request = index.getAll(sessionId);

    request.onsuccess = (event) => {
        const tabs = event.target.result;
        const tabsList = document.getElementById("tabs-list");
        tabsList.innerHTML = "";

        tabs.forEach(tab => {
            const li = document.createElement("li");
            const tabLink = document.createElement("a");
            tabLink.href = tab.url;
            tabLink.textContent = tab.title || tab.url;
            tabLink.target = "_blank";
            
            const tabSummary = document.createElement("p");
            tabSummary.textContent = tab.summary || '';
            
            const tabContent = document.createElement('div');
            tabContent.appendChild(tabLink);
            tabContent.appendChild(tabSummary);

            const actions = document.createElement('div');
            actions.className = 'tab-actions';

            const moveButton = document.createElement('button');
            moveButton.textContent = 'Move';
            moveButton.onclick = () => moveTab(tab.url, tab.sessionId);

            const deleteButton = document.createElement('button');
            deleteButton.textContent = 'Delete';
            deleteButton.onclick = () => deleteTab(tab.url);

            actions.appendChild(moveButton);
            actions.appendChild(deleteButton);
            
            li.appendChild(tabContent);
            li.appendChild(actions);
            tabsList.appendChild(li);
        });
    };
}

async function handleSearch(event) {
    if (event.key !== 'Enter') {
        return;
    }
    const query = event.target.value.trim();
    if (query.length === 0) {
        // If query is empty, load tabs for the selected session
        const activeSession = document.querySelector("#sessions-list li.active");
        if (activeSession) {
            loadTabsForSession(parseInt(activeSession.dataset.sessionId));
        }
        return;
    }

    const allTabs = await getAllTabs();
    
    // Unselect any active session
    document.querySelectorAll("#sessions-list li.active").forEach(item => item.classList.remove("active"));

    chrome.runtime.sendMessage({ type: "SEARCH_TABS", query: query, tabs: allTabs }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending search message:", chrome.runtime.lastError);
            return;
        }
        displaySearchedTabs(response.tabs);
    });
}

function displaySearchedTabs(tabs) {
    const tabsList = document.getElementById("tabs-list");
    tabsList.innerHTML = "";

    if (!tabs) {
        return;
    }

    tabs.forEach(tab => {
        const li = document.createElement("li");
        const tabLink = document.createElement("a");
        tabLink.href = tab.url;
        tabLink.textContent = tab.title || tab.url;
        tabLink.target = "_blank";
        
        const tabSummary = document.createElement("p");
        tabSummary.textContent = tab.summary || '';
        
        const tabContent = document.createElement('div');
        tabContent.appendChild(tabLink);
        tabContent.appendChild(tabSummary);
        
        li.appendChild(tabContent);
        tabsList.appendChild(li);
    });
}

function getAllTabs() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(TABS_STORE, "readonly");
        const store = transaction.objectStore(TABS_STORE);
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

function saveCurrentSession() {
    showLoading(true);
    chrome.runtime.sendMessage({ type: "COLLECT_TABS" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending collect message:", chrome.runtime.lastError);
            showLoading(false);
            return;
        }
    console.log(response.status);
        // We'll refresh when background notifies COLLECT_TABS_DONE
    });
}

function showLoading(isLoading) {
    const overlay = document.getElementById("loading-overlay");
    const saveBtn = document.getElementById("save-session");
    if (!overlay) return;
    if (isLoading) {
        overlay.classList.remove("hidden");
        if (saveBtn) saveBtn.disabled = true;
    } else {
        overlay.classList.add("hidden");
        if (saveBtn) saveBtn.disabled = false;
    }
}

function createNewSession() {
    const sessionName = prompt("Enter new session name:");
    if (sessionName) {
        const transaction = db.transaction(SESSIONS_STORE, "readwrite");
        const store = transaction.objectStore(SESSIONS_STORE);
        store.add({ name: sessionName });

        transaction.oncomplete = () => {
            loadSessions();
        };
    }
}

function editSessionName(sessionId, oldName) {
    const newName = prompt("Enter new session name:", oldName);
    if (newName && newName !== oldName) {
        const transaction = db.transaction(SESSIONS_STORE, "readwrite");
        const store = transaction.objectStore(SESSIONS_STORE);
        store.put({ id: sessionId, name: newName });

        transaction.oncomplete = () => {
            loadSessions();
        };
    }
}

function deleteSession(sessionId) {
    if (confirm("Are you sure you want to delete this session and all its tabs?")) {
        const sessionTx = db.transaction(SESSIONS_STORE, "readwrite");
        sessionTx.objectStore(SESSIONS_STORE).delete(sessionId);

        sessionTx.oncomplete = () => {
            const tabTx = db.transaction(TABS_STORE, "readwrite");
            const tabStore = tabTx.objectStore(TABS_STORE);
            const tabIndex = tabStore.index("sessionId");
            const request = tabIndex.openCursor(IDBKeyRange.only(sessionId));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };

            tabTx.oncomplete = () => {
                loadSessions();
                document.getElementById("tabs-list").innerHTML = "";
            };
        };
    }
}

function deleteTab(tabUrl) {
    if (confirm("Are you sure you want to delete this tab?")) {
        const transaction = db.transaction(TABS_STORE, "readwrite");
        transaction.objectStore(TABS_STORE).delete(tabUrl);

        transaction.oncomplete = () => {
            const activeSession = document.querySelector("#sessions-list li.active");
            if (activeSession) {
                loadTabsForSession(parseInt(activeSession.dataset.sessionId));
            }
        };
    }
}

function moveTab(tabUrl, currentSessionId) {
    const transaction = db.transaction(SESSIONS_STORE, "readonly");
    const store = transaction.objectStore(SESSIONS_STORE);
    store.getAll().onsuccess = (event) => {
        const sessions = event.target.result;
        const sessionOptions = sessions.filter(s => s.id !== currentSessionId).map(s => `${s.id}:${s.name}`).join('\n');
        const newSessionId = prompt(`Enter the ID of the session to move this tab to:\n${sessionOptions.split(':').join(' - ')}`);
        
        if (newSessionId && !isNaN(newSessionId)) {
            const id = parseInt(newSessionId);
            const updateTx = db.transaction(TABS_STORE, "readwrite");
            const tabStore = updateTx.objectStore(TABS_STORE);
            tabStore.get(tabUrl).onsuccess = (e) => {
                const tab = e.target.result;
                tab.sessionId = id;
                tabStore.put(tab);
            };

            updateTx.oncomplete = () => {
                loadTabsForSession(currentSessionId);
            };
        }
    };
}

function openSessionInNewWindow(sessionId) {
    const transaction = db.transaction(TABS_STORE, "readonly");
    const store = transaction.objectStore(TABS_STORE);
    const index = store.index("sessionId");
    const request = index.getAll(sessionId);

    request.onsuccess = (event) => {
        const tabs = event.target.result;
        const urls = tabs.map(t => t.url);
        chrome.windows.create({ url: urls });
    };
}

function initResizeableSidebar() {
    const sidebar = document.getElementById('sidebar');
    const resizer = document.createElement('div');
    resizer.id = 'resizer';
    sidebar.appendChild(resizer);

    let isResizing = false;

    // Restore saved width
    const savedWidth = localStorage.getItem('sidebarWidth');
    if (savedWidth) {
        sidebar.style.width = savedWidth;
    }

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', stopResizing);
    });

    function handleMouseMove(e) {
        if (!isResizing) return;
        
        // Use clientX as it's relative to the viewport
        let newWidth = e.clientX - sidebar.getBoundingClientRect().left;

        // Enforce min/max width constraints defined in CSS
        const style = window.getComputedStyle(sidebar);
        const minWidth = parseInt(style.minWidth, 10);
        const maxWidth = parseInt(style.maxWidth, 10);

        if (newWidth < minWidth) newWidth = minWidth;
        if (newWidth > maxWidth) newWidth = maxWidth;

        sidebar.style.width = `${newWidth}px`;
    }

    function stopResizing() {
        isResizing = false;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';

        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);

        // Save the new width to localStorage
        localStorage.setItem('sidebarWidth', sidebar.style.width);
    }
}