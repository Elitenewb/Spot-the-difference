import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const adapterSource = fs.readFileSync(new URL('../chrome-extension/chatgpt-adapter.js', import.meta.url), 'utf8');

test('analysis remains observable after background polling is throttled', async () => {
  let intervalCallback;
  let responseReady = false;

  class MutationObserverMock {
    observe() {}
    disconnect() {}
  }

  const documentMock = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };

  const exposedSource = adapterSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__spotDiffAdapterTest = { waitForDomMutation, waitForAnalysis, probeAnalysis };})();'
  );
  const context = vm.createContext({
    document: documentMock,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } },
    MutationObserver: MutationObserverMock,
    setTimeout,
    clearTimeout,
    setInterval(callback) { intervalCallback = callback; return 2; },
    clearInterval() {},
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(exposedSource, context);

  const pending = context.__spotDiffAdapterTest.waitForDomMutation(
    () => responseReady ? ['ten', 'regions'] : null
  );
  await Promise.resolve();
  responseReady = true;
  intervalCallback();

  assert.deepEqual(await pending, ['ten', 'regions']);
});

test('analysis accepts complete JSON while ChatGPT still exposes a Stop control', async () => {
  const regions = Array.from({ length: 10 }, (_, index) => ({
    xNorm: index / 20,
    yNorm: .1,
    wNorm: .04,
    hNorm: .04,
    changeType: 'add',
    instruction: `Add detail ${index + 1}`
  }));
  const responseText = JSON.stringify(regions);
  const responseNode = {
    innerText: responseText,
    textContent: responseText,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return this; }
  };
  const stopNode = {};
  const documentMock = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector.includes('stop-button') || selector.includes('Stop generating')) return stopNode;
      if (selector === '[data-message-author-role="assistant"]') return responseNode;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [responseNode];
      if (selector === '[data-testid^="conversation-turn-"]') return [responseNode];
      return [];
    }
  };
  class MutationObserverMock {
    observe() {}
    disconnect() {}
  }
  const exposedSource = adapterSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__spotDiffAdapterTest = { waitForDomMutation, waitForAnalysis, probeAnalysis };})();'
  );
  const context = vm.createContext({
    document: documentMock,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } },
    MutationObserver: MutationObserverMock,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(exposedSource, context);

  const parsed = await context.__spotDiffAdapterTest.waitForAnalysis(new Set());
  assert.equal(parsed.length, 10);
  assert.equal(parsed[0].instruction, 'Add detail 1');
  const probed = await context.__spotDiffAdapterTest.probeAnalysis();
  assert.equal(probed.length, 10);
});
