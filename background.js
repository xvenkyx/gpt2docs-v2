chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "SEND_TO_GDOCS") {
        fetch(request.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain' // Simple POST to avoid preflight
            },
            body: request.text
        })
        .then(response => response.text())
        .then(result => {
            console.log("ChatGPT-GDocs: Sent successfully", result);
        })
        .catch(err => {
            console.error("ChatGPT-GDocs: Error sending to Google Docs", err);
        });
    }
});
