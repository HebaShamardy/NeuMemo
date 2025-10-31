console.log("🧩 content.js loaded and listening for 'GET_CONTENT' message.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CONTENT') {
  console.log("→ Received 'GET_CONTENT', sending back page content.");
    sendResponse({
      title: document.title,
      url: window.location.href,
      content: document.body?.innerText || ''
    });
    // Return true to indicate that the response will be sent asynchronously.
    // Although in this case it's synchronous, it's good practice.
    return true; 
  }
});