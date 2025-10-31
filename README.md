# NeuMemo (Nemo) — AI-powered session manager for Chrome

NeuMemo saves your browsing sessions by collecting your open tabs, generating concise summaries with Gemini via Firebase AI, and organizing them into named sessions you can search, reopen, and manage later. All data is stored locally in your browser (IndexedDB). No server required.

## Highlights

- One-click “Organize Tabs” to capture all open tabs (title, URL, and text content)
- AI summaries and smart grouping into sessions using Google Gemini through Firebase AI
- Fast on-device “lite” summaries to save cost/tokens; batched and rate-limited
- Semantic search over your saved tabs with relevance scoring
- Helpful Google Search hints: on google.com, Nemo suggests reopening the best-matching past session
- Full viewer UI to browse sessions, create new sessions, move/delete tabs, rename/delete sessions, open an entire session in a new window
- Privacy-first: everything is stored locally; excluded domains are never processed or sent to AI

## How it works (at a glance)

1) Capture content from open tabs and normalize it (content script + background)
2) Reuse historical summaries where possible to avoid AI token costs (history preferred over current for dedupe)
3) Pre-summarize new tabs with a lightweight on-device model (batched) to cut prompt size
4) Ask Gemini to classify only new tabs into sessions and produce searchable summaries
5) Save results in IndexedDB and present them in the viewer UI

## Features in detail

- Session organizer
	- Click the Nemo icon to open `viewer.html` and press the big button to organize your current tabs.
	- Tabs are grouped into sessions with concise summaries. You can create new sessions, move tabs between sessions, rename or delete sessions, and open all tabs in a session in a new window.

- Semantic search
	- Type a query in the viewer’s search box and press Enter. Nemo uses a search-optimized prompt to find the most relevant tabs across all sessions.

- Google Search hints
	- On Google results pages, Nemo inspects your query and, if a strong match exists in your history, shows a small suggestion card to reopen that session.

- Exclude domains (Settings)
	- From the extension options page, add domains (e.g., `example.com`) you don’t want Nemo to process or store.
	- Exclusions apply to future captures and prevent content from being sent to the AI model.

- Performance and cost controls
	- Tunable concurrency, rate limits, and token caps live in `src/config.js`.
	- Historical summaries are reused to minimize token usage.

- Local-first storage
	- All sessions and summaries are stored in your browser’s IndexedDB (`NeuMemoDB`). No external database is used.

## Permissions explained

- `tabs`, `activeTab`, `scripting`, `storage`: capture content from tabs and persist locally
- `host_permissions: *://*/*`: allow reading page content on user-initiated capture

Content scripts run only on Google domains for the search hint feature. The actual capture step is performed by the background service worker on demand when you click “Organize Tabs”

## Project structure

- `src/manifest.json` — Chrome extension manifest (MV3)
- `src/background.js` — Orchestrates tab capture, AI flow, and persistence
- `src/content.js` — Injected into pages to return title/URL/text; also shows Google Search hint
- `src/firebase_ai.js` — Firebase AI + Gemini prompts, schemas, summarization, search
- `src/config.js` — Performance knobs (concurrency, rate limits, token caps)
- `src/viewer.html`, `src/viewer.js`, `src/styles.css` — The sessions UI
- `src/options.html`, `src/options.js` — Exclusion rules UI (domains)
- `vite.config.js` — Vite build tailored for Chrome extensions

## Setup

Prerequisites:
- Node.js 18+ and npm
- A Firebase project with a Web App configured
- Access to Firebase AI with Google AI backend (Gemini). Ensure your project has the feature enabled and billing if required by your tier.

Environment variables:
- Copy `.env.example` to `.env` and fill in the `VITE_FIREBASE_*` values with your Firebase Web App config.
	- These are the typical Firebase web keys (not secrets) exposed to the client by Vite.

Install and build:

```powershell
# From the repo root
npm ci
npm run build
```

Load the extension in Chrome:
1. Open `chrome://extensions/`
2. Enable “Developer mode”
3. Click “Load unpacked” and select the `dist/` folder
4. Pin Nemo and click it to open the viewer

Developer watch mode:

```powershell
npm run dev
```

Then click “Reload” on the Chrome extensions page after builds complete.

## Using Nemo

1. Open the viewer (click the Nemo icon) and press “Organize Tabs”
2. Wait for the overlay to finish (free-tier builds can take ~2–3 minutes)
3. Browse sessions, open a session in a new window, move or delete tabs
4. Create a new session: click “New Session” in the sidebar and give it a name
5. Move a tab to another session: click “Move” on the tab and choose the destination session
6. Search: type your query and press Enter to see the most relevant tabs
7. Settings: on the extension’s Details page, click “Extension options” to add excluded domains

## Configuration knobs (`src/config.js`)

- `injection` — concurrency and timeouts for capturing tab content
- `liteSummary` — batch size, concurrency, RPM, and per-tab token cap for on-device pre-summaries
- `summarize.maxTokens` — overall input token cap for the main prompt
- `search` — batch size, concurrency, and per-tab token cap for semantic search

Tune these if you hit rate limits or want faster/slower processing.

## Privacy

- All data is stored locally in IndexedDB. No server calls are made by the extension itself.
- When you press “Save Session,” Nemo sends content to the AI model (Gemini) through the Firebase AI SDK to generate summaries and groupings.
- Excluded domains are never processed or sent.

## Troubleshooting

- Nothing shows in the viewer
	- Ensure you loaded `dist/` (not `src/`) as the unpacked extension after building.
- Images don’t render
	- Verify files under `src/imgs` are present; on case-sensitive systems, ensure file names match references in code.
- Slow or incomplete AI results
	- Free-tier rate limits can delay responses. Reduce concurrency/RPM in `config.js` or try again later.
- Search returns nothing
	- Ensure you pressed Enter and that you have saved sessions. Try a different keyword.

## Contributing

Issues and PRs are welcome. Please open an issue to discuss larger changes. If you’re adding new UI, keep the existing style and MV3 constraints in mind.

## License

MIT License — see `LICENSE` for details.