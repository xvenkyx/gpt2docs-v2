document.addEventListener("DOMContentLoaded", () => {
    const docIdInput = document.getElementById("docId");
    const clientIdInput = document.getElementById("clientId");
    const saveBtn = document.getElementById("saveBtn");
    const authBtn = document.getElementById("authBtn");
    const statusDiv = document.getElementById("status");

    // Load existing IDs
    chrome.storage.local.get(["docId", "clientId"], (res) => {
        if (res.docId) docIdInput.value = res.docId;
        if (res.clientId) clientIdInput.value = res.clientId;
    });

    // Authorize with Google
    authBtn.addEventListener("click", () => {
        const clientId = clientIdInput.value.trim();
        if (!clientId) {
            showStatus("Please enter your Web Client ID first", "red");
            return;
        }

        chrome.runtime.sendMessage({ type: "AUTHENTICATE", clientId: clientId }, (response) => {
            if (response && response.success) {
                showStatus("Successfully Authorized!", "green");
            } else {
                showStatus("Auth Error: " + (response ? response.error : chrome.runtime.lastError.message), "red");
            }
        });
    });

    // Save Document ID and Client ID
    saveBtn.addEventListener("click", () => {
        const newDocId = docIdInput.value.trim();
        const newClientId = clientIdInput.value.trim();
        
        if (newDocId && newClientId) {
            chrome.storage.local.set({ docId: newDocId, clientId: newClientId }, () => {
                chrome.tabs.query({ url: "*://chatgpt.com/*" }, (tabs) => {
                    for (let tab of tabs) {
                        chrome.tabs.sendMessage(tab.id, {
                            type: "UPDATE_DOC_ID", 
                            docId: newDocId 
                        }, () => {
                            const lastError = chrome.runtime.lastError;
                        });
                    }
                });
                showStatus("Saved! Live streaming to Google Docs.", "green");
            });
        }
    });

    function showStatus(msg, color) {
        statusDiv.textContent = msg;
        statusDiv.style.color = color;
        statusDiv.style.display = "block";
        setTimeout(() => {
            statusDiv.style.display = "none";
        }, 3000);
    }
});
