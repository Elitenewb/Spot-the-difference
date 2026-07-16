import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadBackgroundHarness() {
  const updates = [];
  const creations = [];
  const sentMessages = [];
  const updateListeners = new Set();
  const removeListeners = new Set();
  const sessionStore = {};
  const chrome = {
    storage: {
      session: {
        async get(keys) {
          if (keys == null) return { ...sessionStore };
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.filter(key => key in sessionStore).map(key => [key, sessionStore[key]]));
        },
        async set(values) { Object.assign(sessionStore, values); },
        async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete sessionStore[key]; }
      }
    },
    tabs: {
      onUpdated: {
        addListener(listener) { updateListeners.add(listener); },
        removeListener(listener) { updateListeners.delete(listener); }
      },
      onRemoved: { addListener(listener) { removeListeners.add(listener); } },
      async update(tabId, options) {
        updates.push({ tabId, ...options });
        queueMicrotask(() => {
          for (const listener of updateListeners) listener(tabId, { status: 'complete' });
        });
        return { id: tabId, ...options };
      },
      async create(options) { creations.push(options); return { id: 77, ...options }; },
      async get(tabId) { return { id: tabId }; },
      async remove() {},
      async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); return { accepted: true }; }
    },
    runtime: { onMessage: { addListener() {} } }
  };
  const fastSetTimeout = (callback, delay, ...args) => {
    if (delay === 700) { queueMicrotask(() => callback(...args)); return -1; }
    return setTimeout(callback, delay, ...args);
  };
  const context = { chrome, setTimeout: fastSetTimeout, clearTimeout, queueMicrotask, fetch, Uint8Array, btoa };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8'), context);
  return { context, updates, creations, sentMessages, removeListeners, sessionStore };
}

test('analysis uses temporary chat while crop editing uses regular chat', async () => {
  const { context, updates } = loadBackgroundHarness();
  await context.openFreshChat(10, true);
  await context.openFreshChat(11, false);
  assert.match(updates[0].url, /temporary-chat=true/);
  assert.doesNotMatch(updates[1].url, /temporary-chat=true/);
  assert.match(updates[0].url, /spotJob=/);
  assert.match(updates[1].url, /spotJob=/);
  assert.equal(updates[0].active, false);
  assert.equal(updates[1].active, false);
});

test('new ChatGPT automation tabs open behind the creator', async () => {
  const { context, creations } = loadBackgroundHarness();
  await context.getChatGptTab();
  assert.equal(creations.length, 1);
  assert.equal(creations[0].active, false);
});

test('fresh-chat runner retries once after losing its ChatGPT tab', async () => {
  const { context } = loadBackgroundHarness();
  let sends = 0;
  context.chrome.tabs.sendMessage = async () => {
    sends++;
    if (sends <= 15) throw new Error('Receiving end does not exist');
    return { accepted: true };
  };
  const result = await context.runInFreshChat(
    { type: 'SD_CHATGPT_EDIT', payload: { jobId: 'job' } },
    { appTabId: 1, jobId: 'job', kind: 'edit' },
    false
  );
  assert.equal(result.accepted, true);
  assert.equal(sends, 16);
});

test('active job routing survives service worker memory loss', async () => {
  const { context, sessionStore } = loadBackgroundHarness();
  await context.rememberActiveJob(42, { appTabId: 5, jobId: 'durable-job', kind: 'analysis' });
  assert.equal(sessionStore['activeJob:42'].jobId, 'durable-job');
  vm.runInContext('activeJobs.clear()', context);
  const recovered = await context.activeJobFor(42);
  assert.equal(recovered.appTabId, 5);
  assert.equal(recovered.jobId, 'durable-job');
  assert.equal(recovered.kind, 'analysis');
});

test('replacement analysis continues in the existing chat without opening a fresh one', async () => {
  const { context, updates, sentMessages } = loadBackgroundHarness();
  context.chrome.storage.session.get = async () => ({ chatTabId: 42 });
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); };
  await context.runRepairAnalysis({ jobId: 'repair-job', count: 1, prompt: 'Return one replacement region.' }, 5);
  assert.equal(updates.length, 0, 'repair must not navigate away from the existing analysis conversation');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].tabId, 42);
  assert.equal(sentMessages[0].message.type, 'SD_CHATGPT_REPAIR_ANALYSIS');
  assert.equal(forwarded.length, 1, 'only the progress message is sent before task completion');
  await context.handleTaskResult({ jobId: 'repair-job', kind: 'analysis-repair', ok: true, regions: [{ xNorm: .1 }] }, 42);
  assert.equal(forwarded.at(-1).type, 'SPOT_DIFF_ANALYSIS_RESULT');
  assert.equal(forwarded.at(-1).payload.repair, true);
});

test('visual region verification stays in the analysis chat and returns a verified result', async () => {
  const { context, updates, sentMessages } = loadBackgroundHarness();
  context.chrome.storage.session.get = async () => ({ chatTabId: 42 });
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); };
  await context.runVerifyAnalysis({ jobId: 'verify-job', count: 10, imageDataUrl: 'data:image/jpeg;base64,AAAA', prompt: 'Verify every box.' }, 5);
  assert.equal(updates.length, 0);
  assert.equal(sentMessages[0].message.type, 'SD_CHATGPT_VERIFY_ANALYSIS');
  await context.handleTaskResult({ jobId: 'verify-job', kind: 'analysis-verify', ok: true, regions: [] }, 42);
  assert.equal(forwarded.at(-1).type, 'SPOT_DIFF_ANALYSIS_RESULT');
  assert.equal(forwarded.at(-1).payload.verified, true);
});

test('closing the creator or ChatGPT tab cancels the active automation job', async () => {
  const { context, removeListeners } = loadBackgroundHarness();
  const cancelled = [];
  context.cancelJob = async (jobId, appTabId) => { cancelled.push({ jobId, appTabId }); };
  vm.runInContext("activeJobs.set(42, { jobId: 'stuck-job', appTabId: 5, kind: 'edit' })", context);
  for (const listener of removeListeners) await listener(42);
  assert.deepEqual(cancelled, [{ jobId: 'stuck-job', appTabId: 5 }]);
});

test('cancellation tells the creator to return to a ready state', async () => {
  const { context } = loadBackgroundHarness();
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); };
  await context.cancelJob('cancel-me', 5);
  assert.equal(forwarded[0].type, 'SPOT_DIFF_JOB_CANCELLED');
  assert.equal(forwarded[0].payload.jobId, 'cancel-me');
});
