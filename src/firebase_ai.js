import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";
import { get_encoding } from "tiktoken";

// TODO(developer) Replace the following with your app's Firebase configuration
// See: https://firebase.google.com/docs/web/learn-more#config-object
// Firebase config moved to environment variables.
// For Vite, expose client env vars with the VITE_ prefix and access them
// via `import.meta.env.VITE_*`. See `.env.example` for variable names.
// Destructure the Vite env vars and use them directly in the config object.
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


// Initialize FirebaseApp
const firebaseApp = initializeApp(firebaseConfig);
// Initialize the Gemini Developer API backend service
const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });

// The model will return an ARRAY of tab objects. Each item follows the
// structure defined below.
const responseSchema = Schema.array({
    items: Schema.object({
        properties: {
            tab_id: Schema.string(),
            language: Schema.string(),
            title: Schema.string(),
            summarized_content: Schema.string(),
            tags: Schema.array({ items: Schema.string() }),
            main_class: Schema.string(),
            classes: Schema.array({ items: Schema.string() })
        }
    })
});
// Create a `GenerativeModel` instance (lazy-created/re-creatable)
// Set the mode, for example to use on-device model when possible
let model = getGenerativeModel(ai,
    {
        mode: InferenceMode.PREFER_ON_DEVICE,
        model: "gemini-2.5-pro",
        // In the generation config, set the `responseMimeType` to `application/json`
        // and pass the JSON schema object into `responseSchema`.
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema
        },
    });

function recreateModel() {
    // Recreate the generative model instance. Useful if the previous
    // execution session was destroyed or otherwise became invalid.
    model = getGenerativeModel(ai,
        {
            mode: InferenceMode.PREFER_ON_DEVICE,
            model: "gemini-2.5-pro",
            // In the generation config, set the `responseMimeType` to `application/json`
            // and pass the JSON schema object into `responseSchema`.
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema
            },
        });
}

// Imports + initialization of FirebaseApp and backend service + creation of model instance

// Wrap in an async function so you can use await
async function run() {
    // Provide a prompt that contains text
    const prompt = "Write a story about a magic backpack."

    // To generate text output, call `generateContent` with a properly shaped
    // request object. Use a contents array with a user role and parts array so
    // on-device checks won't fail (they expect `parts` to be iterable).
    const request = {
        contents: [
            {
                role: 'user',
                parts: [{ text: prompt }]
            }
        ]
    };

    const result = await model.generateContent(request);

    const response = result.response;
    const text = response.text();
    console.log(text);
}

import { getEncoding } from "tiktoken";

// ... existing code ...

// Summarize multiple tabs at once. `tabs` must be an array of objects
// with { title, url, content }.
async function summarizeTabs(tabs, maxTokens = 1000000) {
    if (!Array.isArray(tabs)) {
        throw new Error('summarizeTabs expects an array of tabs');
    }

    const encoding = get_encoding("cl100k_base");

    const basePrompt = `Task: You are a session manager AI for browser tabs.

Input:
You will receive multiple tabs separated by the token <tab>.  
Each tab includes its:
- Title  
- URL  
- Document body inner text (page content)

Goal:
Analyze each tab separately and return a JSON array of tab objects.

Each tab object must follow this structure:
{
  "tab_id": "url",
  "language": <detected_language>,
  "title": "<page_title>",
  "summarized_content": <short_summary_of_page_topic>,
  "tags": <list_of_relevant_keywords>,
  "main_class": <main_generic_class e.g. "technology", "politics", "social", "shopping", "education", "entertainment", "health", "finance">,
  "classes": <list_of_additional_related_classes>
}

Rules:
- Detect the tab’s main language and use it for all generated values.  
- Summaries should be concise (2–3 sentences max) and reflect the core topic.  
- Tags: 3–8 short, meaningful words for search or categorization.  
- main_class: one generic high-level topic.  
- classes: optional broader or related groups.  
- Output only valid JSON (no extra text, explanations, or <tab> markers).  
- Each tab is independent — don’t merge data across tabs.

Example Input:
`;

    let tabsInput = '';
    let totalTokens = encoding.encode(basePrompt).length;

    for (const t of tabs) {
        const tabHeader = `\n<tab>\nTitle: ${t.title}\nURL: ${t.url}\nContent: `;
        const headerTokens = encoding.encode(tabHeader).length;
        
        if (totalTokens + headerTokens > maxTokens) {
            console.warn('Skipping a tab as the prompt is already too large for more tabs.');
            break; // No more space for even a header
        }

        let availableTokens = maxTokens - totalTokens - headerTokens;
        let contentTokens = encoding.encode(t.content || '');
        
        let truncatedContent;
        if (contentTokens.length > availableTokens) {
            truncatedContent = new TextDecoder().decode(encoding.decode(contentTokens.slice(0, availableTokens)));
            console.warn(`Content for tab ${t.url} was truncated to fit within the token limit.`);
        } else {
            truncatedContent = t.content || '';
        }

        const finalTabString = `${tabHeader}${truncatedContent}`;
        tabsInput += finalTabString;
        totalTokens += encoding.encode(finalTabString).length;
    }

    const prompt = `${basePrompt}${tabsInput}\n\nPlease output ONLY the JSON array of tab objects (no surrounding text).`;

    const request = {
        contents: [
            { role: 'user', parts: [{ text: prompt }] }
        ]
    };

    const result = await model.generateContent(request);
    let responseText = result.response.text();
    const cleaned = responseText.trim().replace(/^```json/, '').replace(/```$/,'').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
        throw new Error('AI response was not an array');
    }

    // Persist only the AI outputs (the array of tab objects) into IndexedDB
    await saveSummariesToIndexedDB(parsed);

    return parsed;
}

// Persist summaries to IndexedDB under database 'neumemo' and store 'tab_summaries'
function saveSummariesToIndexedDB(summaries) {
    return new Promise((resolve, reject) => {
        const openReq = indexedDB.open('neumemo', 1);
        openReq.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains('tab_summaries')) {
                db.createObjectStore('tab_summaries', { keyPath: 'tab_id' });
            }
        };
        openReq.onsuccess = (ev) => {
            const db = ev.target.result;
            const tx = db.transaction('tab_summaries', 'readwrite');
            const store = tx.objectStore('tab_summaries');
            for (const item of summaries) {
                // Only save the AI output object (assumed to follow schema)
                try {
                    store.put(item);
                } catch (e) {
                    // continue storing others; errors handled by transaction.onerror
                    console.warn('Failed to put item', item, e);
                }
            }
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = (e) => { reject(tx.error || e); };
        };
        openReq.onerror = (e) => reject(e);
    });
}

// NOTE: do not auto-run the sample on module load. Extensions have strict
// CSP and running the model on load can cause unexpected API calls and
// errors (for example: missing output language). Call `run()` from the UI
// or expose it on window for manual invocation during development.
// Example (from viewer.js):
// import { run } from './firebase_ai.js';
// document.getElementById('generate').addEventListener('click', run);

export { run };
export { summarizeTabs };
export { recreateModel };
