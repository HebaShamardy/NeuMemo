import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";
import { get_encoding } from "tiktoken";
import { config } from "./config.js";

// --- Utilities ---
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Simple per-minute rate limiter with atomic acquire via an internal mutex
class RateLimiter {
    constructor(rpm, windowMs = 60_000) {
        this.rpm = rpm;
        this.windowMs = windowMs;
        this.timestamps = [];
        this._mutex = Promise.resolve();
    }
    async acquire() {
        // Serialize acquisition to avoid race conditions on timestamps
        let proceed;
        this._mutex = this._mutex.then(async () => {
            while (true) {
                const now = Date.now();
                // Drop entries outside the window
                this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
                if (this.timestamps.length < this.rpm) {
                    // Reserve a slot and proceed
                    this.timestamps.push(now);
                    break;
                }
                const waitMs = this.windowMs - (now - this.timestamps[0]);
                if (waitMs > 0) {
                    await sleep(waitMs);
                }
            }
        });
        await this._mutex;
    }
}

// --- Firebase Configuration ---
const {
  VITE_FIREBASE_API_KEY: apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: authDomain,
  VITE_FIREBASE_PROJECT_ID: projectId,
  VITE_FIREBASE_STORAGE_BUCKET: storageBucket,
  VITE_FIREBASE_MESSAGING_SENDER_ID: messagingSenderId,
  VITE_FIREBASE_APP_ID: appId,
  VITE_FIREBASE_MEASUREMENT_ID: measurementId
} = import.meta.env;

const firebaseConfig = { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, measurementId };

// --- AI Initialization ---
const firebaseApp = initializeApp(firebaseConfig);
const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });

// --- Response Schema Definition ---
const responseSchema = Schema.array({
    items: Schema.object({
        properties: {
            tab_id: Schema.string(),
            session_name: Schema.string(),
            summarized_content: Schema.string(),
            // Optional: session id for mapping to DB; use null/omitted when creating a new session
            session_id: Schema.number(),
        }
    })
});

// --- Prompt Template ---
const promptTemplate = `You are an AI session classifier.
Task: Only classify NEW tabs into sessions and summarize ONLY the new tabs.

Existing sessions (from history) are immutable: do not rename, merge, or recreate them. If a new tab clearly belongs to one of the existing sessions, assign it to that session and use the exact session_name and session_id provided. If no existing session fits, propose a new session by providing a specific, descriptive session_name and OMIT the session_id field.

Output JSON ONLY as an array of objects with this exact shape:
{ tab_id: string, session_name: string, summarized_content: string, session_id?: number }

Rules:
- Do not include historical tabs in the output (they are already stored). Output objects ONLY for the new tabs provided below.
- Set tab_id EXACTLY to the tab's URL from the input.
- For assignment to existing sessions, copy session_name exactly as shown and set session_id to that numeric id.
- For a new session, choose a new session_name (not generic), and omit session_id entirely (do not include null or 0).
- summarized_content: a factual summary that captures the main ideas and sections/topics covered, key entities/terms, and important facts. Make it searchable later by including concrete terms and section-level themes. Limit to a maximum of 500 words. Plain text only; no markdown.
`;

/**
 * Gets the configuration for the generative model.
 */
const getModelConfig = () => ({
    // Prioritize the cloud model for this large task.
    mode: InferenceMode.PREFER_IN_CLOUD,

    // --- 1. Cloud Model Configuration (Primary) ---
    inCloudParams: {
        model: "gemini-2.5-pro",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0,
            maxOutputTokens: 65000,
            candidateCount: 1,
        },
    },

    // --- 2. On-Device Model Configuration (Fallback) ---
    onDeviceParams: {
        promptOptions: {
            responseConstraint: responseSchema,
        },
        createOptions: {
            temperature: 0,
        }
    }
});

// Create a `GenerativeModel` instance
let model = getGenerativeModel(ai, getModelConfig());

