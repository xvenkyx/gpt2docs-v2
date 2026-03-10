let isSending = false;
let pendingRequest = null;
let activeDocId = null;
let activeToken = null;
let tokenExpirationTime = 0;
let isRefreshing = false;
let refreshQueue = [];
let lastAuthFailTime = 0;
const AUTH_COOLDOWN = 10000; // 10 second cooldown on failed silent auth

// Initialize state with a Promise to prevent race conditions
const initPromise = new Promise((resolve) => {
    chrome.storage.local.get(["docId", "activeToken", "tokenExpirationTime", "clientId"], (res) => {
        if (res.docId) activeDocId = res.docId;
        if (res.activeToken) activeToken = res.activeToken;
        if (res.tokenExpirationTime) tokenExpirationTime = res.tokenExpirationTime;
        console.log("ChatGPT-GDocs: Initial state loaded.", { hasToken: !!activeToken, hasClientId: !!res.clientId });
        resolve(res);
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    initPromise.then(() => {
        if (request.type === "UPDATE_DOC_ID") {
            activeDocId = request.docId;
            sendResponse({ success: true });
        }
        
        if (request.type === "AUTHENTICATE") {
            authenticateInteractive(request.clientId, sendResponse);
            return; // sendResponse is handled inside authenticateInteractive
        }
        
        if (request.type === "SEND_TO_GDOCS") {
            if (isSending) {
                pendingRequest = request;
                return;
            }
            sendToGoogleDocsAPI(request);
        }
    });
    return true; // Keep message channel open for async response
});

function authenticateInteractive(clientId, sendResponse) {
    const redirectUrl = chrome.identity.getRedirectURL();
    const scopes = encodeURIComponent("https://www.googleapis.com/auth/documents");
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUrl)}&scope=${scopes}&prompt=select_account`;

    console.log("ChatGPT-GDocs: Launching interactive auth...");
    chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
    }, function(redirectURI) {
        if (chrome.runtime.lastError || !redirectURI) {
            const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "User cancelled or redirect failed";
            console.error("ChatGPT-GDocs: Interactive auth error:", error);
            sendResponse({ success: false, error: error });
            return;
        }

        handleAuthResponse(redirectURI, clientId, (success, err) => {
            if (success) {
                console.log("ChatGPT-GDocs: Interactive auth successful.");
                sendResponse({ success: true });
            } else {
                console.error("ChatGPT-GDocs: Failed to parse interactive token:", err);
                sendResponse({ success: false, error: err });
            }
        });
    });
}

function handleAuthResponse(redirectURI, clientId, callback) {
    // Search for access_token in either hash or query params
    const tokenMatch = redirectURI.match(/[#&]access_token=([^&]+)/);
    const expiresMatch = redirectURI.match(/[#&]expires_in=([^&]+)/);
    
    if (tokenMatch) {
        activeToken = tokenMatch[1];
        if (expiresMatch) {
            const seconds = parseInt(expiresMatch[1]);
            tokenExpirationTime = Date.now() + (seconds * 1000);
            console.log(`ChatGPT-GDocs: Token expires in ${Math.round(seconds/60)} minutes.`);
        } else {
            // Default to 1 hour if missing
            tokenExpirationTime = Date.now() + 3600000;
        }

        chrome.storage.local.set({ 
            activeToken: activeToken, 
            tokenExpirationTime: tokenExpirationTime,
            clientId: clientId 
        }, () => {
            lastAuthFailTime = 0; // Reset cooldown
            callback(true);
        });
    } else {
        // Log the URI if it doesn't have a token (usually contains error=...)
        const urlObj = new URL(redirectURI.replace('#', '?'));
        const error = urlObj.searchParams.get('error') || "No access_token found in redirect";
        callback(false, error);
    }
}

function getValidToken(callback) {
    // 1. Check current memory
    if (activeToken && Date.now() < tokenExpirationTime - 60000) {
        callback(activeToken);
        return;
    }

    // 2. Cooldown check - don't hammer Google if we just failed
    if (Date.now() - lastAuthFailTime < AUTH_COOLDOWN) {
        console.warn("ChatGPT-GDocs: Auth is in cooldown. Please wait or re-authorize manually.");
        callback(null);
        return;
    }

    // 3. If already refreshing, queue the callback
    if (isRefreshing) {
        refreshQueue.push(callback);
        return;
    }

    isRefreshing = true;

    // 4. Try reading fresh from storage or refresh silently
    chrome.storage.local.get(["activeToken", "tokenExpirationTime", "clientId"], (res) => {
        if (res.activeToken && res.tokenExpirationTime && Date.now() < res.tokenExpirationTime - 60000) {
            activeToken = res.activeToken;
            tokenExpirationTime = res.tokenExpirationTime;
            isRefreshing = false;
            callback(activeToken);
            processQueue(activeToken);
            return;
        }

        if (!res.clientId) {
            console.error("ChatGPT-GDocs: No Client ID found. Re-authorize in the extension popup.");
            isRefreshing = false;
            callback(null);
            processQueue(null);
            return;
        }

        // Silent re-auth
        const redirectUrl = chrome.identity.getRedirectURL();
        const scopes = encodeURIComponent("https://www.googleapis.com/auth/documents");
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${res.clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUrl)}&prompt=none&scope=${scopes}`;

        console.log("ChatGPT-GDocs: Attempting silent token refresh...");
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: false }, function(redirectURI) {
            isRefreshing = false;
            if (chrome.runtime.lastError || !redirectURI) {
                const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Interaction required";
                console.warn("ChatGPT-GDocs: Silent refresh failed:", error);
                lastAuthFailTime = Date.now();
                callback(null);
                processQueue(null);
                return;
            }

            handleAuthResponse(redirectURI, res.clientId, (success, err) => {
                if (success) {
                    console.log("ChatGPT-GDocs: Silent refresh successful.");
                    callback(activeToken);
                    processQueue(activeToken);
                } else {
                    console.warn("ChatGPT-GDocs: Silent refresh parse error:", err);
                    lastAuthFailTime = Date.now();
                    callback(null);
                    processQueue(null);
                }
            });
        });
    });
}

