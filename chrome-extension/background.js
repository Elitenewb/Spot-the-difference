'use strict';

const CHATGPT_URL = 'https://chatgpt.com/';
const activeJobs = new Map();
const ACTIVE_JOB_PREFIX = 'activeJob:';
const COMPLETED_JOB_PREFIX = 'completedJob:';
const ANALYSIS_PROBE_PREFIX = 'analysisProbe:';
const cancelledJobIds = new Set();
const intentionallyClosedTabs = new Set();

function activeJobKey(tabId) { return `${ACTIVE_JOB_PREFIX}${tabId}`; }
function completedJobKey(jobId) { return `${COMPLETED_JOB_PREFIX}${jobId}`; }
function analysisProbeName(tabId) { return `${ANALYSIS_PROBE_PREFIX}${tabId}`; }

async function ensureAnalysisProbe(tabId) {
  if (!chrome.alarms) return;
  const name = analysisProbeName(tabId);
  const existing = await chrome.alarms.get(name);
  if (!existing) await chrome.alarms.create(name, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
}

async function markJobCompleted(jobId) {
  await chrome.storage.session.set({ [completedJobKey(jobId)]: true });
}

async function jobWasCompleted(jobId) {
  const stored = await chrome.storage.session.get(completedJobKey(jobId));
  return stored[completedJobKey(jobId)] === true;
}

async function clearJobCompleted(jobId) {
  await chrome.storage.session.remove(completedJobKey(jobId));
}

async function rememberActiveJob(tabId, job) {
  activeJobs.set(tabId, job);
  await chrome.storage.session.set({ [activeJobKey(tabId)]: job });
  if (job.kind === 'analysis') await ensureAnalysisProbe(tabId);
}

async function activeJobFor(tabId) {
  const current = activeJobs.get(tabId);
  if (current) return current;
  const saved = await chrome.storage.session.get(activeJobKey(tabId));
  const job = saved[activeJobKey(tabId)];
  if (job) activeJobs.set(tabId, job);
  return job;
}

async function forgetActiveJob(tabId) {
  activeJobs.delete(tabId);
  await chrome.storage.session.remove(activeJobKey(tabId));
  await chrome.alarms?.clear(analysisProbeName(tabId));
}

async function activeJobEntries() {
  const saved = await chrome.storage.session.get(null);
  const jobs = new Map();
  for (const [key, job] of Object.entries(saved)) {
    if (!key.startsWith(ACTIVE_JOB_PREFIX)) continue;
    const tabId = Number(key.slice(ACTIVE_JOB_PREFIX.length));
    if (Number.isInteger(tabId) && job) jobs.set(tabId, job);
  }
  for (const [tabId, job] of activeJobs) jobs.set(tabId, job);
  return [...jobs.entries()];
}

async function restoreAnalysisProbes() {
  for (const [tabId, job] of await activeJobEntries()) {
    if (job.kind === 'analysis') await ensureAnalysisProbe(tabId);
  }
}

function validText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function validImage(value) { return validText(value, 25_000_000) && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value); }
function validAnalysisPayload(payload) {
  return payload && validText(payload.jobId, 120) && validImage(payload.imageDataUrl) && validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
}
function validRepairPayload(payload) {
  return payload && validText(payload.jobId, 120) && validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
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
  const saved = await chrome.storage.session.get(['chatTabId', 'chatWindowId']);
  if (saved.chatTabId && saved.chatWindowId) {
    try {
      const [tab, chatWindow] = await Promise.all([
        chrome.tabs.get(saved.chatTabId),
        chrome.windows.get(saved.chatWindowId)
      ]);
      if (tab.windowId === chatWindow.id) {
        await chrome.tabs.update(tab.id, { active: true });
        return tab;
      }
    } catch (_) {}
  }
  const chatWindow = await chrome.windows.create({ url: CHATGPT_URL, focused: false, type: 'normal' });
  const tab = chatWindow.tabs?.[0] || (await chrome.tabs.query({ windowId: chatWindow.id }))[0];
  if (!tab?.id) throw new Error('Chrome did not create the background ChatGPT window.');
  await chrome.storage.session.set({ chatTabId: tab.id, chatWindowId: chatWindow.id });
  return tab;
}

