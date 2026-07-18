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
  assert.ok(manifest.permissions.includes('alarms'));
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
      sendMessage(message) { sent.push(message); return Promise.resolve(message.type === 'SPOT_DIFF_BRIDGE_PING' ? { ok: true } : { accepted: true }); },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } }
    }
  };
  const code = fs.readFileSync(new URL('../chrome-extension/app-bridge.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: windowMock, chrome: chromeMock });

  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_EXTENSION_PING' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_EXTENSION_PONG');
  assert.equal(sent[0].type, 'SPOT_DIFF_BRIDGE_PING');

  const tinyPng = 'data:image/png;base64,AAAA';
  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_ANALYZE', payload: { jobId: 'a', imageDataUrl: tinyPng, prompt: 'Choose regions', count: 10 } } });
  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'NOT_ALLOWED', payload: {} } });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'SPOT_DIFF_ANALYZE');
  assert.equal(sent[1].payload.jobId, 'a');

  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_REPAIR_ANALYSIS', payload: { jobId: 'a', prompt: 'Return one replacement region.', count: 1 } } });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].type, 'SPOT_DIFF_REPAIR_ANALYSIS');

  runtimeListeners[0]({ type: 'SPOT_DIFF_ANALYSIS_RESULT', payload: { jobId: 'a', regions: [] } });
  assert.equal(posted.at(-1).source, 'spot-diff-extension');
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_ANALYSIS_RESULT');

  runtimeListeners[0]({ type: 'SPOT_DIFF_JOB_CANCELLED', payload: { jobId: 'a' } });
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_JOB_CANCELLED');

  windowListeners[0]({ source: windowMock, data: { source: 'spot-diff-app', type: 'SPOT_DIFF_ANALYZE', payload: { jobId: 'bad', imageDataUrl: 'https://example.test/private.png', prompt: 'Upload this', count: 10 } } });
  assert.equal(sent.length, 3, 'invalid or remote image payload must not be relayed');
  runtimeListeners[0]({ type: 'SPOT_DIFF_UNEXPECTED', payload: { secret: true } });
  assert.equal(posted.at(-1).type, 'SPOT_DIFF_JOB_CANCELLED', 'unexpected background messages must not enter the page');
});

