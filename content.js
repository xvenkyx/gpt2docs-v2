let docId = "";
let lastObservedText = "";
let lastSendTime = 0;
let throttleTimer = null;

// Load Doc ID from extension storage on startup
chrome.storage.local.get(["docId"], (res) => {
    if (res.docId) {
        docId = res.docId;
        console.log("ChatGPT-GDocs: Doc ID loaded.");
    }
});

// Listen for updates from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "UPDATE_DOC_ID") {
        docId = request.docId;
        console.log("ChatGPT-GDocs: Doc ID updated.");
        sendResponse({ success: true });
    }
});

// Observe DOM changes in ChatGPT interface
const observer = new MutationObserver(() => {
    if (!docId) return;

    // ChatGPT uses data-message-author-role="assistant" for AI responses
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length === 0) return;

    // Get the very latest assistant message currently being generated
    const latestMessage = assistantMessages[assistantMessages.length - 1];
    const text = latestMessage.innerText;

    if (text !== lastObservedText && text.trim().length > 0) {
        lastObservedText = text;
        const now = Date.now();
        
        // Official API is extremely fast, so we can drop throttle to 250ms
        // Note: Google Docs API standard limit is 300 writes per minute per user
        const throttleInterval = 250;
        
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
    if (!docId) return;

    try {
        chrome.runtime.sendMessage({
            type: "SEND_TO_GDOCS",
            text: text
        }, (response) => {
            if (chrome.runtime.lastError) {
                // Ignore the error silently
            }
        });
    } catch (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
            console.warn("ChatGPT-GDocs: Extension was updated or reloaded. Disconnecting observer.");
            observer.disconnect(); // Stop the loop
        } else {
            console.error("ChatGPT-GDocs Error:", error);
        }
    }
}