async function discardChatGptTab(tabId) {
  await chrome.storage.session.remove(['chatTabId', 'chatWindowId']);
  await forgetActiveJob(tabId);
  intentionallyClosedTabs.add(tabId);
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

function jobWasCancelled(job) { return cancelledJobIds.has(job?.jobId); }

async function cancelJob(jobId, appTabId) {
  if (!validText(jobId, 120)) return;
  cancelledJobIds.add(jobId);
  const matchingTabs = (await activeJobEntries())
    .filter(([, job]) => job.jobId === jobId && (!appTabId || job.appTabId === appTabId))
    .map(([tabId]) => tabId);
  await Promise.all(matchingTabs.map(tabId => discardChatGptTab(tabId)));
  if (appTabId) await forward(appTabId, 'SPOT_DIFF_JOB_CANCELLED', {
    jobId,
    message: 'Generation cancelled. Ready when you want to try again.'
  });
}

async function openFreshChat(tabId, temporary = true) {
  const waiting = waitForTabComplete(tabId);
  const mode = temporary ? 'temporary-chat=true&' : '';
  // Keep ChatGPT selected inside its own unfocused window. Chrome may freeze a
  // truly inactive tab, but an active tab in an unfocused window remains
  // schedulable without pulling the user away from Creator.
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
    if (jobWasCancelled(job)) throw new Error('Current ChatGPT job cancelled.');
    const tab = await getChatGptTab();
    try {
      await openFreshChat(tab.id, temporary);
      if (jobWasCancelled(job)) { await discardChatGptTab(tab.id); throw new Error('Current ChatGPT job cancelled.'); }
      await rememberActiveJob(tab.id, job);
      const response = await sendToChatGpt(tab.id, message);
      if (await jobWasCompleted(job.jobId)) return { ok: true, alreadyForwarded: true };
      if (jobWasCancelled(job)) throw new Error('Current ChatGPT job cancelled.');
      return response;
    } catch (error) {
      lastError = error;
      if (await jobWasCompleted(job.jobId)) return { ok: true, alreadyForwarded: true };
      await discardChatGptTab(tab.id);
      if (jobWasCancelled(job)) throw error;
    }
  }
  throw lastError || new Error('Could not connect to a fresh ChatGPT tab.');
}

async function forward(appTabId, type, payload) {
  try { await chrome.tabs.sendMessage(appTabId, { type, payload }); return true; }
  catch (_) { return false; }
}

async function runAnalysis(payload, appTabId) {
  try {
    cancelledJobIds.delete(payload.jobId);
    await forward(appTabId, 'SPOT_DIFF_EDIT_PROGRESS', { jobId: payload.jobId, message: 'Opening a fresh ChatGPT analysis chat…', completed: 0, total: 1 });
    const response = await runInFreshChat(
      { type: 'SD_CHATGPT_ANALYZE', payload },
      { appTabId, jobId: payload.jobId, kind: 'analysis' }
    );
    if (response?.alreadyForwarded || await jobWasCompleted(payload.jobId)) return;
    if (!response?.ok) throw new Error(response?.error || 'ChatGPT analysis did not return a result.');
    await forward(appTabId, 'SPOT_DIFF_ANALYSIS_RESULT', { jobId: payload.jobId, regions: response.regions });
  } catch (error) {
    if (!cancelledJobIds.has(payload.jobId) && !(await jobWasCompleted(payload.jobId))) await forward(appTabId, 'SPOT_DIFF_AI_ERROR', { jobId: payload.jobId, message: error.message });
  } finally {
    for (const [tabId, job] of await activeJobEntries()) if (job.jobId === payload.jobId && job.kind === 'analysis') await forgetActiveJob(tabId);
    await clearJobCompleted(payload.jobId);
  }
}

async function probeAnalysisResult(tabId) {
  const job = await activeJobFor(tabId);
  if (!job || job.kind !== 'analysis' || await jobWasCompleted(job.jobId)) return false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'SD_CHATGPT_PROBE_ANALYSIS', payload: { jobId: job.jobId } });
    if (!response?.ok || !Array.isArray(response.regions)) return false;
    await markJobCompleted(job.jobId);
    await forgetActiveJob(tabId);
    await forward(job.appTabId, 'SPOT_DIFF_ANALYSIS_RESULT', { jobId: job.jobId, regions: response.regions });
    return true;
  } catch (_) { return false; }
}

async function runRepairAnalysis(payload, appTabId) {
  try {
    cancelledJobIds.delete(payload.jobId);
    const tab = await getChatGptTab();
    await rememberActiveJob(tab.id, { appTabId, jobId: payload.jobId, kind: 'analysis-repair' });
    await forward(appTabId, 'SPOT_DIFF_EDIT_PROGRESS', { jobId: payload.jobId, message: `Requesting ${payload.count} replacement suggestion${payload.count === 1 ? '' : 's'}…`, completed: 0, total: 1 });
    const response = await sendToChatGpt(tab.id, { type: 'SD_CHATGPT_REPAIR_ANALYSIS', payload });
    if (!response?.ok) throw new Error(response?.error || 'ChatGPT replacement analysis did not return a result.');
    await forward(appTabId, 'SPOT_DIFF_ANALYSIS_RESULT', { jobId: payload.jobId, regions: response.regions, repair: true });
  } catch (error) {
    if (!cancelledJobIds.has(payload.jobId)) await forward(appTabId, 'SPOT_DIFF_AI_ERROR', { jobId: payload.jobId, message: error.message });
  } finally {
    for (const [tabId, job] of await activeJobEntries()) if (job.jobId === payload.jobId && job.kind === 'analysis-repair') await forgetActiveJob(tabId);
  }
}

