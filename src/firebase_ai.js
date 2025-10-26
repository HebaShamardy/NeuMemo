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


// ... existing code ...

async function summarizeTabs(tabs, maxTokens = 1000000) {
    if (!Array.isArray(tabs)) {
        throw new Error('summarizeTabs expects an array of tabs');
    }

    const encoding = get_encoding("cl100k_base");

    let tabsInput = '';
    let tabsInPrompt = 0;
    
    // First, calculate how many tabs can fit and build the input string.
    // We start with a temporary token count for the prompt that will be added later.
    const promptTemplate = `Task: You are a session manager AI for browser tabs.

Input:
You will receive TABS_COUNT tabs separated by the token <NEMO_tab>.  
Each tab includes its:
- Title  
- URL  
- Document body inner text (page content)

Goal:
Analyze each tab separately and return a JSON array containing exactly TABS_COUNT tab objects.

Each tab object must follow this structure:
{
  "tab_id": "url",
  "language": <detected_language>,
  "title": "<page_title>",
  "summarized_content": <detailed_summary_representing_all_major_topics_and_sections_of_the_page>,
  "tags": <list_of_relevant_keywords>,
  "main_class": <main_generic_class e.g. "technology", "politics", "social", "shopping", "education", "entertainment", "health", "finance">,
  "classes": <list_of_additional_related_classes>
}

Rules:
- Detect the main language of each tab and generate all values in that language.
- The "summarized_content" must reflect **all key sections** and **informational points** from the tab (not just a short overview).
  - Capture the purpose, structure, instructions, and main ideas of the page.
  - Prioritize factual and topic-rich information over navigation or UI text.
  - Keep it readable, factual, and ready for later full-text search or recall.
- Tags: 5–10 short, meaningful keywords relevant for future retrieval.
- main_class: one broad category representing the tab’s main domain.
- classes: additional topical or contextual categories (e.g. “developer docs”, “AI tools”, “reference guide”).
- Output only valid JSON — no explanations, no <tab> markers, no prose outside JSON.
- Each tab is processed independently.

In the end, re-check the correctness of the JSON structure and ensure it matches the specified schema exactly.
`;
    // A rough estimation for the prompt template itself, excluding the tabs content.
    // This is not perfect but gives us a buffer.
    let totalTokens = encoding.encode(promptTemplate).length;


    for (const t of tabs) {
        const tabHeader = `\n<NEMO_tab>\nTitle: ${t.title}\nURL: ${t.url}\nContent: `;
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
        tabsInPrompt++;
    }

    console.log(`📊 Prompt includes ${tabsInPrompt} of ${tabs.length} tabs provided.`);
    console.log(`📊 Final prompt token count: ${totalTokens}`);

    // Now, construct the final prompt with the exact number of tabs.
    const finalPrompt = `${promptTemplate.replace(/TABS_COUNT/g, tabsInPrompt)}${tabsInput}\n\nPlease output ONLY the JSON array of tab objects (no surrounding text).`;

    // console.log("📝 Full AI Request Prompt:", finalPrompt);

    const request = {
        contents: [
            { role: 'user', parts: [{ text: finalPrompt }] }
        ]
    };

    const result = await model.generateContent(request);
    let responseText = result.response.text();
    const cleaned = responseText.trim().replace(/^```json/, '').replace(/```$/,'').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
        throw new Error('AI response was not an array');
    }

    return parsed;
}

// NOTE: do not auto-run the sample on module load. Extensions have strict
// CSP and running the model on load can cause unexpected API calls and
// errors (for example: missing output language). Call `run()` from the UI
// or expose it on window for manual invocation during development.
// Example (from viewer.js):
// import { run } from './firebase_ai.js';
// document.getElementById('generate').addEventListener('click', run);

export { summarizeTabs };
export { recreateModel };
