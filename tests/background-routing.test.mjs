import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadBackgroundHarness() {
  const updates = [];
  const updateListeners = new Set();
  const chrome = {
    storage: {
      session: {
        async get() { return {}; },
        async set() {},
        async remove() {}
      }
    },
    tabs: {
      onUpdated: {
        addListener(listener) { updateListeners.add(listener); },
        removeListener(listener) { updateListeners.delete(listener); }
      },
      async update(tabId, options) {
        updates.push({ tabId, ...options });
        queueMicrotask(() => {
          for (const listener of updateListeners) listener(tabId, { status: 'complete' });
        });
        return { id: tabId, ...options };
      },
      async create() { return { id: 77 }; },
      async get(tabId) { return { id: tabId }; },
      async remove() {},
      async sendMessage() { return { ok: true, regions: [] }; }
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
  return { context, updates };
}

test('analysis uses temporary chat while crop editing uses regular chat', async () => {
  const { context, updates } = loadBackgroundHarness();
  await context.openFreshChat(10, true);
  await context.openFreshChat(11, false);
  assert.match(updates[0].url, /temporary-chat=true/);
  assert.doesNotMatch(updates[1].url, /temporary-chat=true/);
  assert.match(updates[0].url, /spotJob=/);
  assert.match(updates[1].url, /spotJob=/);
});

test('fresh-chat runner retries once after losing its ChatGPT tab', async () => {
  const { context } = loadBackgroundHarness();
  let sends = 0;
  context.chrome.tabs.sendMessage = async () => {
    sends++;
    if (sends <= 15) throw new Error('Receiving end does not exist');
    return { ok: true, imageDataUrl: 'data:image/png;base64,AAAA' };
  };
  const result = await context.runInFreshChat(
    { type: 'SD_CHATGPT_EDIT', payload: { jobId: 'job' } },
    { appTabId: 1, jobId: 'job', kind: 'edit' },
    false
  );
  assert.equal(result.ok, true);
  assert.equal(sends, 16);
});
