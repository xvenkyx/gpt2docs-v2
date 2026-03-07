let webhookUrl = "";
let lastObservedText = "";
let lastSendTime = 0;
let throttleTimer = null;

// Load webhook URL from extension storage on startup
chrome.storage.local.get(["webhookUrl"], (res) => {
    if (res.webhookUrl) {
        webhookUrl = res.webhookUrl;
        console.log("ChatGPT-GDocs: Webhook URL loaded.");
    }
});

// Listen for updates from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "UPDATE_URL") {
        webhookUrl = request.webhookUrl;
        console.log("ChatGPT-GDocs: Webhook URL updated.");
        sendResponse({ success: true });
    }
});

// Observe DOM changes in ChatGPT interface
const observer = new MutationObserver(() => {
    if (!webhookUrl) return;

    // ChatGPT uses data-message-author-role="assistant" for AI responses
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length === 0) return;

    // Get the very latest assistant message currently being generated
    const latestMessage = assistantMessages[assistantMessages.length - 1];
    const text = latestMessage.innerText;

    if (text !== lastObservedText && text.trim().length > 0) {
        lastObservedText = text;
        const now = Date.now();
        
        // Google Apps Script limits requests, so we throttle to send a frame max 1x per second
        const throttleInterval = 1000;
        
        if (now - lastSendTime >= throttleInterval) {
            lastSendTime = now;
            sendToGoogleDocs(text);
        } else {
            // Ensure the absolute final generated word is pushed fully
            clearTimeout(throttleTimer);
            throttleTimer = setTimeout(() => {
                lastSendTime = Date.now();
                sendToGoogleDocs(text);
            }, throttleInterval - (now - lastSendTime));
        }
    }
});

// Start observing the chat container structure
observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
});

function sendToGoogleDocs(text) {
    if (!webhookUrl) return;

    try {
        chrome.runtime.sendMessage({
            type: "SEND_TO_GDOCS",
            url: webhookUrl,
            text: text
        }, (response) => {
            if (chrome.runtime.lastError) {
                // Ignore the error silently. It could just fail to send.
            }
        });
    } catch (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
            console.warn("ChatGPT-GDocs: Extension was updated or reloaded. The current page's script is orphaned. Disconnecting observer.");
            observer.disconnect(); // Stop the loop and error spam!
        } else {
            console.error("ChatGPT-GDocs Error:", error);
        }
    }
}
