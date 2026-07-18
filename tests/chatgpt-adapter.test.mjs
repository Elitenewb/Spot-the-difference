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

test('a generated image is returned only after the completed turn loses its Stop control', async () => {
  let pollCount = 0;
  let responseSettled = false;
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
  const composer = { innerText: '', textContent: '', value: '' };
  const documentMock = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if ((selector.includes('stop-button') || selector.includes('Stop answering')) && !responseSettled) return stopNode;
      if (selector === '#prompt-textarea') return composer;
      if (selector === '[data-message-author-role="assistant"]') return message;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [message];
      if (selector === '[data-testid^="conversation-turn-"]') return [message];
      if (selector === 'img[alt^="Generated image:"]') return [generatedImage];
      if ((selector.includes('stop-button') || selector.includes('Stop answering')) && !responseSettled) return [stopNode];
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
        pollCount++;
        if (pollCount === 1) {
          generatedImage.naturalWidth = 1254;
          generatedImage.naturalHeight = 1254;
        }
        if (pollCount === 2) responseSettled = true;
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
  assert.equal(pollCount, 2, 'a loaded image alone must not finish while Stop remains visible');
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

  const accepted = await context.__spotDiffAdapterTest.submitPrompt('safe follow-up', {});
  assert.equal(accepted, false, 'an unrelated existing assistant turn must not count as submission');
  assert.equal(composer.value, 'safe follow-up');
});

test('prompt submission is accepted when a new assistant turn appears before the composer clears', async () => {
  let now = 0;
  let pollCount = 0;
  const assistantTurns = [];
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
    innerText: 'Thinking',
    textContent: 'Thinking',
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
      if (selector === '[data-message-author-role="assistant"]') return assistantTurns;
      if (selector === '[data-testid^="conversation-turn-"]') return assistantTurns;
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
    setTimeout(callback, delay) {
      now += delay;
      if (delay === 350 && ++pollCount === 1) assistantTurns.push(assistant);
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

  const accepted = await context.__spotDiffAdapterTest.submitPrompt('safe follow-up', {}, 0);
  assert.equal(accepted, true);
  assert.equal(composer.value, 'safe follow-up');
});

test('a completed image edit is delivered as a separate acknowledged task result', async () => {
  const delivered = [];
  const documentMock = {
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    images: []
  };
  const exposedSource = adapterSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__spotDiffAdapterTest = { startTask };})();'
  );
  const context = vm.createContext({
    document: documentMock,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          delivered.push(message);
          return { received: true };
        }
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(exposedSource, context);

  await context.__spotDiffAdapterTest.startTask(
    'edit',
    { jobId: 'edit-job', regionId: 'region-1' },
    async () => ({ imageUrl: 'https://example.test/generated.png' })
  );

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 'SD_CHATGPT_TASK_RESULT');
  assert.equal(delivered[0].payload.ok, true);
  assert.equal(delivered[0].payload.jobId, 'edit-job');
  assert.equal(delivered[0].payload.imageUrl, 'https://example.test/generated.png');
});
