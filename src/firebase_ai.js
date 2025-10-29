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
Analyze the following tabs and group them into logical sessions.
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
    mode: InferenceMode.PREFER_IN_CLOUD,

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
        const encoding = get_encoding("cl100k_base");
        let promptParts = [
            "You are a helpful assistant that summarizes multiple web pages.",
            "For each input tab, return JSON ONLY as an array of objects: { url: string, title: string, summary: string }.",
            "Each summary should be concise, factual, 4-8 sentences, no markdown, no lists unless necessary.",
            "Match each output object's url and title exactly to the input URL and title.",
        ];

        if (customInstruction) {
            promptParts.push(customInstruction);
        }

        promptParts.push("Input tabs follow with delimiters; do not include the inputs in your output.");

        for (const t of tabs) {
            const title = t?.title || "Untitled";
            const url = t?.url || "";
            const normalized = normalizeContent(t?.content || "");
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
        // Ensure minimal shape and dedupe by URL (last wins)
        const byUrl = new Map();
        for (const item of parsed) {
            if (item && typeof item.url === 'string') {
                byUrl.set(item.url, {
                    url: item.url,
                    title: typeof item.title === 'string' ? item.title : "Untitled",
                    summary: typeof item.summary === 'string' ? item.summary : "",
                });
            }
        }
        return Array.from(byUrl.values());
    } catch (e) {
        console.warn("Lite batch summarization failed:", String(e));
        return [];
    }
}

// Backwards-compat: single-tab helper using the batch function
export async function summarizeTabLite(tab, perTabMaxTokens = 1000) {
    const res = await summarizeTabsLiteBatch([tab], perTabMaxTokens);
    return res[0]?.summary || "";
}