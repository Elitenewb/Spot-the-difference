document.getElementById('openChatGpt').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
  window.close();
});
