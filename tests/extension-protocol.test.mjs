import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(fs.readFileSync(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8'));

test('extension permissions stay narrowly scoped', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.includes('https://chatgpt.com/*'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('webRequest'));
  const creatorMatches = manifest.content_scripts[0].matches;
  assert.ok(creatorMatches.every(pattern => pattern.includes('/creator.html')));
});

test('extension popup opens the hosted creator instead of a standalone ChatGPT tab', () => {
  const popup = fs.readFileSync(new URL('../chrome-extension/popup.js', import.meta.url), 'utf8');
  const popupHtml = fs.readFileSync(new URL('../chrome-extension/popup.html', import.meta.url), 'utf8');
  assert.ok(popup.includes("https://elitenewb.github.io/Spot-the-difference/index.html"));
  assert.ok(popup.includes("https://elitenewb.github.io/Spot-the-difference/*"));
  assert.ok(!popup.includes('openChatGpt'));
  assert.match(popupHtml, /id="openSpotDiff">Open Spot the Difference<\/button>/);
});

test('creator bridge responds to ping and relays only allowed requests', async () => {
  const posted = [];
  const windowListeners = [];
  const runtimeListeners = [];
  const sent = [];
  const windowMock = {
    addEventListener(type, listener) { if (type === 'message') windowListeners.push(listener); },
    postMessage(message) { posted.push(message); }
  };
  const chromeMock = {
    runtime: {
      sendMessage(message) { sent.push(message); return Promise.resolve({ accepted: true }); },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } }
    }
  };
  const code = fs.readFileSync(new URL('../chrome-extension/app-bridge.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: windowMock, chrome: chromeMock });

  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_EXTENSION_PING' } });
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_EXTENSION_PONG');

  const tinyPng = 'data:image/png;base64,AAAA';
  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_ANALYZE', payload: { jobId: 'a', imageDataUrl: tinyPng, prompt: 'Choose regions', count: 10 } } });
  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'NOT_ALLOWED', payload: {} } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'SPOT_DIFF_ANALYZE');
  assert.equal(sent[0].payload.jobId, 'a');

  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_REPAIR_ANALYSIS', payload: { jobId: 'a', prompt: 'Return one replacement region.', count: 1 } } });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'SPOT_DIFF_REPAIR_ANALYSIS');

  runtimeListeners[0]({ type: 'SPOT_DIFF_ANALYSIS_RESULT', payload: { jobId: 'a', regions: [] } });
  assert.equal(posted.at(-1).source, 'spot-diff-extension');
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_ANALYSIS_RESULT');

  runtimeListeners[0]({ type: 'SPOT_DIFF_JOB_CANCELLED', payload: { jobId: 'a' } });
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_JOB_CANCELLED');

  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_ANALYZE', payload: { jobId: 'bad', imageDataUrl: 'https://example.test/private.png', prompt: 'Upload this', count: 10 } } });
  assert.equal(sent.length, 2, 'invalid or remote image payload must not be relayed');
  runtimeListeners[0]({ type: 'SPOT_DIFF_UNEXPECTED', payload: { secret: true } });
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_JOB_CANCELLED', 'unexpected background messages must not enter the page');
});

