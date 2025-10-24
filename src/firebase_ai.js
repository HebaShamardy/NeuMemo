import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";

// TODO(developer) Replace the following with your app's Firebase configuration
// See: https://firebase.google.com/docs/web/learn-more#config-object
const firebaseConfig = {
  apiKey: "AIzaSyDDGJoaiSya-5-WKLCxXEkYLA6DC_zHuS4",
  authDomain: "neumemo-nemo.firebaseapp.com",
  projectId: "neumemo-nemo",
  storageBucket: "neumemo-nemo.firebasestorage.app",
  messagingSenderId: "101837030947",
  appId: "1:101837030947:web:6cea465cc30dc091e41396",
  measurementId: "G-D1P3ZSYWEB"
};

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