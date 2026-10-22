// Clicking the toolbar icon opens ReconCheck in a full tab (reports need the room).
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