test('message protocol names agree across creator and extension layers', () => {
  const creator = fs.readFileSync(new URL('../creator.js', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../chrome-extension/app-bridge.js', import.meta.url), 'utf8');
  const background = fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  assert.ok(bridge.includes('SPOT_DIFF_BRIDGE_PING'));
  assert.ok(background.includes('SPOT_DIFF_BRIDGE_PING'));
  assert.ok(bridge.includes('try {\n      return Promise.resolve(chrome.runtime.sendMessage(message))'));
  for (const type of ['SPOT_DIFF_EDIT_ONE', 'SPOT_DIFF_CANCEL']) {
    assert.ok(creator.includes(type), `creator missing ${type}`);
    assert.ok(bridge.includes(type), `bridge missing ${type}`);
    assert.ok(background.includes(type), `background missing ${type}`);
  }
  for (const type of ['SPOT_DIFF_ANALYZE', 'SPOT_DIFF_REPAIR_ANALYSIS']) {
    assert.ok(!creator.includes(type), `creator should no longer invoke ${type}`);
    assert.ok(bridge.includes(type), `bridge missing legacy ${type} support`);
    assert.ok(background.includes(type), `background missing legacy ${type} support`);
  }
  assert.ok(bridge.includes('SPOT_DIFF_VERIFY_ANALYSIS'));
  assert.ok(background.includes('SPOT_DIFF_VERIFY_ANALYSIS'));
  assert.ok(!creator.includes('SPOT_DIFF_VERIFY_ANALYSIS'), 'Creator should not request a verification stage');
  assert.ok(!creator.includes('SPOT_DIFF_ANALYSIS_RESULT'), 'Creator should not accept AI-selected coordinates');
  for (const type of ['SPOT_DIFF_EDIT_RESULT', 'SPOT_DIFF_AI_PROGRESS', 'SPOT_DIFF_AI_ERROR', 'SPOT_DIFF_JOB_CANCELLED']) {
    assert.ok(creator.includes(type), `creator missing ${type}`);
    assert.ok(background.includes(type), `background missing ${type}`);
  }
});

test('creator and adapter include recovery guards for stalled website automation', () => {
  const creator = fs.readFileSync(new URL('../creator.js', import.meta.url), 'utf8');
  const creatorHtml = fs.readFileSync(new URL('../creator.html', import.meta.url), 'utf8');
  const player = fs.readFileSync(new URL('../player.html', import.meta.url), 'utf8');
  const adapter = fs.readFileSync(new URL('../chrome-extension/chatgpt-adapter.js', import.meta.url), 'utf8');
  const background = fs.readFileSync(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  assert.ok(!creator.includes('armJobTimer(240000'));
  assert.ok(creator.includes('armJobTimer(360000'));
  assert.ok(creator.includes('armJobTimer(360000'));
  assert.ok(creator.includes("failAi('Current ChatGPT job cancelled."));
  assert.ok(creator.includes('els.need.disabled=state.aiBusy'));
  assert.ok(creator.includes("'uploading','attached','submitted'"));
  assert.ok(adapter.includes('SD_CHATGPT_PROGRESS'));
  assert.ok(adapter.includes("reportProgress(payload, 'parsed'"));
  assert.ok(adapter.includes("message.type === 'SD_CHATGPT_PROBE_ANALYSIS'"));
  assert.ok(background.includes("const ANALYSIS_PROBE_PREFIX = 'analysisProbe:'"));
  assert.ok(background.includes('async function probeAnalysisResult(tabId)'));
  assert.ok(background.includes('async function restoreAnalysisProbes()'));
  assert.ok(adapter.includes('sendResponse({ ok: true, regions })'));
  assert.ok(adapter.includes('return true;'));
  assert.ok(adapter.includes("startTask('edit'"));
  assert.ok(adapter.includes('sendResponse({ accepted: true })'));
  assert.ok(adapter.includes("type: 'SD_CHATGPT_TASK_RESULT'"));
  assert.ok(background.includes("message.type === 'SD_CHATGPT_TASK_RESULT'"));
  assert.ok(background.includes('async function handleTaskResult(payload, chatTabId)'));
  assert.ok(background.includes("const ACTIVE_JOB_PREFIX = 'activeJob:'"));
  assert.ok(background.includes('async function rememberActiveJob(tabId, job)'));
  assert.ok(background.includes('chrome.storage.session.set({ [activeJobKey(tabId)]: job })'));
  assert.ok(background.includes('async function activeJobFor(tabId)'));
  assert.ok(background.includes('await rememberActiveJob(tab.id, job)'));
  assert.ok(adapter.includes("input.files?.length !== 1"));
  assert.ok(adapter.includes('attachmentPreview'));
  assert.ok(adapter.includes('composerAttachmentReady(name)'));
  assert.ok(adapter.includes('attempt <= 3'));
  assert.ok(adapter.includes("ChatGPT did not show the analysis image as an attachment"));
  assert.ok(adapter.indexOf('await uploadImage(payload.imageDataUrl') < adapter.indexOf('await submitPrompt(payload.prompt'), 'an analysis prompt must be submitted only after its image upload completes');
  assert.ok(!adapter.includes("assistant: ['[data-message-author-role=\"assistant\"]', 'article"));
  assert.ok(background.includes('for (let attempt = 0; attempt < 2; attempt++)'));
  assert.ok(background.includes('async function cancelJob(jobId, appTabId)'));
  assert.ok(background.includes('chrome.tabs.onRemoved.addListener'));
  assert.ok(creator.includes("postToExtension('SPOT_DIFF_CANCEL',{jobId})"));
  assert.ok(creator.includes("window.addEventListener('pagehide'"));
  assert.ok(background.includes("chrome.storage.session.remove(['chatTabId', 'chatWindowId'])"));
  assert.ok(background.includes("chrome.windows.create({ url: CHATGPT_URL, focused: false, type: 'normal' })"));
  assert.ok(background.includes('active: true'));
  assert.ok(background.includes("runInFreshChat(message, job, temporary = true)"));
  assert.ok(background.includes("false\n    );"), 'edit jobs should use regular chat mode');
  assert.ok(creator.includes('TOOL POLICY: Do not call Adobe, Photoshop, Canva'));
  assert.ok(creator.includes('Do not open an external editor or ask for tool permission'));
  assert.ok(creator.includes("function expectedCount(){ return state.mode==='ai'?10"));
  assert.ok(creator.includes("instruction:state.mode==='ai'?'':defaultInstruction()"));
  assert.ok(creator.includes("if(state.regions.length!==expectedCount()){ updateSelectionStatus(); return; }"));
  const workflow=creator.slice(creator.indexOf('function startAiWorkflow()'),creator.indexOf('function startEditQueue('));
  assert.ok(!workflow.includes('startAnalysis()'), 'manual AI workflow must not ask ChatGPT to choose coordinates');
  assert.ok(workflow.includes('startEditQueue(pending)'));
  assert.ok(creator.includes('const AUTO_EDIT_VARIANTS = ['));
  assert.ok(creator.includes('clean removal or erasure'));
  assert.ok(creator.includes('color, pattern, or material change'));
  assert.ok(creator.includes('adding one scene-appropriate object'));
  assert.ok(creator.includes('swapping one existing item, letter, number, symbol'));
  assert.ok(creator.includes('gently silly transformation'));
  assert.ok(creator.includes('playful face edits such as changing glasses'));
  assert.ok(creator.includes('Never add, remove, replace, or alter a mustache'));
  assert.ok(creator.includes('Perform this requested change: ${instruction}'));
  assert.ok(creator.includes("const instruction=String(region.instruction||'').trim()"));
  assert.ok(creator.includes("Never move a whole limb, change a person's pose"));
  assert.ok(creator.includes("checkExtensionBtn.hidden=kind!=='error'"));
  assert.ok(creatorHtml.includes('Upload a photo'));
  assert.ok(creatorHtml.includes('Mark 10 change areas'));
  assert.ok(creatorHtml.includes('Boxes are fixed once drawn; use Undo'));
  assert.ok(creatorHtml.includes('id="aiUndoBtn"'));
  assert.ok(creatorHtml.includes('id="aiRegionCount">0 / 10'));
  assert.ok(creatorHtml.includes('Generate the puzzle'));
  assert.ok(creatorHtml.includes('Download the finished puzzle'));
  assert.ok(creatorHtml.includes('<summary>Advanced options</summary>'));
  assert.ok(creatorHtml.includes('Leave an instruction blank and ChatGPT will choose'));
  assert.ok(creatorHtml.includes('id="aiProgressBar"'));
  assert.ok(creator.includes("els.aiGenerateBtn.textContent='Cancel generation'"));
  assert.ok(creator.includes("els.aiGenerateBtn.addEventListener('click',()=>state.aiBusy?cancelAi():startAiWorkflow())"));
  assert.ok(creator.includes("if(type==='SPOT_DIFF_JOB_CANCELLED'"));
  assert.ok(creatorHtml.includes('id="aiProgressText">0%</span>'));
  assert.ok(creatorHtml.includes('body.ai-simple #origCard{display:none}'));
  assert.ok(creator.includes('drawGuide(els.modCanvas,region)'));
  assert.ok(creator.includes("if(state.mode==='manual')drawGuide(els.origCanvas,region)"));
  assert.ok(creator.includes("state.editQueue=regions.map(region=>{region.status='queued';return region.id;})"));
  assert.ok(creator.includes('prompt:editPrompt(region,crop.geometry'));
  assert.ok(creator.includes("textarea').disabled=!['pending','queued'].includes"));
  assert.ok(!creator.includes('data-action="generate"'));
  assert.ok(!creator.includes('data-action="download"'));
  assert.ok(!creator.includes('data-action="upload"'));
  assert.ok(creator.includes("if(!state.naturalW||state.regions.length>=expectedCount()"));
  assert.ok(!creator.includes("if(state.mode==='ai'||!state.naturalW"));
  assert.ok(creator.includes('function editStageProgress(stage)'));
  assert.ok(creator.includes("setAiProgress(15+(state.editCompleted/state.editTotal)*85)"));
  assert.match(creatorHtml, /id="aiTab"[^>]*aria-selected="true"[^>]*>AI with ChatGPT<\/button>/);
  assert.match(creatorHtml, /id="manualTab"[^>]*aria-selected="false"[^>]*>Manual upload<\/button>/);
  assert.ok(creator.includes("mode:'ai'"));
  const ids=[...creatorHtml.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'creator element IDs must remain unique');
  assert.ok(adapter.includes('SD_CHATGPT_REPAIR_ANALYSIS'));
  assert.ok(adapter.includes('SD_CHATGPT_VERIFY_ANALYSIS'));
  assert.ok(background.includes('runVerifyAnalysis(message.payload, sender.tab.id)'));
  assert.ok(!creator.includes('requestRegionVerification'));
  assert.ok(!creator.includes('analysisVerificationPasses'));
  assert.ok(creator.includes('drawGuide(els.modCanvas,region)'));
  assert.ok(creator.includes("do not crop, zoom, pan, translate, rotate, stretch, extend, or reframe"));
  assert.ok(creator.includes('function normalizeEditFrame(image,geometry)'));
  assert.ok(creator.includes('function editFrameSourceRect(image,geometry)'));
  assert.ok(creator.includes('safe-area compositor below instead of rejecting a visually valid result'));
  assert.ok(!creator.includes('EDIT_FRAME_MISMATCH'));
  assert.ok(!creator.includes('EDIT_OFF_TARGET'));
  assert.ok(creator.includes('const side=Math.min(maxSide'));
  assert.ok(creator.includes('cropW:side,cropH:side'));
  assert.ok(creator.includes('applyW:applyRight-applyX'));
  assert.ok(creator.includes('function revealBounds(region)'));
  assert.ok(creator.includes('return reveal?{xNorm,yNorm,wNorm,hNorm,reveal}'));
  assert.ok(player.includes('function revealToCss(region)'));
  assert.ok(player.includes('return regionToCss(region.reveal || region)'));
  assert.ok(player.includes('const b = revealToCss(cfg.regions[idx])'));
  assert.ok(creator.includes('The only editable subject is the feature intersecting the center point'));
  assert.ok(creator.includes('Directional words such as left, right, upper, lower, top, or bottom refer to the original full image'));
  assert.ok(creator.includes('must never override the target rectangle in this crop'));
  assert.ok(creatorHtml.includes('creator.js?v=17'));
  assert.ok(background.includes('runRepairAnalysis(payload, appTabId)'));
  assert.ok(adapter.includes('responseComplete'));
  assert.ok(adapter.includes('function composerIsEmpty()'));
  assert.ok(adapter.includes('responseInProgress'));
  assert.ok(adapter.includes('beforeAssistantCount'));
  assert.ok(adapter.includes('Prompt click sent; waiting for ChatGPT’s response'));
  assert.ok(adapter.includes('60000, \'ChatGPT did not acknowledge the prompt.\''));
  assert.ok(adapter.includes('composerIsEmpty() && responseComplete && !responseInProgress()'));
  assert.ok(adapter.includes('images.length && responseSettled'));
  assert.ok(adapter.includes('last?.querySelector(selector)'));
  assert.ok(adapter.includes('if (text && responseComplete && responseSettled && !newImages.length)'));
  assert.ok(adapter.includes('return { error: text.slice(0, 500) }'));
  assert.ok(adapter.includes('Adjust the edit prompt so the output will be acceptable under image-safety policy'));
  assert.ok(adapter.includes('refusalFollowupSent'));
  assert.ok(adapter.includes('ChatGPT returned text instead of an image; requesting an acceptable alternative'));
  assert.ok(adapter.includes('allMatches(SELECTORS.generatedImage)'));
  assert.ok(adapter.includes('filter(isVisible)'));
  assert.ok(adapter.includes("conversationTurn: ['[data-testid^=\"conversation-turn-\"]']"));
  assert.ok(adapter.includes('waitForAnalysis(beforeSignatures)'));
  assert.ok(adapter.includes('function regionsFromParsedJson(parsed)'));
  assert.ok(adapter.includes('return isSingleRegion ? [parsed] : null'));
  assert.ok(adapter.includes('function waitForDomMutation(getter)'));
  assert.ok(adapter.includes('new MutationObserver(check)'));
  assert.ok(adapter.includes('setInterval(check, 1000)'));
  assert.ok(adapter.includes('return waitForDomMutation(() =>'));
  assert.ok(adapter.includes('function isUserTurn(element)'));
  assert.ok(adapter.includes('.filter(turn => !isUserTurn(turn))'));
  assert.ok(adapter.includes('allMatches(SELECTORS.conversationTurn)'));
  assert.ok(adapter.includes('function regionResponseSignatures()'));
  assert.ok(!adapter.includes('ChatGPT did not return parseable region JSON within three minutes'));
  assert.ok(!adapter.includes('if (firstMatch(SELECTORS.stop)) return null'));
  assert.ok(adapter.includes('if (!beforeSignatures.has(JSON.stringify(regions))) return regions'));
  assert.ok(adapter.includes("viewerImage: ['[role=\"dialog\"] img']"));
  assert.ok(adapter.includes("300000, 'ChatGPT did not return a retrievable edited image within five minutes.'"));
});
