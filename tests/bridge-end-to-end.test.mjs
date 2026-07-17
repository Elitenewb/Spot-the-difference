import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const backgroundCode = fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
const bridgeCode = fs.readFileSync(new URL('../chrome-extension/app-bridge.js', import.meta.url), 'utf8');

function storageArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter(key => key in store).map(key => [key, store[key]]));
    },
    async set(values) { Object.assign(store, values); },
    async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; }
  };
}

test('ten-region analysis reaches Creator after service worker memory loss', async () => {
  const sessionStore = {};
  const updateListeners = new Set();
  const bridgeRuntimeListeners = [];
  const pageListeners = [];
  const pageMessages = [];
  let backgroundListener;
  let backgroundContext;
  let creatorProgress = 10;
  let creatorRegions = [];

  const windowMock = {
    addEventListener(type, listener) { if (type === 'message') pageListeners.push(listener); },
    postMessage(message) {
      pageMessages.push(message);
      if (message.source === 'spot-diff-extension' && message.type === 'SPOT_DIFF_ANALYSIS_RESULT') {
        creatorRegions = message.payload.regions;
        if (creatorRegions.length === 10) creatorProgress = 14;
      }
    }
  };

  const bridgeChrome = {
    runtime: {
      onMessage: { addListener(listener) { bridgeRuntimeListeners.push(listener); } },
      sendMessage(message) {
        return new Promise(resolve => {
          const keepChannel = backgroundListener(message, { tab: { id: 5 } }, resolve);
          if (!keepChannel) queueMicrotask(() => resolve(undefined));
        });
      }
    }
  };

  const tenRegions = Array.from({ length: 10 }, (_, index) => ({
    xNorm: .03 + index * .08,
    yNorm: .1,
    wNorm: .05,
    hNorm: .05,
    changeType: 'add',
    instruction: `Add visible test detail ${index + 1}`
  }));

  const backgroundChrome = {
    storage: { session: storageArea(sessionStore) },
    runtime: {
      getManifest() { return { version: 'test' }; },
      onMessage: { addListener(listener) { backgroundListener = listener; } }
    },
    windows: {
      async create(options) { return { id: 91, tabs: [{ id: 77, windowId: 91, active: true, url: options.url }] }; },
      async get(windowId) { return { id: windowId }; }
    },
    tabs: {
      onUpdated: {
        addListener(listener) { updateListeners.add(listener); },
        removeListener(listener) { updateListeners.delete(listener); }
      },
      onRemoved: { addListener() {} },
      async create(options) { return { id: 77, ...options }; },
      async get(tabId) { return { id: tabId, windowId: 91 }; },
      async query() { return [{ id: 77, windowId: 91, active: true }]; },
      async remove() {},
      async update(tabId, options) {
        queueMicrotask(() => { for (const listener of updateListeners) listener(tabId, { status: 'complete' }); });
        return { id: tabId, ...options };
      },
      async sendMessage(tabId, message) {
        if (tabId === 77 && message.type === 'SD_CHATGPT_ANALYZE') {
          return new Promise(resolve => queueMicrotask(() => {
            vm.runInContext('activeJobs.clear()', backgroundContext);
            resolve({ ok: true, regions: tenRegions });
          }));
        }
        if (tabId === 5) {
          for (const listener of bridgeRuntimeListeners) listener(message);
          return { delivered: true };
        }
        throw new Error(`Unexpected tab message ${tabId} ${message.type}`);
      }
    }
  };

  backgroundContext = vm.createContext({ chrome: backgroundChrome, setTimeout, clearTimeout, queueMicrotask, fetch, Uint8Array, btoa });
  vm.runInContext(backgroundCode, backgroundContext);
  vm.runInNewContext(bridgeCode, { window: windowMock, chrome: bridgeChrome, globalThis: {} });

  const request = {
    source: 'spot-diff-app',
    type: 'SPOT_DIFF_ANALYZE',
    payload: { jobId: 'e2e-job', imageDataUrl: 'data:image/png;base64,AAAA', prompt: 'Return ten regions', count: 10 }
  };
  pageListeners[0]({ source: windowMock, data: request });

  const deadline = Date.now() + 2000;
  while (creatorRegions.length !== 10 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));

  assert.equal(creatorRegions.length, 10);
  assert.ok(creatorProgress > 10, 'Creator must advance beyond the stalled analysis percentage');
  assert.equal(sessionStore['activeJob:77'], undefined, 'completed routing state must be cleaned up');
  assert.ok(pageMessages.some(message => message.type === 'SPOT_DIFF_ANALYSIS_RESULT'));
});