// --- Lite Model Config & Instance (for per-tab pre-summaries) ---
const liteResponseSchema = Schema.array({
    items: Schema.object({
        properties: {
            url: Schema.string(),
            title: Schema.string(),
            summary: Schema.string(),
        }
    })
});

const getLiteModelConfig = () => ({
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
        model: "gemini-2.5-flash-lite",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: liteResponseSchema,
            temperature: 0,
            maxOutputTokens: 2048,
            candidateCount: 1,
        },
    },
    onDeviceParams: {
        // Enforce JSON shape on-device as well
        promptOptions: {
            responseConstraint: liteResponseSchema,
        },
        // Keep it deterministic
        createOptions: { temperature: 0 },
    }
});

let liteModel = getGenerativeModel(ai, getLiteModelConfig());
// Global limiter for lite-model requests (configurable RPM)
const liteLimiter = new RateLimiter(config.liteSummary.rpm, 60_000);

// --- Search-specific schema & model (separate from summarization) ---
const searchResponseSchema = Schema.array({
    items: Schema.object({
        properties: {
            url: Schema.string(),
            title: Schema.string(),
            summary: Schema.string(),
            score: Schema.number(),
        }
    })
});

const getSearchModelConfig = () => ({
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
        model: "gemini-2.5-flash-lite",
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: searchResponseSchema,
            temperature: 0,
            maxOutputTokens: 1024,
            candidateCount: 1,
        },
    },
    onDeviceParams: {
        promptOptions: {
            responseConstraint: searchResponseSchema,
        },
        createOptions: { temperature: 0 },
    }
});

let searchModel = getGenerativeModel(ai, getSearchModelConfig());

/**
 * Recreates the generative model instance.
 */
function recreateModel() {
    model = getGenerativeModel(ai, getModelConfig());
}

/**
 * Cleans up raw text content from a tab to reduce token count.
 * @param {string} content - The raw string content.
 * @returns {string} - The normalized content.
 */
function normalizeContent(content) {
    if (!content) {
        return '';
    }
    let cleanedContent = content.trim();

    // 1. Replace multiple newlines (3 or more) with just two (a single paragraph break).
    cleanedContent = cleanedContent.replace(/(\r\n|\r|\n){3,}/g, '\n\n');

    // 2. Replace multiple spaces/tabs with a single space.
    cleanedContent = cleanedContent.replace(/[ \t]{2,}/g, ' ');

    // 3. Remove spaces/tabs at the beginning of new lines.
    cleanedContent = cleanedContent.replace(/^[ \t]+/gm, '');

    return cleanedContent;
}

/**
 * Sends a list of tabs to the AI model for summarization and session grouping.
 * @param {Array<Object>} tabs - An array of tab objects.
 * @param {number} [maxTokens=120000] - Max INPUT tokens for the prompt.
 * NOTE: This is a safety rail to prevent hitting the absolute max.
 * The cloud model (2.5 Pro) has a large limit, but being slightly
 * under is safer and avoids rate limit errors.
 */
