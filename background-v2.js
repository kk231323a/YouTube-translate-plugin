// YouTube 中文字幕助手 - Background Service Worker
'use strict';

const OFFSCREEN_DOCUMENT = 'offscreen.html';
const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: 'zh-CN',
  fontSize: 18,
  bgOpacity: 0.85
};

let creatingOffscreen = null;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) missing[key] = value;
  }

  if (Object.keys(missing).length) {
    await chrome.storage.local.set(missing);
  }
});

async function hasOffscreenDocument() {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: ['USER_MEDIA'],
        justification: '捕获当前 YouTube 标签页音频并运行本地 Whisper 语音识别'
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function sendToTab(tabId, message) {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The page may have navigated or been closed.
  }
}

async function translateText(text, targetLang) {
  if (!text?.trim()) return '';

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', targetLang || 'zh-CN');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`翻译请求失败: ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.[0])
      ? data[0]
          .filter((item) => item?.[0])
          .map((item) => item[0])
          .join('')
          .trim()
      : '';
  } finally {
    clearTimeout(timeout);
  }
}

async function startSpeechRecognition(message) {
  await ensureOffscreenDocument();
  await chrome.storage.session.set({ asrTabId: message.tabId });

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'asr:start',
    tabId: message.tabId,
    streamId: message.streamId
  });

  if (!response?.ok) {
    await chrome.storage.session.remove('asrTabId');
    throw new Error(response?.error || '语音识别未能启动');
  }

  return response;
}

async function stopSpeechRecognition() {
  const { asrTabId } = await chrome.storage.session.get('asrTabId');

  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'asr:stop'
      });
    } catch {
      // Closing the offscreen document below is sufficient if it is gone.
    }
  }

  await chrome.storage.session.remove('asrTabId');
  await closeOffscreenDocument();
  await sendToTab(asrTabId, {
    action: 'asrStatus',
    state: 'stopped',
    message: '语音识别已停止'
  });

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'translate:request': {
          try {
            const translated = await translateText(
              message.text,
              message.targetLang
            );
            sendResponse({ ok: true, text: translated });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          break;
        }
        case 'asr:start':
          sendResponse(await startSpeechRecognition(message));
          break;
        case 'asr:stop':
          sendResponse(await stopSpeechRecognition());
          break;
        case 'asr:get-state': {
          const { asrTabId } = await chrome.storage.session.get('asrTabId');
          sendResponse({
            ok: true,
            running: Boolean(asrTabId),
            tabId: asrTabId || null
          });
          break;
        }
        case 'asr:status':
        case 'asr:segment': {
          const tabId = message.tabId;
          await sendToTab(tabId, {
            action: message.type === 'asr:segment' ? 'asrSegment' : 'asrStatus',
            ...message.payload
          });

          if (message.type === 'asr:status' && ['stopped', 'error'].includes(message.payload?.state)) {
            await chrome.storage.session.remove('asrTabId');
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知的后台请求' });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { asrTabId } = await chrome.storage.session.get('asrTabId');
  if (tabId === asrTabId) {
    await stopSpeechRecognition();
  }
});
