document.addEventListener("DOMContentLoaded", () => {
  const urlInput = document.getElementById("webhookUrl");
  const saveBtn = document.getElementById("saveBtn");
  const statusDiv = document.getElementById("status");

  // Load existing URL
  chrome.storage.local.get(["webhookUrl"], (res) => {
    if (res.webhookUrl) {
      urlInput.value = res.webhookUrl;
    }
  });

  // Save new URL
  saveBtn.addEventListener("click", () => {
    const newUrl = urlInput.value.trim();
    
    if (newUrl) {
      // Save it to storage
      chrome.storage.local.set({ webhookUrl: newUrl }, () => {
        // Send a message to any open chatgpt.com tabs to update immediately
        chrome.tabs.query({ url: "*://chatgpt.com/*" }, (tabs) => {
          for (let tab of tabs) {
            chrome.tabs.sendMessage(tab.id, {
              type: "UPDATE_URL", 
              webhookUrl: newUrl 
            }, () => {
                // Ignore errors if content script isn't loaded
                const lastError = chrome.runtime.lastError;
            });
          }
        });

        // Show a brief success message
        statusDiv.style.display = "block";
        setTimeout(() => {
          statusDiv.style.display = "none";
        }, 2000);
      });
    }
  });
});
