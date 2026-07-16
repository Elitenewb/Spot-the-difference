'use strict';

const CHATGPT_URL = 'https://chatgpt.com/';
const activeJobs = new Map();

function validText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function validImage(value) { return validText(value, 25_000_000) && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value); }
function validAnalysisPayload(payload) {
  return payload && validText(payload.jobId, 120) && validImage(payload.imageDataUrl) && validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
}
function validEditPayload(payload) {
  const edit = payload?.edit;
  return validText(payload?.jobId, 120) && edit && validText(edit.regionId, 120) && validImage(edit.imageDataUrl) && validText(edit.prompt, 12_000);
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => done(new Error('ChatGPT took too long to load.')), timeoutMs);
  });
}

async function getChatGptTab() {
  const saved = await chrome.storage.session.get('chatTabId');
  if (saved.chatTabId) {
    try { return await chrome.tabs.get(saved.chatTabId); } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: true });
  await chrome.storage.session.set({ chatTabId: tab.id });
  return tab;
}

async function discardChatGptTab(tabId) {
  await chrome.storage.session.remove('chatTabId');
  activeJobs.delete(tabId);
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

async function openFreshChat(tabId, temporary = true) {
  const waiting = waitForTabComplete(tabId);
  const mode = temporary ? 'temporary-chat=true&' : '';
  await chrome.tabs.update(tabId, { url: `${CHATGPT_URL}?${mode}spotJob=${Date.now()}`, active: true });
  await waiting;
}

async function sendToChatGpt(tabId, message) {
  let lastError;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw lastError || new Error('The ChatGPT page adapter did not become ready.');
}

async function runInFreshChat(message, job, temporary = true) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tab = await getChatGptTab();
    try {
      await openFreshChat(tab.id, temporary);
      activeJobs.set(tab.id, job);
      return await sendToChatGpt(tab.id, message);
    } catch (error) {
      lastError = error;
      await discardChatGptTab(tab.id);
    }
  }
  throw lastError || new Error('Could not connect to a fresh ChatGPT tab.');
}

async function forward(appTabId, type, payload) {
  try { await chrome.tabs.sendMessage(appTabId, { type, payload }); }
  catch (_) { /* The creator tab may have been closed. */ }
}

async function runAnalysis(payload, appTabId) {
  try {
    await forward(appTabId, 'SPOT_DIFF_EDIT_PROGRESS', { jobId: payload.jobId, message: 'Opening a fresh ChatGPT analysis chat…', completed: 0, total: 1 });
    const response = await runInFreshChat(
      { type: 'SD_CHATGPT_ANALYZE', payload },
      { appTabId, jobId: payload.jobId, kind: 'analysis' }
    );
    if (!response?.ok) throw new Error(response?.error || 'ChatGPT analysis did not return a result.');
    await forward(appTabId, 'SPOT_DIFF_ANALYSIS_RESULT', { jobId: payload.jobId, regions: response.regions });
  } catch (error) {
    await forward(appTabId, 'SPOT_DIFF_AI_ERROR', { jobId: payload.jobId, message: error.message });
  } finally {
    for (const [tabId, job] of activeJobs) if (job.jobId === payload.jobId) activeJobs.delete(tabId);
  }
}

async function runEdit(payload, appTabId) {
  const { jobId, edit } = payload;
  try {
    await forward(appTabId, 'SPOT_DIFF_EDIT_PROGRESS', { jobId, regionId: edit.regionId, status: 'editing', message: 'Opening a fresh ChatGPT edit chat…' });
    const response = await runInFreshChat(
      { type: 'SD_CHATGPT_EDIT', payload: { ...edit, jobId } },
      { appTabId, jobId, kind: 'edit', regionId: edit.regionId },
      false
    );
    if (!response?.ok) throw new Error(response?.error || 'ChatGPT did not return an edited image.');
    let imageDataUrl = response.imageDataUrl;
    if (!imageDataUrl && response.imageUrl) imageDataUrl = await fetchAsDataUrl(response.imageUrl);
    if (!imageDataUrl) throw new Error('The generated image could not be retrieved from ChatGPT.');
    await forward(appTabId, 'SPOT_DIFF_EDIT_RESULT', { jobId, regionId: edit.regionId, imageDataUrl });
  } catch (error) {
    await forward(appTabId, 'SPOT_DIFF_AI_ERROR', { jobId, message: error.message });
  } finally {
    for (const [tabId, job] of activeJobs) if (job.jobId === jobId) activeJobs.delete(tabId);
  }
}

async function fetchAsDataUrl(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Generated image download failed (${response.status}).`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab?.id) return;
  if (message.type === 'SD_CHATGPT_PROGRESS') {
    const job = activeJobs.get(sender.tab.id);
    if (job && message.payload?.jobId === job.jobId) {
      forward(job.appTabId, 'SPOT_DIFF_AI_PROGRESS', {
        ...message.payload,
        kind: job.kind,
        regionId: message.payload.regionId || job.regionId
      });
    }
    return;
  }
  if (message.type === 'SPOT_DIFF_ANALYZE') {
    if (!validAnalysisPayload(message.payload)) return;
    runAnalysis(message.payload, sender.tab.id).finally(() => sendResponse({ completed: true }));
    return true;
  }
  if (message.type === 'SPOT_DIFF_EDIT_ONE') {
    if (!validEditPayload(message.payload)) return;
    runEdit(message.payload, sender.tab.id).finally(() => sendResponse({ completed: true }));
    return true;
  }
});
