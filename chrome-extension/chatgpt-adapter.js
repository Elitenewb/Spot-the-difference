(() => {
  'use strict';

  // Keep UI-specific selectors in this one block. ChatGPT UI changes should only require edits here.
  const SELECTORS = {
    composer: ['#prompt-textarea', 'textarea[data-id="root"]', 'div[contenteditable="true"][data-placeholder]', 'div[contenteditable="true"]'],
    fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    attach: ['button[data-testid="composer-plus-btn"]', 'button[aria-label*="Attach"]', 'button[aria-label*="Add files"]', 'button[aria-label*="Upload"]'],
    attachmentPreview: [
      '[data-testid*="attachment-preview"]', '[data-testid*="uploaded-file"]', '[data-testid*="file-upload"]',
      'button[aria-label*="Remove attachment"]', 'button[aria-label*="Remove file"]', 'button[aria-label*="Remove image"]'
    ],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send"]'],
    assistant: ['[data-message-author-role="assistant"]'],
    user: ['[data-message-author-role="user"]'],
    conversationTurn: ['[data-testid^="conversation-turn-"]'],
    generatedCard: ['[role="button"] img[alt^="Generated image:"]'],
    generatedImage: ['img[alt^="Generated image:"]'],
    viewerImage: ['[role="dialog"] img'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]']
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const firstMatch = selectors => selectors.map(selector => document.querySelector(selector)).find(Boolean) || null;
  const allMatches = selectors => [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
  const isVisible = element => !!element && element.getClientRects().length > 0;

  function reportProgress(payload, stage, message) {
    if (!payload?.jobId) return;
    chrome.runtime.sendMessage({
      type: 'SD_CHATGPT_PROGRESS',
      payload: { jobId: payload.jobId, regionId: payload.regionId, stage, message }
    }).catch(() => {});
  }

  async function waitFor(getter, timeoutMs, message) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = getter();
      if (result) return result;
      await sleep(350);
    }
    throw new Error(message);
  }

  function waitForDomMutation(getter) {
    const immediate = getter();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(interval);
        document.removeEventListener('load', check, true);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        try {
          const result = getter();
          if (result) finish(result);
        } catch (error) {
          finish(null, error);
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      document.addEventListener('load', check, true);
      const interval = setInterval(check, 1000);
      check();
    });
  }

  function dataUrlToFile(dataUrl, name) {
    const [header, encoded] = dataUrl.split(',');
    const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  async function findFileInput() {
    let input = firstMatch(SELECTORS.fileInput);
    if (input) return input;
    const attach = firstMatch(SELECTORS.attach);
    if (attach) attach.click();
    input = await waitFor(() => firstMatch(SELECTORS.fileInput), 10000, 'Could not find ChatGPT’s image upload control.');
    return input;
  }

  function composerAttachmentReady(name) {
    const composer = firstMatch(SELECTORS.composer);
    const root = composer?.closest('form') || composer?.parentElement?.parentElement || document.body;
    const namedAttachment = [...root.querySelectorAll('img, [role="button"], button, span, div')]
      .some(element => isVisible(element) && (
        element.getAttribute('alt')?.includes(name) ||
        element.getAttribute('aria-label')?.includes(name) ||
        element.textContent?.includes(name)
      ));
    const visiblePreview = SELECTORS.attachmentPreview
      .flatMap(selector => [...root.querySelectorAll(selector)])
      .some(element => isVisible(element));
    const composerImage = [...root.querySelectorAll('img')]
      .some(image => isVisible(image) && image.getBoundingClientRect().width >= 32 && image.getBoundingClientRect().height >= 32);
    // uploadImage runs before prompt text is inserted. At that point an enabled
    // Send button is evidence that an attachment, rather than text, is ready.
    const send = firstMatch(SELECTORS.send);
    return namedAttachment || visiblePreview || composerImage || !!(send && !send.disabled);
  }

  async function stageImage(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    if (input.files?.length !== 1 || input.files[0]?.name !== file.name) {
      throw new Error('ChatGPT did not accept the selected image file.');
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function uploadImage(dataUrl, name, payload) {
    const file = dataUrlToFile(dataUrl, name);
    reportProgress(payload, 'attached', 'Waiting for ChatGPT to finish attaching the image…');
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const input = await findFileInput();
      await stageImage(input, file);
      try {
        await waitFor(() => composerAttachmentReady(name), 15000, 'Attachment preview did not appear.');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(1000);
      }
    }
    if (lastError) throw new Error('ChatGPT did not show the analysis image as an attachment after three attempts. The prompt was not sent; reload the extension and retry.');
    // Do not rely on an enabled Send button alone: ChatGPT enables it for text
    // after the prompt is inserted. Here we detect it before inserting any text,
    // then leave extra time for ChatGPT's image processing to settle.
    await sleep(1500);
  }

  function setComposerText(element, text) {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return;
    }
    element.textContent = '';
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    element.appendChild(paragraph);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  }

  async function submitPrompt(prompt, payload, beforeCount) {
    const composer = await waitFor(() => firstMatch(SELECTORS.composer), 30000, 'ChatGPT’s composer was not found. Sign in, then try again.');
    setComposerText(composer, prompt);
    const send = await waitFor(() => {
      const button = firstMatch(SELECTORS.send);
      return button && !button.disabled ? button : null;
    }, 45000, 'ChatGPT’s Send button did not become available after the image was attached.');
    send.click();
    reportProgress(payload, 'submitted', 'Prompt sent. Waiting for ChatGPT’s response…');
    await waitFor(() => {
      const text = composer.innerText || composer.textContent || composer.value || '';
      return !text.trim() || assistantMessages().length > beforeCount || firstMatch(SELECTORS.stop);
    }, 12000, 'ChatGPT did not submit the prompt. Open the ChatGPT tab, confirm the attachment finished uploading, then retry.');
  }

  function assistantMessages() {
    const direct = allMatches(SELECTORS.assistant);
    const directTurns = direct.map(element => element.closest('[data-testid^="conversation-turn-"]') || element);
    const modernTurns = allMatches(SELECTORS.conversationTurn).filter(element => {
      if (element.querySelector('[data-message-author-role="assistant"]')) return true;
      if (element.querySelector(SELECTORS.generatedImage.join(','))) return true;
      return [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .some(heading => /^ChatGPT said:?$/i.test(heading.textContent?.trim() || ''));
    });
    const candidates = [...new Set([...directTurns, ...modernTurns])];
    return candidates.filter(element => element.textContent?.trim() || element.querySelector('img'));
  }

  function isUserTurn(element) {
    if (element.querySelector(SELECTORS.user.join(','))) return true;
    return [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .some(heading => /^You said:?$/i.test(heading.textContent?.trim() || ''));
  }

  function extractJson(text) {
    const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const starts = [cleaned.indexOf('['), cleaned.indexOf('{')].filter(index => index >= 0).sort((a,b) => a-b);
    if (!starts.length) return null;
    const start = starts[0];
    for (let end = cleaned.length; end > start; end--) {
      try { return JSON.parse(cleaned.slice(start, end)); } catch (_) {}
    }
    return null;
  }

  function regionsFromParsedJson(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.regions)) return parsed.regions;
    const isSingleRegion = parsed && typeof parsed === 'object' &&
      ['xNorm', 'yNorm', 'wNorm', 'hNorm'].every(key => Number.isFinite(Number(parsed[key]))) &&
      typeof (parsed.instruction || parsed.prompt) === 'string';
    return isSingleRegion ? [parsed] : null;
  }

  function regionResponseCandidates() {
    const fallbackTurns = allMatches(SELECTORS.conversationTurn).filter(turn => !isUserTurn(turn));
    return [...new Set([...assistantMessages(), ...fallbackTurns])];
  }

  function regionsInMessage(message) {
    const parsed = extractJson(message.innerText || message.textContent || '');
    return parsed ? regionsFromParsedJson(parsed) : null;
  }

  function regionResponseSignatures() {
    return new Set(regionResponseCandidates().map(regionsInMessage).filter(Array.isArray).map(regions => JSON.stringify(regions)));
  }

  function latestRegionResponse() {
    for (const message of regionResponseCandidates().reverse()) {
      const regions = regionsInMessage(message);
      if (Array.isArray(regions)) return regions;
    }
    return null;
  }

  async function probeAnalysis() {
    // A message from the service worker wakes a throttled background tab. Give
    // ChatGPT's queued render work a moment to settle, then inspect once more.
    let regions = latestRegionResponse();
    if (regions) return regions;
    await sleep(1000);
    return latestRegionResponse();
  }

  async function waitForAnalysis(beforeSignatures) {
    return waitForDomMutation(() => {
      const candidates = regionResponseCandidates().reverse();
      for (const message of candidates) {
        const regions = regionsInMessage(message);
        if (!Array.isArray(regions)) continue;
        if (!beforeSignatures.has(JSON.stringify(regions))) return regions;
      }
      return null;
    });
  }

  async function waitForEditedImage(beforeUrls, beforeCount, payload) {
    let openedCard = false;
    const result = await waitFor(() => {
      const messages = assistantMessages();
      const responseMessages = messages.slice(beforeCount);
      const last = responseMessages[responseMessages.length - 1] || messages[messages.length - 1];
      const generatedImage = responseMessages
        .flatMap(message => [...message.querySelectorAll(SELECTORS.generatedCard.join(','))])
        .find(image => !beforeUrls.has(image.currentSrc || image.src));
      const card = generatedImage?.closest('[role="button"]');
      if (card && !openedCard) {
        openedCard = true;
        reportProgress(payload, 'opening', 'Opening ChatGPT’s generated image…');
        card.click();
        return null;
      }
      const scopedImages = responseMessages.flatMap(message => [...message.querySelectorAll('img')]);
      const viewerImages = allMatches(SELECTORS.viewerImage);
      const images = [...new Set([...scopedImages, ...viewerImages])].filter(image => {
        const source = image.currentSrc || image.src;
        return source && !beforeUrls.has(source) && image.naturalWidth >= 256 && image.naturalHeight >= 256;
      });
      if (images.length) return { image: images[images.length - 1] };
      if (messages.length > beforeCount && !firstMatch(SELECTORS.stop)) {
        const text = (last.innerText || last.textContent || '').trim();
        if (/\b(?:unavailable|unable|cannot|can't|could not|not available)\b/i.test(text)) return { error: text.slice(0, 500) };
      }
      return null;
    }, 300000, 'ChatGPT did not return a retrievable edited image within five minutes.');
    if (result.error) throw new Error(result.error);
    await waitFor(() => !firstMatch(SELECTORS.stop), 120000, 'ChatGPT’s image generation did not finish.').catch(() => true);
    await sleep(1200);
    const source = result.image.currentSrc || result.image.src;
    if (source.startsWith('data:')) return { imageDataUrl: source };
    if (source.startsWith('blob:')) {
      const blob = await fetch(source).then(response => response.blob());
      return { imageDataUrl: await blobToDataUrl(blob) };
    }
    return { imageUrl: source };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
  }

  async function runAnalysis(payload) {
    const beforeSignatures = regionResponseSignatures();
    const before = assistantMessages().length;
    reportProgress(payload, 'uploading', 'Uploading the analysis image to ChatGPT…');
    await uploadImage(payload.imageDataUrl, 'spot-original.jpg', payload);
    await submitPrompt(payload.prompt, payload, before);
    const regions = await waitForAnalysis(beforeSignatures);
    reportProgress(payload, 'parsed', `Parsed ${regions.length} region suggestions from ChatGPT.`);
    return regions;
  }

  async function runRepairAnalysis(payload) {
    const beforeSignatures = regionResponseSignatures();
    const before = assistantMessages().length;
    reportProgress(payload, 'submitted', 'Requesting replacement suggestions from ChatGPT…');
    await submitPrompt(payload.prompt, payload, before);
    return waitForAnalysis(beforeSignatures);
  }

  async function runVerifyAnalysis(payload) {
    const beforeSignatures = regionResponseSignatures();
    const before = assistantMessages().length;
    reportProgress(payload, 'uploading', 'Uploading the numbered region review to ChatGPT…');
    await uploadImage(payload.imageDataUrl, 'spot-regions-review.jpg', payload);
    await submitPrompt(payload.prompt, payload, before);
    return waitForAnalysis(beforeSignatures);
  }

  async function runEdit(payload) {
    const before = assistantMessages().length;
    const beforeUrls = new Set([...document.images].map(image => image.src));
    reportProgress(payload, 'uploading', 'Uploading this crop to ChatGPT…');
    await uploadImage(payload.imageDataUrl, 'spot-crop.png', payload);
    await submitPrompt(payload.prompt, payload, before);
    return waitForEditedImage(beforeUrls, before, payload);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SD_CHATGPT_PROBE_ANALYSIS') {
      probeAnalysis().then(regions => sendResponse({ ok: true, pending: !regions, regions })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'SD_CHATGPT_ANALYZE') {
      runAnalysis(message.payload).then(regions => sendResponse({ ok: true, regions })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'SD_CHATGPT_REPAIR_ANALYSIS') {
      runRepairAnalysis(message.payload).then(regions => sendResponse({ ok: true, regions })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'SD_CHATGPT_VERIFY_ANALYSIS') {
      runVerifyAnalysis(message.payload).then(regions => sendResponse({ ok: true, regions })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'SD_CHATGPT_EDIT') {
      runEdit(message.payload).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });
})();