async function summarizeTabs(tabs, maxTokens = config.summarize.maxTokens) {
    if (!Array.isArray(tabs)) {
        throw new Error('summarizeTabs expects an array of tabs');
    }

    const encoding = get_encoding("cl100k_base");

    let tabsInput = '';
    let tabsInPrompt = 0;
    // Get token cost of the base prompt
    let totalTokens = encoding.encode(promptTemplate).length;

    // Partition into history vs current
    const historyTabs = tabs.filter(t => t && t.source === 'history');
    const currentTabs = tabs.filter(t => !t || t.source !== 'history');

    // Build existing sessions catalog from history tabs
    const sessionsById = new Map(); // id -> { id, name, urls: [] }
    for (const t of historyTabs) {
        const sid = typeof t.sessionId === 'number' ? t.sessionId : undefined;
        const sname = t.sessionName || 'Uncategorized';
        if (sid !== undefined) {
            if (!sessionsById.has(sid)) sessionsById.set(sid, { id: sid, name: sname, urls: [] });
            const bucket = sessionsById.get(sid);
            if (t.url) bucket.urls.push(t.url);
        }
    }

    const appendSectionHeader = (text) => {
        const header = `\n${text}\n`;
        const cost = encoding.encode(header).length;
        if (totalTokens + cost <= maxTokens) {
            tabsInput += header;
            totalTokens += cost;
            return true;
        }
        return false;
    };

    const appendTab = (t) => {
        const tabHeader = `\n<NEMO_tab>\nID: ${t.url}\nTitle: ${t.title}\nURL: ${t.url}\nContent:\n<CONTENT_START>\n`;
        const tabFooter = `\n<CONTENT_END>`;
        
        // Calculate tokens for header and footer
        const headerTokens = encoding.encode(tabHeader).length;
        const footerTokens = encoding.encode(tabFooter).length;
        const wrapperTokens = headerTokens + footerTokens;

        if (totalTokens + wrapperTokens > maxTokens) {
            console.warn('Skipping tab: Not enough space for tab header/footer.');
            return false; // Cannot add more, not even the header
        }
        
        // Calculate available tokens for the content itself
        let availableTokens = maxTokens - totalTokens - wrapperTokens;
        
        // Normalize content *first*
        const normalizedContent = normalizeContent(t.content);
        let contentTokens = encoding.encode(normalizedContent);

        let truncatedContent;
        if (contentTokens.length > availableTokens) {
            // Truncate the tokens and then decode
            const truncatedTokenSlice = contentTokens.slice(0, availableTokens);
            // encoding.decode returns a string; no TextDecoder needed
            truncatedContent = encoding.decode(truncatedTokenSlice);
            console.warn(`Content for tab ${t.url} was truncated to fit within the token limit.`);
        } else {
            truncatedContent = normalizedContent;
        }

        const finalTabString = `${tabHeader}${truncatedContent}${tabFooter}`;
        const finalTabTokens = encoding.encode(finalTabString).length;

        // Final check: In rare cases, encoding(header) + encoding(truncated) might be
        // slightly different from encoding(header + truncated).
        if (totalTokens + finalTabTokens > maxTokens) {
             console.warn(`Skipping tab ${t.url} due to final token check mismatch.`);
             return false;
        }

        tabsInput += finalTabString;
        totalTokens += finalTabTokens;
        tabsInPrompt++;
        return true;
    };

    // 1) Describe existing sessions briefly (ids, names, sample URLs) — we don't include history content to save tokens
    if (sessionsById.size > 0) {
        const headerOk = appendSectionHeader('Existing sessions (immutable):');
        if (headerOk) {
            for (const sess of sessionsById.values()) {
                // limit sample URLs to avoid token bloat
                const sample = sess.urls.slice(0, 5).join('\n- ');
                const block = `\n<SESSION>\nID: ${sess.id}\nName: ${sess.name}\nKnown URLs (sample):\n- ${sample}`;
                const cost = encoding.encode(block).length;
                if (totalTokens + cost <= maxTokens) {
                    tabsInput += block;
                    totalTokens += cost;
                } else {
                    break;
                }
            }
        }
    }

    // 2) Include only NEW tabs for classification/summarization
    if (currentTabs.length > 0) {
        if (appendSectionHeader('Newly collected open tabs (to classify and summarize):')) {
            for (const t of currentTabs) {
                if (!appendTab(t)) break; // Stop if we run out of tokens
            }
        }
    }

    console.log(`📊 Prompt includes ${tabsInPrompt} of ${tabs.length} tabs provided.`);
    console.log(`📊 Final prompt token count: ${totalTokens} (Max: ${maxTokens})`);

    // If no new tabs could be added, return passthrough of historical with no AI call
    if (tabsInPrompt === 0) {
        console.warn("No tabs could be added to the prompt. Aborting AI call.");
        // Return existing history as-is so downstream reconciliation doesn't delete them
        return historyTabs.map(h => ({
            tab_id: h.url,
            session_name: h.sessionName || 'Uncategorized',
            summarized_content: h.content || '',
            session_id: typeof h.sessionId === 'number' ? h.sessionId : null,
        }));
    }

    const finalPrompt = `${promptTemplate}\n${tabsInput}`;
    // Log the full final prompt for debugging/inspection
    try {
        console.log("📝 finalPrompt:\n" + finalPrompt);
    } catch {}
    console.log(`📝 Sending final prompt to AI (${totalTokens} tokens).`);

    const request = {
        contents: [
            { role: 'user', parts: [{ text: finalPrompt }] }
        ]
    };

    // Helper: retry cloud call when aborted/timeouts occur
    const callWithRetry = async (req, attempts = 2) => {
        let lastErr;
        for (let i = 0; i <= attempts; i++) {
            try {
                return await model.generateContent(req);
            } catch (error) {
                const msg = String(error?.message || error || '');
                const isAbort = /aborted|AbortError|The user aborted a request/i.test(msg);
                if (isAbort && i < attempts) {
                    const backoffMs = 1200 * (i + 1);
                    console.warn(`AI call aborted; retrying in ${backoffMs}ms (attempt ${i + 2}/${attempts + 1})`);
                    await sleep(backoffMs);
                    continue;
                }
                lastErr = error;
                break;
            }
        }
        throw lastErr;
    };

    try {
        const result = await callWithRetry(request, 2);
        // Log which inference source was used by the model (cloud vs on-device)
        try {
            console.log('You used: ' + (result?.response?.inferenceSource || 'unknown'));
        } catch {}
        const responseText = result.response.text();
        console.log("🤖 Raw AI Response:", responseText);

        try {
            // With schema enforcement, the response should be valid JSON.
            const parsed = JSON.parse(responseText);
            if (!Array.isArray(parsed)) {
                throw new Error('AI response was not an array');
            }
            // Merge: pass-through all history tabs, and append AI results for new tabs
            const passthrough = historyTabs.map(h => ({
                tab_id: h.url,
                session_name: h.sessionName || 'Uncategorized',
                summarized_content: h.content || '',
                session_id: typeof h.sessionId === 'number' ? h.sessionId : null,
            }));
            return [...passthrough, ...parsed];
        } catch (jsonError) {
            console.error("❌ JSON parsing failed even with schema enforcement.", jsonError.message, "Response was:", responseText);
            // Fallback: if AI part fails, at least return historical
            return historyTabs.map(h => ({
                tab_id: h.url,
                session_name: h.sessionName || 'Uncategorized',
                summarized_content: h.content || '',
                session_id: typeof h.sessionId === 'number' ? h.sessionId : null,
            })); 
        }
    } catch (error) {
        console.error("❌ Error during AI content generation.", error);
        // This is often a rate limit (429) or other API error.
        // Return historical only to avoid data loss downstream
        return historyTabs.map(h => ({
            tab_id: h.url,
            session_name: h.sessionName || 'Uncategorized',
            summarized_content: h.content || '',
            session_id: typeof h.sessionId === 'number' ? h.sessionId : null,
        }));
    }
}

