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

test('a generated-image placeholder is not mistaken for refusal and returns while Stop answering remains visible', async () => {
  const generatedImage = {
    src: 'https://example.test/generated.png',
    currentSrc: 'https://example.test/generated.png',
    naturalWidth: 0,
    naturalHeight: 0,
    getClientRects() { return [{}]; }
  };
  const message = {
    innerText: 'Edit',
    textContent: 'Edit',
    closest() { return this; },
    querySelector(selector) {
      if (selector === 'button[data-testid="copy-turn-action-button"]') return {};
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'img') return [generatedImage];
      return [];
    }
  };
  const stopNode = { getClientRects() { return [{}]; } };
  const documentMock = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector.includes('stop-button') || selector.includes('Stop answering')) return stopNode;
      if (selector === '[data-message-author-role="assistant"]') return message;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [message];
      if (selector === '[data-testid^="conversation-turn-"]') return [message];
      if (selector === 'img[alt^="Generated image:"]') return [generatedImage];
      return [];
    }
  };
  const exposedSource = adapterSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__spotDiffAdapterTest = { waitForEditedImage };})();'
  );
  const context = vm.createContext({
    document: documentMock,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } },
    setTimeout(callback, delay) {
      if (delay === 350) {
        generatedImage.naturalWidth = 1254;
        generatedImage.naturalHeight = 1254;
      }
      callback();
      return 1;
    },
    clearTimeout() {},
    setInterval,
    clearInterval,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(exposedSource, context);

  const result = await context.__spotDiffAdapterTest.waitForEditedImage(new Set(), 0, {});
  assert.equal(result.imageUrl, generatedImage.src);
});

test('prompt submission is not inferred from an unrelated assistant update', async () => {
  let now = 0;
  class DateMock extends Date {
    static now() { return now; }
  }
  class TextAreaMock {
    focus() {}
    dispatchEvent() {}
  }
  Object.defineProperty(TextAreaMock.prototype, 'value', {
    configurable: true,
    get() { return this._value || ''; },
    set(value) { this._value = value; }
  });
  const composer = new TextAreaMock();
  const send = { disabled: false, click() {} };
  const assistant = {
    innerText: 'Edit',
    textContent: 'Edit',
    closest() { return this; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const documentMock = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === '#prompt-textarea') return composer;
      if (selector === 'button[data-testid="send-button"]') return send;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistant];
      if (selector === '[data-testid^="conversation-turn-"]') return [assistant];
      return [];
    }
  };
  const exposedSource = adapterSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__spotDiffAdapterTest = { submitPrompt };})();'
  );
  const context = vm.createContext({
    document: documentMock,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } },
    Date: DateMock,
    Event: class EventMock {},
    HTMLTextAreaElement: TextAreaMock,
    HTMLInputElement: class InputMock {},
    setTimeout(callback, delay) { now += delay; callback(); return 1; },
    clearTimeout() {},
    setInterval,
    clearInterval,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(exposedSource, context);

  await assert.rejects(
    context.__spotDiffAdapterTest.submitPrompt('safe follow-up', {}),
    /did not submit the prompt/
  );
  assert.equal(composer.value, 'safe follow-up');
});