async function runVerifyAnalysis(payload, appTabId) {
  try {
    const tab = await getChatGptTab();
    await rememberActiveJob(tab.id, { appTabId, jobId: payload.jobId, kind: 'analysis-verify' });
    await forward(appTabId, 'SPOT_DIFF_EDIT_PROGRESS', { jobId: payload.jobId, message: 'ChatGPT is checking every numbered region against its target…', completed: 0, total: 1 });
    const response = await sendToChatGpt(tab.id, { type: 'SD_CHATGPT_VERIFY_ANALYSIS', payload });
    if (!response?.ok) throw new Error(response?.error || 'ChatGPT region verification did not return a result.');
    await forward(appTabId, 'SPOT_DIFF_ANALYSIS_RESULT', { jobId: payload.jobId, regions: response.regions, verified: true });
  } catch (error) {
    if (!cancelledJobIds.has(payload.jobId)) await forward(appTabId, 'SPOT_DIFF_AI_ERROR', { jobId: payload.jobId, message: error.message });
  } finally {
    for (const [tabId, job] of await activeJobEntries()) if (job.jobId === payload.jobId && job.kind === 'analysis-verify') await forgetActiveJob(tabId);
  }
}

async function runEdit(payload, appTabId) {
  const { jobId, edit } = payload;
  try {
    cancelledJobIds.delete(jobId);
    await forward(appTabId, 'SPOT_DIFF_EDIT_PROGRESS', { jobId, regionId: edit.regionId, status: 'editing', message: 'Opening a fresh ChatGPT edit chat…' });
    const response = await runInFreshChat(
      { type: 'SD_CHATGPT_EDIT', payload: { ...edit, jobId } },
      { appTabId, jobId, kind: 'edit', regionId: edit.regionId },
      true
    );
    if (!response?.ok) throw new Error(response?.error || 'ChatGPT did not return an edited image.');
    let imageDataUrl = response.imageDataUrl;
    if (!imageDataUrl && response.imageUrl) imageDataUrl = await fetchAsDataUrl(response.imageUrl);
    if (!imageDataUrl) throw new Error('The generated image could not be retrieved from ChatGPT.');
    await forward(appTabId, 'SPOT_DIFF_EDIT_RESULT', { jobId, regionId: edit.regionId, imageDataUrl });
  } catch (error) {
    if (!cancelledJobIds.has(jobId)) await forward(appTabId, 'SPOT_DIFF_AI_ERROR', { jobId, message: error.message });
  } finally {
    for (const [tabId, job] of await activeJobEntries()) if (job.jobId === jobId && job.kind === 'edit') await forgetActiveJob(tabId);
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
  if (message.type === 'SPOT_DIFF_BRIDGE_PING') {
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'SD_CHATGPT_PROGRESS') {
    activeJobFor(sender.tab.id).then(job => {
      if (job && message.payload?.jobId === job.jobId) {
        forward(job.appTabId, 'SPOT_DIFF_AI_PROGRESS', {
          ...message.payload,
          kind: job.kind,
          regionId: message.payload.regionId || job.regionId
        });
      }
    }).catch(() => {});
    return;
  }
  if (message.type === 'SPOT_DIFF_ANALYZE') {
    if (!validAnalysisPayload(message.payload)) return;
    runAnalysis(message.payload, sender.tab.id).finally(() => sendResponse({ completed: true }));
    return true;
  }
  if (message.type === 'SPOT_DIFF_CANCEL') {
    cancelJob(message.payload?.jobId, sender.tab.id).finally(() => sendResponse({ cancelled: true }));
    return true;
  }
  if (message.type === 'SPOT_DIFF_REPAIR_ANALYSIS') {
    if (!validRepairPayload(message.payload)) return;
    runRepairAnalysis(message.payload, sender.tab.id).finally(() => sendResponse({ completed: true }));
    return true;
  }
  if (message.type === 'SPOT_DIFF_VERIFY_ANALYSIS') {
    if (!validAnalysisPayload(message.payload)) return;
    runVerifyAnalysis(message.payload, sender.tab.id).finally(() => sendResponse({ completed: true }));
    return true;
  }
  if (message.type === 'SPOT_DIFF_EDIT_ONE') {
    if (!validEditPayload(message.payload)) return;
    runEdit(message.payload, sender.tab.id).finally(() => sendResponse({ completed: true }));
    return true;
  }
});

chrome.alarms?.onAlarm?.addListener(alarm => {
  if (!alarm?.name?.startsWith(ANALYSIS_PROBE_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ANALYSIS_PROBE_PREFIX.length));
  if (Number.isInteger(tabId)) probeAnalysisResult(tabId).catch(() => {});
});

restoreAnalysisProbes().catch(() => {});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (intentionallyClosedTabs.has(tabId)) return;
  const job = await activeJobFor(tabId);
  if (job) {
    cancelJob(job.jobId, job.appTabId);
    return;
  }
  for (const [, activeJob] of await activeJobEntries()) {
    if (activeJob.appTabId === tabId) cancelJob(activeJob.jobId, tabId);
  }
});