export { summarizeTabs };
export { recreateModel };

/**
 * Quickly summarizes a single tab's content using the lite model to save tokens.
 * Returns a short plain-text summary. If it fails, returns an empty string.
 * @param {{title: string, url: string, content: string}} tab
 * @param {number} [maxInputTokens=6000] - Max input tokens passed to the lite model
 */
export async function summarizeTabsLiteBatch(tabs, customInstruction = "", perTabMaxTokens = config.liteSummary.perTabMaxTokens) {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    try {
    // Settings driven by config
    const BATCH_SIZE = config.liteSummary.batchSize;
    const CONCURRENCY = config.liteSummary.concurrency;

        const encoding = get_encoding("cl100k_base");

        // Helper to build and run a single chunk request
        const summarizeChunk = async (chunkTabs) => {
            let promptParts = [
                "You are a helpful assistant that summarizes multiple web pages.",
                "For each input tab, return JSON ONLY as an array of objects: { url: string, title: string, summary: string }.",
                    "Each summary must be factual and information-dense, capturing the main ideas and section-level topics, key entities/terms, and important facts so it can be searched later. Limit each summary to a maximum of 500 words. Keep it neutral and self-contained. Plain text only; no markdown.",
                "Match each output object's url and title exactly to the input URL and title.",
                "Strict formatting: Output must be valid RFC 8259 JSON.",
            ];

            if (customInstruction) {
                promptParts.push(String(customInstruction));
            }

            promptParts.push("Input tabs follow with delimiters; do not include the inputs in your output.");

            for (const t of chunkTabs) {
                const title = t?.title || "Untitled";
                const url = t?.url || "";
                const normalized = normalizeContent(t?.content || t?.summary || "");
                const tokens = encoding.encode(normalized);
                const truncated = tokens.length > perTabMaxTokens
                    ? encoding.decode(tokens.slice(0, perTabMaxTokens))
                    : normalized;
                promptParts.push(
                    `\n<NEMO_tab>\nTitle: ${title}\nURL: ${url}\nContent:\n<CONTENT_START>\n${truncated}\n<CONTENT_END>`
                );
            }

            const request = {
                contents: [ { role: 'user', parts: [{ text: promptParts.join("\n") }] } ]
            };

            // Respect rate limit before issuing the request
            await liteLimiter.acquire();
            const result = await liteModel.generateContent(request);
            const text = (result?.response?.text?.() || "").trim();
            let parsed;
            try {
                parsed = JSON.parse(text);
                if (!Array.isArray(parsed)) throw new Error("Lite response was not an array");
            } catch (e) {
                console.error("❌ Lite JSON parsing failed.", e?.message, "Response was:", text);
                return [];
            }
            // Ensure minimal shape
            return parsed
                .filter(Boolean)
                .map(item => ({
                    url: typeof item.url === 'string' ? item.url : "",
                    title: typeof item.title === 'string' ? item.title : "Untitled",
                    summary: typeof item.summary === 'string' ? item.summary : "",
                }))
                .filter(x => x.url);
        };

        // Small input optimization: single request path
        if (tabs.length <= BATCH_SIZE) {
            return await summarizeChunk(tabs);
        }

        // Split into chunks of 5
        const chunks = [];
        for (let i = 0; i < tabs.length; i += BATCH_SIZE) {
            chunks.push(tabs.slice(i, i + BATCH_SIZE));
        }

        // Concurrency-limited mapper
        const mapWithConcurrency = async (items, concurrency, mapper) => {
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

    // Run up to CONCURRENCY chunk requests at a time
        const chunkResults = await mapWithConcurrency(chunks, CONCURRENCY, summarizeChunk);

        // Flatten and dedupe by URL (last wins)
        const byUrl = new Map();
        for (const arr of chunkResults) {
            for (const item of (arr || [])) {
                byUrl.set(item.url, item);
            }
        }

        // Return results in the same order as input tabs (by URL), skipping missing
        const ordered = [];
        for (const t of tabs) {
            const found = t?.url ? byUrl.get(t.url) : undefined;
            if (found) ordered.push(found);
        }
        return ordered;
    } catch (e) {
        console.warn("Lite batch summarization failed:", String(e));
        return [];
    }
}

// Backwards-compat: single-tab helper using the batch function
export async function summarizeTabLite(tab, perTabMaxTokens = 1000) {
    const res = await summarizeTabsLiteBatch([tab], "", perTabMaxTokens);
    return res[0]?.summary || "";
}

/**
 * Search for the most relevant tabs to a user query using a dedicated prompt and schema.
 * Returns 0..topK items globally, aggregated across chunks with scores.
 * @param {Array<{title:string,url:string,content?:string,summary?:string}>} tabs
 * @param {string} query
 * @param {number} [topK=3]
 * @param {number} [perTabMaxTokens=200]
 */
export async function searchRelevantTabs(tabs, query, topK = 3, perTabMaxTokens = config.search.perTabMaxTokens) {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    const BATCH_SIZE = config.search.batchSize;
    const CONCURRENCY = config.search.concurrency;
    const encoding = get_encoding("cl100k_base");

    const buildPromptForChunk = (chunkTabs) => {
        const parts = [];
        parts.push(
            "You are a retrieval assistant.",
            `User query: "${query}"`,
            "Select the most relevant tabs to answer the user's information need.",
            "Return JSON ONLY as an array of up to K objects with: { url: string, title: string, summary: string, score: number }.",
            "Constraints:",
            "- K = " + Math.min(topK, 3),
            "- score is in [0.0, 1.0], where 1.0 is a perfect semantic match.",
            "- Sort results by score descending.",
            "- If none are relevant, return an empty array [].",
            "- summary: 1-3 sentences explaining the relevant content of the tab (plain text).",
            "Input tabs follow with delimiters; do not include the inputs themselves in your output."
        );

        for (const t of chunkTabs) {
            const title = t?.title || "Untitled";
            const url = t?.url || "";
            const normalized = normalizeContent(t?.content || t?.summary || "");
            const tokens = encoding.encode(normalized);
            const truncated = tokens.length > perTabMaxTokens
                ? encoding.decode(tokens.slice(0, perTabMaxTokens))
                : normalized;
            parts.push(`\n<NEMO_tab>\nTitle: ${title}\nURL: ${url}\nContent:\n<CONTENT_START>\n${truncated}\n<CONTENT_END>`);
        }
        return parts.join("\n");
    };

    const runChunk = async (chunkTabs) => {
        const request = {
            contents: [{ role: 'user', parts: [{ text: buildPromptForChunk(chunkTabs) }] }]
        };
        try {
            const result = await searchModel.generateContent(request);
            const text = (result?.response?.text?.() || "").trim();
            let parsed;
            try {
                parsed = JSON.parse(text);
                if (!Array.isArray(parsed)) throw new Error("Search response was not an array");
            } catch (e) {
                console.error("❌ Search JSON parsing failed.", e?.message, "Response was:", text);
                return [];
            }
            return parsed
                .filter(Boolean)
                .map(item => ({
                    url: typeof item.url === 'string' ? item.url : "",
                    title: typeof item.title === 'string' ? item.title : "Untitled",
                    summary: typeof item.summary === 'string' ? item.summary : "",
                    score: typeof item.score === 'number' ? item.score : 0,
                }))
                .filter(x => x.url);
        } catch (e) {
            console.warn("Search chunk failed:", String(e));
            return [];
        }
    };

    // If small, single request
    if (tabs.length <= BATCH_SIZE) {
        const results = await runChunk(tabs);
        return results.sort((a,b) => (b.score||0) - (a.score||0)).slice(0, topK);
    }

    // Chunk and aggregate top candidates across chunks
    const chunks = [];
    for (let i = 0; i < tabs.length; i += BATCH_SIZE) {
        chunks.push(tabs.slice(i, i + BATCH_SIZE));
    }

    const mapWithConcurrency = async (items, concurrency, mapper) => {
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

    const chunkResults = await mapWithConcurrency(chunks, CONCURRENCY, runChunk);
    const byUrl = new Map();
    for (const arr of chunkResults) {
        for (const r of (arr || [])) {
            const existing = byUrl.get(r.url);
            if (!existing || (r.score || 0) > (existing.score || 0)) {
                byUrl.set(r.url, r);
            }
        }
    }

    return Array.from(byUrl.values())
        .sort((a,b) => (b.score||0) - (a.score||0))
        .slice(0, topK);
}