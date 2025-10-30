import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";
import { get_encoding } from "tiktoken";

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
        }
    })
});

// --- Prompt Template ---
const promptTemplate = `You are an AI tab session manager.
Your goal is to group tabs into meaningful, thematic sessions.
Analyze the following tabs and group them into logical sessions.
The session names should be descriptive and specific, but not so granular that every tab gets its own session. For example, group tabs about 'React Hooks' and 'State Management' into a session called 'React Development', not just 'Development'.
Assign each tab a \`session_name\` and a factual \`summarized_content\`.
Tabs with the same topic MUST share the same \`session_name\`.
The final output must be only a valid JSON array of objects.

Input tabs:
`;

/**
 * Gets the configuration for the generative model.
 */
const getModelConfig = () => ({
    // Prioritize the cloud model for this large task.
    mode: InferenceMode.PREFER_ON_DEVICE,

    // --- 1. Cloud Model Configuration (Primary) ---
    inCloudParams: {
        model: "gemini-2.5-flash",
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
        model: "gemini-2.0-flash-lite",
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
        model: "gemini-2.0-flash-lite",
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
async function summarizeTabs(tabs, maxTokens = 200000) {
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
        const tabHeader = `\n<NEMO_tab>\nTitle: ${t.title}\nURL: ${t.url}\nContent:\n<CONTENT_START>\n`;
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
            truncatedContent = new TextDecoder().decode(encoding.decode(truncatedTokenSlice));
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

    if (historyTabs.length > 0) {
        if (appendSectionHeader('Existing saved tabs from IndexedDB (previous sessions):')) {
            for (const t of historyTabs) {
                if (!appendTab(t)) break; // Stop if we run out of tokens
            }
        }
    }

    if (currentTabs.length > 0) {
        if (appendSectionHeader('Newly collected open tabs:')) {
            for (const t of currentTabs) {
                if (!appendTab(t)) break; // Stop if we run out of tokens
            }
        }
    }

    console.log(`📊 Prompt includes ${tabsInPrompt} of ${tabs.length} tabs provided.`);
    console.log(`📊 Final prompt token count: ${totalTokens} (Max: ${maxTokens})`);

    // If no tabs could be added, abort.
    if (tabsInPrompt === 0) {
        console.warn("No tabs could be added to the prompt. Aborting AI call.");
        return [];
    }

    const finalPrompt = `${promptTemplate}\n${tabsInput}`;
    
    console.log(`📝 Sending final prompt to AI (${totalTokens} tokens).`);

    const request = {
        contents: [
            { role: 'user', parts: [{ text: finalPrompt }] }
        ]
    };

    try {
        const result = await model.generateContent(request);
        const responseText = result.response.text();
        console.log("🤖 Raw AI Response:", responseText);

        try {
            // With schema enforcement, the response should be valid JSON.
            const parsed = JSON.parse(responseText);
            if (!Array.isArray(parsed)) {
                throw new Error('AI response was not an array');
            }
            return parsed;
        } catch (jsonError) {
            console.error("❌ JSON parsing failed even with schema enforcement.", jsonError.message, "Response was:", responseText);
            return []; 
        }
    } catch (error) {
        console.error("❌ Error during AI content generation.", error);
        // This is often a rate limit (429) or other API error.
        return [];
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
export async function summarizeTabsLiteBatch(tabs, customInstruction = "", perTabMaxTokens = 1000) {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    try {
        // Settings: 5 tabs per request, run up to 5 requests concurrently
        const BATCH_SIZE = 5;
        const CONCURRENCY = 5;

        const encoding = get_encoding("cl100k_base");

        // Helper to build and run a single chunk request
        const summarizeChunk = async (chunkTabs) => {
            let promptParts = [
                "You are a helpful assistant that summarizes multiple web pages.",
                "For each input tab, return JSON ONLY as an array of objects: { url: string, title: string, summary: string }.",
                "Each summary should be substantive and information-dense: 8-15 sentences (~150-300 words). Capture main ideas, sections/topics covered, key insights, important entities/terms, and any conclusions. Keep it factual, neutral, and self-contained. No markdown; plain prose only.",
                "Match each output object's url and title exactly to the input URL and title.",
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
                    ? new TextDecoder().decode(encoding.decode(tokens.slice(0, perTabMaxTokens)))
                    : normalized;
                promptParts.push(
                    `\n<NEMO_tab>\nTitle: ${title}\nURL: ${url}\nContent:\n<CONTENT_START>\n${truncated}\n<CONTENT_END>`
                );
            }

            const request = {
                contents: [ { role: 'user', parts: [{ text: promptParts.join("\n") }] } ]
            };

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

        // Run up to 5 chunk requests at a time
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
export async function searchRelevantTabs(tabs, query, topK = 3, perTabMaxTokens = 200) {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    const BATCH_SIZE = 10;
    const CONCURRENCY = 4;
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
                ? new TextDecoder().decode(encoding.decode(tokens.slice(0, perTabMaxTokens)))
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