import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";

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

const responseSchema = Schema.object({
properties: {
    tab_id: Schema.string(),
    language: Schema.string(),
    title: Schema.string(),
    summarized_content: Schema.string(),
    tags: Schema.array({ items: Schema.string() }),
    main_class: Schema.string(),
    classes: Schema.array({ items: Schema.string() })
}
});
// Create a `GenerativeModel` instance (lazy-created/re-creatable)
// Set the mode, for example to use on-device model when possible
let model = getGenerativeModel(ai,
    {
        mode: InferenceMode.PREFER_ON_DEVICE,
        model: "gemini-2.5-flash",
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
            model: "gemini-2.5-flash",
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

// Summarize a page using the AI model and return parsed JSON according to the
// structured prompt provided by the user. Returns the parsed object or throws
// if parsing/AI fails.
async function summarizePage({ title, url, content }) {

    // Short prompt: describe the task and provide the page data. The JSON
    // structure is enforced via the responseSchema rather than spelled out in
    // the prompt body.
    const prompt = `You are a browser session intelligence agent. Analyze the page and return the requested fields as JSON that match the provided schema.\n\nTitle: ${title}\nURL: ${url}\nContent: ${content}
    You are required to detect site language then return the json values. the values shall be in same language
    {
    "tab_id": "url",
    "language": <language_value>,
    "title": "<tab_title>",
    "summarized_content":<generate_summary_of_the_tab_topic>,
    "tags": <list_of_tag_for_search>,
    "main_class": <suggested_generic_class>, e.g. tech, politics, social
    "classes": <suggest_classes_to_use_ith_other_tabs>
    }`;
    let result = await model.generateContent(prompt)
    let response = result.response.text();
    const cleaned_response = response.trim().replace("```json", '').replace("```", '');
    const jsonResponse = JSON.parse(cleaned_response);

    console.log(jsonResponse.summarized_content); // Example usage
    return jsonResponse;

    }

// NOTE: do not auto-run the sample on module load. Extensions have strict
// CSP and running the model on load can cause unexpected API calls and
// errors (for example: missing output language). Call `run()` from the UI
// or expose it on window for manual invocation during development.
// Example (from viewer.js):
// import { run } from './firebase_ai.js';
// document.getElementById('generate').addEventListener('click', run);

export { run };
export { summarizePage };
export { recreateModel };