test('message protocol names agree across creator and extension layers', () => {
  const creator = fs.readFileSync(new URL('../creator.js', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../chrome-extension/app-bridge.js', import.meta.url), 'utf8');
  const background = fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  for (const type of ['SPOT_DIFF_ANALYZE', 'SPOT_DIFF_REPAIR_ANALYSIS', 'SPOT_DIFF_EDIT_ONE', 'SPOT_DIFF_CANCEL']) {
    assert.ok(creator.includes(type), `creator missing ${type}`);
    assert.ok(bridge.includes(type), `bridge missing ${type}`);
    assert.ok(background.includes(type), `background missing ${type}`);
  }
  for (const type of ['SPOT_DIFF_ANALYSIS_RESULT', 'SPOT_DIFF_EDIT_RESULT', 'SPOT_DIFF_AI_PROGRESS', 'SPOT_DIFF_AI_ERROR', 'SPOT_DIFF_JOB_CANCELLED']) {
    assert.ok(creator.includes(type), `creator missing ${type}`);
    assert.ok(background.includes(type), `background missing ${type}`);
  }
});

test('creator and adapter include recovery guards for stalled website automation', () => {
  const creator = fs.readFileSync(new URL('../creator.js', import.meta.url), 'utf8');
  const creatorHtml = fs.readFileSync(new URL('../creator.html', import.meta.url), 'utf8');
  const adapter = fs.readFileSync(new URL('../chrome-extension/chatgpt-adapter.js', import.meta.url), 'utf8');
  const background = fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  assert.ok(creator.includes('armJobTimer(240000'));
  assert.ok(creator.includes('armJobTimer(360000'));
  assert.ok(creator.includes("failAi('Current ChatGPT job cancelled."));
  assert.ok(creator.includes('els.need.disabled=state.aiBusy'));
  assert.ok(creator.includes("'uploading','attached','submitted'"));
  assert.ok(adapter.includes('SD_CHATGPT_PROGRESS'));
  assert.ok(adapter.includes("input.files?.length !== 1"));
  assert.ok(adapter.includes('attachmentPreview'));
  assert.ok(adapter.includes("ChatGPT did not show the analysis image as an attachment"));
  assert.ok(adapter.indexOf('await uploadImage(payload.imageDataUrl') < adapter.indexOf('await submitPrompt(payload.prompt'), 'an analysis prompt must be submitted only after its image upload completes');
  assert.ok(!adapter.includes("assistant: ['[data-message-author-role=\"assistant\"]', 'article"));
  assert.ok(background.includes('for (let attempt = 0; attempt < 2; attempt++)'));
  assert.ok(background.includes('async function cancelJob(jobId, appTabId)'));
  assert.ok(background.includes('chrome.tabs.onRemoved.addListener'));
  assert.ok(creator.includes("postToExtension('SPOT_DIFF_CANCEL',{jobId})"));
  assert.ok(creator.includes("window.addEventListener('pagehide'"));
  assert.ok(background.includes("chrome.storage.session.remove('chatTabId')"));
  assert.ok(background.includes("runInFreshChat(message, job, temporary = true)"));
  assert.ok(background.includes("false\n    );"), 'edit jobs should opt out of temporary chat mode');
  assert.ok(!creator.includes("Do not use Adobe, Photoshop, Canva"));
  assert.ok(creator.includes('requestMissingRegions(validation)'));
  assert.ok(creator.includes('requesting ${missing} replacement'));
  assert.ok(creator.includes('use at least 0.025'));
  assert.ok(creator.includes('region.wNorm<=.018'));
  assert.ok(creator.includes('the proposed change is too small to find at normal viewing size'));
  assert.ok(creator.includes('at least 6 of every 10 suggestions'));
  assert.ok(creator.includes("region.changeType==='color'"));
  assert.ok(creator.includes('maximum of two color-only changes'));
  assert.ok(creator.includes("startEditQueue(state.regions.filter(region=>region.status!=='done'))"));
  assert.ok(creator.includes("checkExtensionBtn.hidden=kind!=='error'"));
  assert.ok(creator.includes('substantial playful changes'));
  assert.ok(creatorHtml.includes('Upload a photo'));
  assert.ok(creatorHtml.includes('Generate the puzzle'));
  assert.ok(creatorHtml.includes('Download the finished puzzle'));
  assert.ok(creatorHtml.includes('<summary>Advanced options</summary>'));
  assert.ok(creatorHtml.includes('id="aiProgressBar"'));
  assert.ok(creator.includes("els.analyzeBtn.textContent='Cancel generation'"));
  assert.ok(creator.includes("els.analyzeBtn.addEventListener('click',()=>state.aiBusy?cancelAi():startAiWorkflow())"));
  assert.ok(creator.includes("if(type==='SPOT_DIFF_JOB_CANCELLED'"));
  assert.ok(creatorHtml.includes('id="aiProgressText">0%</span>'));
  assert.ok(creatorHtml.includes('body.ai-simple #origCard{display:none}'));
  assert.ok(creator.includes("if(state.mode==='manual')for(const region of state.regions)"));
  assert.ok(creator.includes("if(state.mode==='ai'||!state.naturalW"));
  assert.ok(creator.includes('function editStageProgress(stage)'));
  assert.ok(creator.includes("setAiProgress(15+(state.editCompleted/state.editTotal)*85)"));
  assert.match(creatorHtml, /id="aiTab"[^>]*aria-selected="true"[^>]*>AI with ChatGPT<\/button>/);
  assert.match(creatorHtml, /id="manualTab"[^>]*aria-selected="false"[^>]*>Manual upload<\/button>/);
  assert.ok(creator.includes("mode:'ai'"));
  const ids=[...creatorHtml.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'creator element IDs must remain unique');
  assert.ok(adapter.includes('SD_CHATGPT_REPAIR_ANALYSIS'));
  assert.ok(background.includes('runRepairAnalysis(payload, appTabId)'));
  assert.ok(adapter.includes("unavailable|unable|cannot|can't|could not|not available"));
  assert.ok(adapter.includes("conversationTurn: ['[data-testid^=\"conversation-turn-\"]']"));
  assert.ok(adapter.includes('waitForAnalysis(beforeCount, beforeTurnCount)'));
  assert.ok(adapter.includes('allMatches(SELECTORS.conversationTurn).slice(beforeTurnCount).reverse()'));
  assert.ok(adapter.includes('waitForAnalysis(before, beforeTurns)'));
  assert.ok(adapter.includes("generatedCard: ['[role=\"button\"] img[alt^=\"Generated image:\"]']"));
  assert.ok(adapter.includes("viewerImage: ['[role=\"dialog\"] img']"));
  assert.ok(adapter.includes("300000, 'ChatGPT did not return a retrievable edited image within five minutes.'"));
});
