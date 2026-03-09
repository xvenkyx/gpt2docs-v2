let isSending = false;
let pendingRequest = null;
let activeDocId = null;
let activeToken = null;
let tokenExpirationTime = 0;

chrome.storage.local.get(["docId"], (res) => {
    if (res.docId) {
        activeDocId = res.docId;
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "UPDATE_DOC_ID") {
        activeDocId = request.docId;
        sendResponse({ success: true });
    }
    
    if (request.type === "AUTHENTICATE") {
        authenticateInteractive(request.clientId, sendResponse);
        return true; // Keep message channel open for async response
    }
    
    if (request.type === "SEND_TO_GDOCS") {
        if (isSending) {
            pendingRequest = request;
            return;
        }
        sendToGoogleDocsAPI(request);
    }
});

function authenticateInteractive(clientId, sendResponse) {
    const redirectUrl = chrome.identity.getRedirectURL();
    const scopes = encodeURIComponent("https://www.googleapis.com/auth/documents");
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUrl)}&scope=${scopes}`;

    chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
    }, function(redirectURI) {
        if (chrome.runtime.lastError || !redirectURI) {
            console.error(chrome.runtime.lastError);
            sendResponse({ success: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "Auth was cancelled" });
            return;
        }

        const hashMatch = redirectURI.match(/access_token=([^&]+)/);
        const expiresInMatch = redirectURI.match(/expires_in=([^&]+)/);
        
        if (hashMatch) {
            activeToken = hashMatch[1];
            if (expiresInMatch) {
                tokenExpirationTime = Date.now() + (parseInt(expiresInMatch[1]) * 1000);
            }
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: "Failed to parse token" });
        }
    });
}

function getValidToken(callback) {
    if (activeToken && Date.now() < tokenExpirationTime - 60000) {
        callback(activeToken);
    } else {
        chrome.storage.local.get(["clientId"], (res) => {
            if (!res.clientId) {
                callback(null);
                return;
            }
            const redirectUrl = chrome.identity.getRedirectURL();
            const scopes = encodeURIComponent("https://www.googleapis.com/auth/documents");
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${res.clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUrl)}&prompt=none&scope=${scopes}`;

            chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: false }, function(redirectURI) {
                if (chrome.runtime.lastError || !redirectURI) {
                    callback(null);
                    return;
                }
                const hashMatch = redirectURI.match(/access_token=([^&]+)/);
                const expiresInMatch = redirectURI.match(/expires_in=([^&]+)/);
                if (hashMatch) {
                    activeToken = hashMatch[1];
                    if (expiresInMatch) {
                        tokenExpirationTime = Date.now() + (parseInt(expiresInMatch[1]) * 1000);
                    }
                    callback(activeToken);
                } else {
                    callback(null);
                }
            });
        });
    }
}

function sendToGoogleDocsAPI(request) {
    if (!activeDocId) return;

    isSending = true;
    getValidToken(function(token) {
        if (!token) {
            console.error("ChatGPT-GDocs: Not authorized.");
            finishSending();
            return;
        }

        if (!request.text || request.text.trim().length === 0) {
            finishSending();
            return;
        }

        fetch(`https://docs.googleapis.com/v1/documents/${activeDocId}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(res => res.json())
        .then(doc => {
            if (doc.error) throw new Error(doc.error.message);

            const content = doc.body.content;
            const endIndex = content[content.length - 1].endIndex;
            
            const requests = [];
            
            if (endIndex > 2) {
                requests.push({
                    deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } }
                });
            }
            
            requests.push({
                insertText: { location: { index: 1 }, text: request.text }
            });
            
            return fetch(`https://docs.googleapis.com/v1/documents/${activeDocId}:batchUpdate`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ requests: requests })
            });
        })
        .then(res => res.json())
        .then(result => {
            if (result.error) console.error("ChatGPT-GDocs API Error:", result.error);
            else console.log("ChatGPT-GDocs: Synced smoothly.");
        })
        .catch(err => {
            console.error("ChatGPT-GDocs: Fetch Error", err);
        })
        .finally(() => {
            finishSending();
        });
    });
}

function finishSending() {
    isSending = false;
    if (pendingRequest) {
        const nextReq = pendingRequest;
        pendingRequest = null;
        sendToGoogleDocsAPI(nextReq);
    }
}
