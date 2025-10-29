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
                        title: Schema.string(),
                        session_name: Schema.string(),
                        summarized_content: Schema.string(),
                }
        })
});
const promptTemplate = `You're an AI session manager for browser tabs.

You will receive multiple website tabs as input.  
Each tab is separated by the token <NEMO_tab> and includes:
- url
- title
- content (the webpage text or body)

Your goal:
1. Analyze all tabs together to detect related topics or user intents.
2. **Group related tabs into shared sessions** — tabs discussing the same subject, product, technology, or goal must share the same session name.
   - Merge closely related topics under one common \`session_name\`.
   - Prefer reusing concise session names instead of creating new ones.
   - Example: Tabs about Gemini API, Prompt API, and Firebase AI Logic can all share a session like “Gemini and Chrome AI Development.”
3. Assign each tab to the most relevant \`session_name\`.
4. Generate a **detailed factual summary** that captures important concepts, sections, or highlights for future search use.

### Output format (strict JSON array):
[
  {
    "tab_id": "<url>",
    "session_name": "<shared_topic_or_goal>",
    "summarized_content": "<informative summary capturing key ideas and sections>"
  },
  ...
]

### Output rules:
- Output only valid JSON that parses with JSON.parse.
- Tabs covering the same topic or workflow **must share the same session_name**.
- Summaries should capture meaningful sections and important context (3–6 sentences).
- Be factual, structured, and concise.

### Strict formatting requirements:
- Respond with ONLY a single JSON array. No prose, no explanations, no markdown, no code fences.
- Escape internal double quotes in string values.
- Do not include trailing commas.
- Ensure the final character of the response is a closing bracket: "]".
- Before sending your answer, silently self-check that the JSON is complete and valid.
- Delimit your final output by writing exactly this token before and after the JSON:
    <<<JSON_START>>>
    [ ... JSON array ... ]
    <<<JSON_END>>>
Return only those three lines (marker, JSON array, marker).`;

const getModelConfig = () => ({
    mode: InferenceMode.PREFER_ON_DEVICE,
    model: "gemini-2.5-pro",
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        // Use a low temperature for predictable, structured JSON output.
        temperature: 0.2,
        topP: 1.0,
        // Allow a large enough output to avoid truncation mid-JSON.
        maxOutputTokens: 65000,
        candidateCount: 1,
    },
});

// Create a `GenerativeModel` instance (lazy-created/re-creatable)
let model = getGenerativeModel(ai, getModelConfig());

function recreateModel() {
    // Recreate the generative model instance. Useful if the previous
    // execution session was destroyed or otherwise became invalid.
    model = getGenerativeModel(ai, getModelConfig());
}

// Imports + initialization of FirebaseApp and backend service + creation of model instance


// ... existing code ...

function normalizeContent(content) {
    if (!content) {
        return '';
    }
    // Trim leading/trailing whitespace.
    let cleanedContent = content.trim();

    // Replace multiple newlines (3 or more) with just two.
    cleanedContent = cleanedContent.replace(/(\r\n|\r|\n){3,}/g, '\n\n');

    return cleanedContent;
}

