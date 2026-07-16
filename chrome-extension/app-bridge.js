(() => {
  'use strict';

  const allowedTypes = new Set(['SPOT_DIFF_ANALYZE', 'SPOT_DIFF_VERIFY_ANALYSIS', 'SPOT_DIFF_REPAIR_ANALYSIS', 'SPOT_DIFF_EDIT_ONE', 'SPOT_DIFF_CANCEL']);
  const returnedTypes = new Set(['SPOT_DIFF_ANALYSIS_RESULT', 'SPOT_DIFF_EDIT_PROGRESS', 'SPOT_DIFF_EDIT_RESULT', 'SPOT_DIFF_AI_PROGRESS', 'SPOT_DIFF_AI_ERROR', 'SPOT_DIFF_JOB_CANCELLED']);

  function validText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
  function validImage(value) { return validText(value, 25_000_000) && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value); }
  function validRequest(type, payload) {
    if (!payload || !validText(payload.jobId, 120)) return false;
    if (type === 'SPOT_DIFF_ANALYZE' || type === 'SPOT_DIFF_VERIFY_ANALYSIS') {
      return validImage(payload.imageDataUrl) && validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
    }
    if (type === 'SPOT_DIFF_REPAIR_ANALYSIS') {
      return validText(payload.prompt, 12_000) && Number.isInteger(payload.count) && payload.count >= 1 && payload.count <= 30;
    }
    if (type === 'SPOT_DIFF_CANCEL') return true;
    const edit = payload.edit;
    return edit && validText(edit.regionId, 120) && validImage(edit.imageDataUrl) && validText(edit.prompt, 12_000);
  }

  function reportRuntimeError(error, jobId) {
    window.postMessage({
      source: 'spot-diff-extension',
      type: 'SPOT_DIFF_AI_ERROR',
      payload: { jobId, message: error?.message || 'The extension background worker could not be reached. Refresh this Creator tab after reloading the extension.' }
    }, '*');
  }

  function sendToRuntime(message, jobId, reportErrors = true) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(error => {
        if (reportErrors) reportRuntimeError(error, jobId);
        return null;
      });
    } catch (error) {
      if (reportErrors) reportRuntimeError(error, jobId);
      return Promise.resolve(null);
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'spot-diff-app') return;
    const { type, payload } = event.data;
    if (type === 'SPOT_DIFF_EXTENSION_PING') {
      sendToRuntime({ type: 'SPOT_DIFF_BRIDGE_PING' }, null, false).then(response => {
        if (response?.ok) window.postMessage({ source: 'spot-diff-extension', type: 'SPOT_DIFF_EXTENSION_PONG' }, '*');
      });
      return;
    }
    if (!allowedTypes.has(type) || !validRequest(type, payload)) return;
    sendToRuntime({ type, payload }, payload?.jobId);
  });

  chrome.runtime.onMessage.addListener(message => {
    if (!returnedTypes.has(message?.type)) return;
    window.postMessage({ source: 'spot-diff-extension', type: message.type, payload: message.payload }, '*');
  });
})();
