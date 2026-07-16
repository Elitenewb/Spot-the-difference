const APP_URL = 'https://elitenewb.github.io/Spot-the-difference/index.html';

document.getElementById('openSpotDiff').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://elitenewb.github.io/Spot-the-difference/*' });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: APP_URL, active: true });
  window.close();
});
