console.log("🧩 content.js running on:", window.location.href);
chrome.runtime.sendMessage({
  type: "TAB_CONTENT",
  data: {
    title: document.title,
    url: window.location.href,
    content: document.body?.innerText
  }
});