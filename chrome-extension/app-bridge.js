(() => {
  'use strict';

  const allowedTypes = new Set(['SPOT_DIFF_ANALYZE', 'SPOT_DIFF_REPAIR_ANALYSIS', 'SPOT_DIFF_EDIT_ONE', 'SPOT_DIFF_CANCEL']);
  const returnedTypes = new Set(['SPOT_DIFF_ANALYSIS_RESULT', 'SPOT_DIFF_EDIT_PROGRESS', 'SPOT_DIFF_EDIT_RESULT', 'SPOT_DIFF_AI_PROGRESS', 'SPOT_DIFF_AI_ERROR', 'SPOT_DIFF_JOB_CANCELLED']);

  function validText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
  function validImage(value) { return validText(value, 25_000_000) && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value); }
  function validRequest(type, payload) {
    if (!payload || !validText(payload.jobId, 120)) return false;
    if (type === 'SPOT_DIFF_ANALYZE') {
      return validImage(payload.imageDataUrl) && validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
    }
    if (type === 'SPOT_DIFF_REPAIR_ANALYSIS') {
      return validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
    }
    if (type === 'SPOT_DIFF_CANCEL') return true;
    const edit = payload.edit;
    return edit && validText(edit.regionId, 120) && validImage(edit.imageDataUrl) && validText(edit.prompt, 12_000);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'spot-diff-app') return;
    const { type, payload } = event.data;
    if (type === 'SPOT_DIFF_EXTENSION_PING') {
      window.postMessage({ source: 'spot-diff-extension', type: 'SPOT_DIFF_EXTENSION_PONG' }, '*');
      return;
    }
    if (!allowedTypes.has(type) || !validRequest(type, payload)) return;
    chrome.runtime.sendMessage({ type, payload }).catch(error => {
      window.postMessage({
        source: 'spot-diff-extension',
        type: 'SPOT_DIFF_AI_ERROR',
        payload: { jobId: payload?.jobId, message: error.message || 'The extension background worker could not be reached.' }
      }, '*');
    });
  });

  chrome.runtime.onMessage.addListener(message => {
    if (!returnedTypes.has(message?.type)) return;
    window.postMessage({ source: 'spot-diff-extension', type: message.type, payload: message.payload }, '*');
  });
})();