async function summarizeTabs(tabs, maxTokens = 1000000) {
    if (!Array.isArray(tabs)) {
        throw new Error('summarizeTabs expects an array of tabs');
    }

    const encoding = get_encoding("cl100k_base");

    let tabsInput = '';
    let tabsInPrompt = 0;
    let totalTokens = 0;

    for (const t of tabs) {
        const tabHeader = `\n<NEMO_tab>\nTitle: ${t.title}\nURL: ${t.url}\nContent: `;
        const headerTokens = encoding.encode(tabHeader).length;
        
        if (totalTokens + headerTokens > maxTokens) {
            console.warn('Skipping a tab as the prompt is already too large for more tabs.');
            break; // No more space for even a header
        }

        let availableTokens = maxTokens - totalTokens - headerTokens;
        const normalizedContent = normalizeContent(t.content);
        let contentTokens = encoding.encode(normalizedContent);
        
        let truncatedContent;
        if (contentTokens.length > availableTokens) {
            truncatedContent = new TextDecoder().decode(encoding.decode(contentTokens.slice(0, availableTokens)));
            console.warn(`Content for tab ${t.url} was truncated to fit within the token limit.`);
        } else {
            truncatedContent = normalizedContent;
        }

        const finalTabString = `${tabHeader}${truncatedContent}`;
        tabsInput += finalTabString;
        totalTokens += encoding.encode(finalTabString).length;
        tabsInPrompt++;
    }

    console.log(`📊 Prompt includes ${tabsInPrompt} of ${tabs.length} tabs provided.`);
    console.log(`📊 Final prompt token count: ${totalTokens}`);

    const finalPrompt = `${promptTemplate}\n${tabsInput}\n\nThere are exactly ${tabsInPrompt} tabs above.\n- Return exactly ${tabsInPrompt} objects (one per tab) in the JSON array.\n- Output must be wrapped between <<<JSON_START>>> and <<<JSON_END>>> markers, with nothing else.`;
    console.log("📝 Full AI Request Prompt:", finalPrompt);

    const request = {
        contents: [
            { role: 'user', parts: [{ text: finalPrompt }] }
        ]
    };

    try {
        const result = await model.generateContent(request);
        let responseText = result.response.text();
        console.log("🤖 Raw AI Response:", responseText);
        // Prefer extracting between explicit markers; fall back to fenced cleanup.
        let cleaned = (() => {
            const start = responseText.indexOf('<<<JSON_START>>>');
            const end = responseText.lastIndexOf('<<<JSON_END>>>');
            if (start !== -1 && end !== -1 && end > start) {
                return responseText
                    .slice(start + '<<<JSON_START>>>'.length, end)
                    .trim();
            }
            return responseText.trim().replace(/^```json/, '').replace(/```$/,'').trim();
        })();

        // As a last-resort cleanup, if extra text surrounds the array, keep only the outermost [ ... ]
        if (!(cleaned.trim().startsWith('[') && cleaned.trim().endsWith(']'))) {
            const first = cleaned.indexOf('[');
            const last = cleaned.lastIndexOf(']');
            if (first !== -1 && last !== -1 && last > first) {
                cleaned = cleaned.slice(first, last + 1);
            }
        }

        try {
            // First attempt to parse the cleaned response
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) {
                throw new Error('AI response was not an array');
            }
            return parsed;

        } catch (jsonError) {
            console.warn("⚠️ JSON parsing failed. Attempting to have the model fix it.", jsonError.message);

            // Build a multi-turn fix-up request preserving context and reinforcing correctness.
            const fixupInstruction = `Regenerate the JSON to be complete for all TABS_COUNT tabs and include the actual data extracted from each tab.
Do not output placeholder null values unless the information truly does not exist.
Return only a valid JSON array with exactly TABS_COUNT objects that match the schema and rules described above.
Strictly follow these rules:
- Output ONLY a JSON array, no prose or markdown.
- Escape all internal quotes in string values.
- Ensure the response ends with a closing bracket "]".
- Wrap the JSON between <<<JSON_START>>> and <<<JSON_END>>> with nothing else.`.replace(/TABS_COUNT/g, String(tabsInPrompt));

            const fixupRequest = {
                contents: [
                    // Re-send the instructions at the start of the conversation
                    { role: 'user', parts: [{ text: promptTemplate }] },
                    // Re-send the original tabs input so the model has full context
                    { role: 'user', parts: [{ text: `Original tabs input (TABS_COUNT=${tabsInPrompt}):\n${tabsInput}` }] },
                    // Provide the model's previous (broken) response
                    { role: 'model', parts: [{ text: cleaned }] },
                    // Final instruction to regenerate fully populated, valid JSON
                    { role: 'user', parts: [{ text: fixupInstruction }] }
                ]
            };

            console.log("🔧 Sending fix-up request to the model...");
            const fixupResult = await model.generateContent(fixupRequest);
            const fixedResponseText = fixupResult.response.text();
            console.log("🤖 Corrected AI Response:", fixedResponseText);
            
            let fixedCleaned = (() => {
                const start = fixedResponseText.indexOf('<<<JSON_START>>>');
                const end = fixedResponseText.lastIndexOf('<<<JSON_END>>>');
                if (start !== -1 && end !== -1 && end > start) {
                    return fixedResponseText
                        .slice(start + '<<<JSON_START>>>'.length, end)
                        .trim();
                }
                return fixedResponseText.trim().replace(/^```json/, '').replace(/```$/,'').trim();
            })();

            if (!(fixedCleaned.trim().startsWith('[') && fixedCleaned.trim().endsWith(']'))) {
                const first = fixedCleaned.indexOf('[');
                const last = fixedCleaned.lastIndexOf(']');
                if (first !== -1 && last !== -1 && last > first) {
                    fixedCleaned = fixedCleaned.slice(first, last + 1);
                }
            }
            
            try {
                const parsed = JSON.parse(fixedCleaned);
                if (!Array.isArray(parsed)) {
                    throw new Error('Corrected AI response was not an array');
                }
                return parsed;
            } catch (finalJsonError) {
                console.error("❌ JSON fix-up also failed. Returning empty array.", finalJsonError.message);
                return []; // Return empty array if the fix-up also fails
            }
        }
    } catch (error) {
        console.error("❌ Error during AI content generation or parsing. The model's response may have been invalid or truncated.", error);
        return []; // Return empty array on catastrophic failure
    }
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
