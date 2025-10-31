if (window.__NEMO_CONTENT_INIT__) {
  // Prevent duplicate initialization on re-injection
  console.debug('nemo: content.js already initialized, skipping.');
} else {
  window.__NEMO_CONTENT_INIT__ = true;
  console.log("🧩 content.js loaded: ready for content capture and Google search hints.");

// --- 1) Respond to background's content collection ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CONTENT') {
    console.log("→ Received 'GET_CONTENT', sending back page content.");
    sendResponse({
      title: document.title,
      url: window.location.href,
      content: document.body?.innerText || ''
    });
    return true;
  }

  if (message.type === 'GOOGLE_SEARCH_MATCH') {
    // Background found a relevant historical session for the current Google query
    try {
      if (message && message.found && message.sessionName && typeof message.sessionId !== 'undefined') {
        renderNemoSideHint(message.sessionName, message.sessionId, message.count || 0);
      } else {
        removeNemoSideHint();
      }
    } catch (e) {
      console.warn('Failed to render search hint:', e);
    }
  }
});

// --- 2) Google search query detection and messaging ---
(function setupGoogleQueryListener() {
  try {
    const isGoogleHost = () => /(^|\.)google\./i.test(location.hostname);
    const getQuery = () => {
      try {
        const url = new URL(location.href);
        const q = url.searchParams.get('q') || '';
        return decodeURIComponent(q.replace(/\+/g, ' ')).trim();
      } catch { return ''; }
    };
    const isSearchPage = () => {
      const path = location.pathname || '';
      // Typical search paths include /search, /webhp (homepage with q), images etc. We'll key off presence of q
      return !!getQuery();
    };

    if (!isGoogleHost()) return; // Only run this section on Google domains

    let lastQuery = '';
    let debounceTimer = null;

    const maybeSendQuery = () => {
      const q = getQuery();
      if (!q || !isSearchPage()) {
        removeNemoSideHint();
        return;
      }
      if (q === lastQuery) return;
      lastQuery = q;
      // Debounce a bit to avoid rapid re-queries during page hydration
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('🔎 Nemo detected Google query:', q);
        chrome.runtime.sendMessage({ type: 'GOOGLE_SEARCH_QUERY', query: q }, (resp) => {
          // Response will be delivered via a separate GOOGLE_SEARCH_MATCH message to allow background async DB work
        });
      }, 400);
    };

    // Observe URL changes via history API
    const wrapHistory = (method) => {
      const original = history[method];
      return function() {
        const res = original.apply(this, arguments);
        window.dispatchEvent(new Event('nemo-urlchange'));
        return res;
      };
    };
    try {
      history.pushState = wrapHistory('pushState');
      history.replaceState = wrapHistory('replaceState');
    } catch {}

    window.addEventListener('popstate', maybeSendQuery);
    window.addEventListener('nemo-urlchange', maybeSendQuery);
    document.addEventListener('DOMContentLoaded', maybeSendQuery);
    // Initial call
    maybeSendQuery();
  } catch (e) {
    console.warn('Nemo Google listener init failed:', e);
  }
})();

// --- 3) Side hint UI ---
function removeNemoSideHint() {
  const el = document.getElementById('nemo-side-hint');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function renderNemoSideHint(sessionName, sessionId, matchCount) {
  removeNemoSideHint();
  const container = document.createElement('div');
  container.id = 'nemo-side-hint';
  container.style.position = 'fixed';
  container.style.top = '96px';
  container.style.right = '16px';
  container.style.width = '320px';
  container.style.maxWidth = '80vw';
  container.style.background = '#fff';
  container.style.border = '1px solid #dadce0';
  container.style.borderRadius = '10px';
  container.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)';
  container.style.zIndex = '2147483647';
  container.style.fontFamily = 'Arial, sans-serif';
  container.style.color = '#202124';
  container.style.overflow = 'hidden';

  const bar = document.createElement('div');
  bar.style.display = 'flex';
  bar.style.alignItems = 'center';
  bar.style.gap = '8px';
  bar.style.padding = '12px 12px 0 12px';

  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('imgs/logo.png');
  logo.alt = 'NeuMemo';
  logo.style.width = '22px';
  logo.style.height = '22px';
  logo.style.objectFit = 'contain';
  bar.appendChild(logo);

  const title = document.createElement('div');
  title.style.fontSize = '14px';
  title.style.fontWeight = '600';
  title.textContent = 'NeuMemo suggestion';
  bar.appendChild(title);

  const body = document.createElement('div');
  body.style.padding = '8px 12px 12px 12px';
  body.style.fontSize = '13px';
  body.innerHTML = `You searched something similar. It's in the session <b>${escapeHtml(sessionName)}</b>${matchCount ? ` (${matchCount} match${matchCount>1?'es':''})` : ''}.<br/>Open it in a new window?`;

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.padding = '0 12px 12px 12px';

  const openBtn = document.createElement('button');
  openBtn.textContent = 'Open session';
  styleButton(openBtn, '#1a73e8');
  openBtn.onclick = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SESSION_WINDOW', sessionId });
    removeNemoSideHint();
  };

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  styleButton(dismissBtn, '#5f6368');
  dismissBtn.onclick = () => removeNemoSideHint();

  actions.appendChild(openBtn);
  actions.appendChild(dismissBtn);

  container.appendChild(bar);
  container.appendChild(body);
  container.appendChild(actions);
  document.documentElement.appendChild(container);
}

function styleButton(btn, color) {
  btn.style.background = color;
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.borderRadius = '6px';
  btn.style.padding = '8px 12px';
  btn.style.fontSize = '12px';
  btn.style.cursor = 'pointer';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

}