function processQueue(token) {
    while (refreshQueue.length > 0) {
        const cb = refreshQueue.shift();
        cb(token);
    }
}

function sendToGoogleDocsAPI(request, retryCount = 0) {
    if (!activeDocId) return;

    isSending = true;
    getValidToken(function(token) {
        if (!token) {
            finishSending();
            return;
        }

        if (!request.text || request.text.trim().length === 0) {
            finishSending();
            return;
        }

        const MAX_RETRIES = 3;

        fetch(`https://docs.googleapis.com/v1/documents/${activeDocId}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(res => res.json())
        .then(doc => {
            if (doc.error) {
                if (doc.error.code === 401) {
                    console.warn("ChatGPT-GDocs: Token rejected by API (401). Clearing...");
                    activeToken = null;
                    tokenExpirationTime = 0;
                    chrome.storage.local.remove(["activeToken", "tokenExpirationTime"]);
                }
                throw doc.error;
            }

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
        .then(res => res ? res.json() : null)
        .then(result => {
            if (!result) return;

            if (result.error) {
                if (result.error.code === 429 && retryCount < MAX_RETRIES) {
                    const waitTime = Math.pow(2, retryCount) * 2000 + (Math.random() * 1000);
                    console.warn(`ChatGPT-GDocs: Rate limit hit. Retrying in ${Math.round(waitTime)}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
                    setTimeout(() => {
                        sendToGoogleDocsAPI(request, retryCount + 1);
                    }, waitTime);
                    return; 
                }
                console.error("ChatGPT-GDocs API Error:", JSON.stringify(result.error, null, 2));
            } else {
                console.log("ChatGPT-GDocs: Synced.");
                if (retryCount > 0) console.log("ChatGPT-GDocs: Recovered from rate limit.");
            }
            finishSending();
        })
        .catch(err => {
            if (err.code === 429 && retryCount < MAX_RETRIES) {
                const waitTime = Math.pow(2, retryCount) * 2000 + (Math.random() * 1000);
                console.warn(`ChatGPT-GDocs: Rate limit hit (catch). Retrying in ${Math.round(waitTime)}ms...`);
                setTimeout(() => {
                    sendToGoogleDocsAPI(request, retryCount + 1);
                }, waitTime);
            } else {
                console.error("ChatGPT-GDocs: Sync failed:", err.message || JSON.stringify(err));
                finishSending();
            }
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


