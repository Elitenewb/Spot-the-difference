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
  const createdAlarms = [];
  const clearedAlarms = [];
  const alarmStore = new Map();
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
    alarms: {
      async create(name, options) { createdAlarms.push({ name, options }); alarmStore.set(name, { name, ...options }); },
      async get(name) { return alarmStore.get(name); },
      async clear(name) { clearedAlarms.push(name); return alarmStore.delete(name); },
      onAlarm: { addListener() {} }
    },
    windows: {
      async create(options) {
        creations.push(options);
        return { id: 91, focused: options.focused, tabs: [{ id: 77, windowId: 91, url: options.url, active: true }] };
      },
      async get(windowId) { return { id: windowId }; }
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
      async create(options) { return { id: 77, ...options }; },
      async get(tabId) { return { id: tabId, windowId: 91 }; },
      async query() { return [{ id: 77, windowId: 91, active: true }]; },
      async remove() {},
      async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); return { ok: true, regions: [] }; }
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
  return { context, updates, creations, sentMessages, removeListeners, sessionStore, createdAlarms, clearedAlarms, alarmStore };
}

test('analysis uses temporary chat while crop editing uses regular chat', async () => {
  const { context, updates } = loadBackgroundHarness();
  await context.openFreshChat(10, true);
  await context.openFreshChat(11, false);
  assert.match(updates[0].url, /temporary-chat=true/);
  assert.doesNotMatch(updates[1].url, /temporary-chat=true/);
  assert.match(updates[0].url, /spotJob=/);
  assert.match(updates[1].url, /spotJob=/);
  assert.equal(updates[0].active, true);
  assert.equal(updates[1].active, true);
});

test('ChatGPT opens active in its own unfocused window behind Creator', async () => {
  const { context, creations } = loadBackgroundHarness();
  const tab = await context.getChatGptTab();
  assert.equal(creations.length, 1);
  assert.equal(creations[0].focused, false);
  assert.equal(creations[0].type, 'normal');
  assert.equal(tab.active, true);
});

test('subsequent jobs reuse the saved unfocused ChatGPT window', async () => {
  const { context, creations, updates, sessionStore } = loadBackgroundHarness();
  sessionStore.chatTabId = 42;
  sessionStore.chatWindowId = 91;

  const tab = await context.getChatGptTab();

  assert.equal(tab.id, 42);
  assert.equal(creations.length, 0);
  assert.deepEqual(updates, [{ tabId: 42, active: true }]);
});

test('fresh-chat runner retries once after losing its ChatGPT tab', async () => {
  const { context } = loadBackgroundHarness();
  let sends = 0;
  context.chrome.tabs.sendMessage = async () => {
    sends++;
    if (sends <= 15) throw new Error('Receiving end does not exist');
    return { ok: true };
  };
  const result = await context.runInFreshChat(
    { type: 'SD_CHATGPT_EDIT', payload: { jobId: 'job' } },
    { appTabId: 1, jobId: 'job', kind: 'edit' },
    false
  );
  assert.equal(result.ok, true);
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

test('an accepted image edit stays routed until its separate completion event arrives', async () => {
  const { context, sessionStore } = loadBackgroundHarness();
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); return true; };
  context.chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.type === 'SD_CHATGPT_EDIT') return { accepted: true };
    throw new Error(`Unexpected message ${message.type}`);
  };

  await context.runEdit({
    jobId: 'edit-job',
    edit: {
      regionId: 'region-1',
      imageDataUrl: 'data:image/png;base64,AAAA',
      prompt: 'Make one harmless localized change.'
    }
  }, 5);

  assert.equal(forwarded.length, 1, 'acceptance should only emit the opening progress update');
  assert.equal(sessionStore['activeJob:77'].jobId, 'edit-job', 'the completion route must outlive the initial message');

  vm.runInContext('activeJobs.clear()', context);
  assert.equal(await context.handleTaskResult({
    jobId: 'edit-job',
    regionId: 'region-1',
    kind: 'edit',
    ok: true,
    imageDataUrl: 'data:image/png;base64,BBBB'
  }, 77), true);

  assert.equal(forwarded.at(-1).type, 'SPOT_DIFF_EDIT_RESULT');
  assert.equal(forwarded.at(-1).payload.imageDataUrl, 'data:image/png;base64,BBBB');
  assert.equal(sessionStore['activeJob:77'], undefined);
});

