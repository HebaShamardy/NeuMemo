import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";

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

// Create a `GenerativeModel` instance
// Set the mode, for example to use on-device model when possible
const model = getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE });

// Imports + initialization of FirebaseApp and backend service + creation of model instance

// Wrap in an async function so you can use await
async function run() {
  // Provide a prompt that contains text
  const prompt = "Write a story about a magic backpack."

  // To generate text output, call `generateContent` with the text input
  const result = await model.generateContent(prompt);

  const response = result.response;
  const text = response.text();
  console.log(text);
}

// NOTE: do not auto-run the sample on module load. Extensions have strict
// CSP and running the model on load can cause unexpected API calls and
// errors (for example: missing output language). Call `run()` from the UI
// or expose it on window for manual invocation during development.
// Example (from viewer.js):
// import { run } from './firebase_ai.js';
// document.getElementById('generate').addEventListener('click', run);

export { run };