test('alarm probe wakes a background analysis tab and forwards ten regions after worker memory loss', async () => {
  const { context, sessionStore, createdAlarms, clearedAlarms } = loadBackgroundHarness();
  const regions = Array.from({ length: 10 }, (_, index) => ({ xNorm: index / 20, yNorm: .1, wNorm: .04, hNorm: .04, instruction: `Region ${index + 1}` }));
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); return true; };
  context.chrome.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 42);
    assert.equal(message.type, 'SD_CHATGPT_PROBE_ANALYSIS');
    return { ok: true, regions };
  };
  await context.rememberActiveJob(42, { appTabId: 5, jobId: 'probe-job', kind: 'analysis' });
  vm.runInContext('activeJobs.clear()', context);

  assert.equal(await context.probeAnalysisResult(42), true);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].type, 'SPOT_DIFF_ANALYSIS_RESULT');
  assert.equal(forwarded[0].payload.regions.length, 10);
  assert.equal(sessionStore['activeJob:42'], undefined);
  assert.equal(sessionStore['completedJob:probe-job'], true);
  assert.equal(createdAlarms[0].name, 'analysisProbe:42');
  assert.ok(clearedAlarms.includes('analysisProbe:42'));
});

test('worker startup recreates a missing probe alarm from persisted analysis state', async () => {
  const { context, sessionStore, createdAlarms, alarmStore } = loadBackgroundHarness();
  sessionStore['activeJob:42'] = { appTabId: 5, jobId: 'restored-job', kind: 'analysis' };
  alarmStore.clear();
  createdAlarms.length = 0;

  await context.restoreAnalysisProbes();

  assert.equal(createdAlarms.length, 1);
  assert.equal(createdAlarms[0].name, 'analysisProbe:42');
  assert.equal(createdAlarms[0].options.periodInMinutes, 0.5);
});

test('replacement analysis continues in the existing chat without opening a fresh one', async () => {
  const { context, updates, sentMessages } = loadBackgroundHarness();
  context.chrome.storage.session.get = async () => ({ chatTabId: 42, chatWindowId: 91 });
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); };
  await context.runRepairAnalysis({ jobId: 'repair-job', count: 1, prompt: 'Return one replacement region.' }, 5);
  assert.ok(updates.every(update => !update.url), 'repair may reselect the dedicated tab but must not navigate away from the analysis conversation');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].tabId, 42);
  assert.equal(sentMessages[0].message.type, 'SD_CHATGPT_REPAIR_ANALYSIS');
  assert.equal(forwarded.length, 2, 'the delayed adapter response must be forwarded before the request completes');
  assert.equal(forwarded.at(-1).type, 'SPOT_DIFF_ANALYSIS_RESULT');
  assert.equal(forwarded.at(-1).payload.repair, true);
});

test('visual region verification stays in the analysis chat and returns a verified result', async () => {
  const { context, updates, sentMessages } = loadBackgroundHarness();
  context.chrome.storage.session.get = async () => ({ chatTabId: 42, chatWindowId: 91 });
  const forwarded = [];
  context.forward = async (_tabId, type, payload) => { forwarded.push({ type, payload }); };
  await context.runVerifyAnalysis({ jobId: 'verify-job', count: 10, imageDataUrl: 'data:image/jpeg;base64,AAAA', prompt: 'Verify every box.' }, 5);
  assert.ok(updates.every(update => !update.url));
  assert.equal(sentMessages[0].message.type, 'SD_CHATGPT_VERIFY_ANALYSIS');
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
