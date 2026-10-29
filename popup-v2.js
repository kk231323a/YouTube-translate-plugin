// YouTube 中文字幕助手 - Popup
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const enabledEl = document.getElementById('enabled');
  const targetLangEl = document.getElementById('targetLang');
  const fontSizeEl = document.getElementById('fontSize');
  const fontSizeValueEl = document.getElementById('fontSizeValue');
  const bgOpacityEl = document.getElementById('bgOpacity');
  const bgOpacityValueEl = document.getElementById('bgOpacityValue');
  const pageStatusEl = document.getElementById('pageStatus');
  const pageStatusTextEl = document.getElementById('pageStatusText');
  const asrStatusEl = document.getElementById('asrStatus');
  const asrDetailEl = document.getElementById('asrDetail');
  const asrProgressEl = document.getElementById('asrProgress');
  const asrButtonEl = document.getElementById('asrButton');

  let activeTab = null;
  let asrRunning = false;
  let contentStatus = null;

  const [settings, tabs] = await Promise.all([
    chrome.storage.local.get([
      'enabled',
      'targetLang',
      'fontSize',
      'bgOpacity'
    ]),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);

  activeTab = tabs[0] || null;
  applySavedSettings(settings);
  await refreshState();
  bindEvents();

  function applySavedSettings(items) {
    enabledEl.checked = items.enabled !== false;
    targetLangEl.value = items.targetLang || 'zh-CN';
    fontSizeEl.value = items.fontSize || 18;
    fontSizeValueEl.textContent = `${fontSizeEl.value}px`;
    bgOpacityEl.value = Math.round(
      (items.bgOpacity === undefined ? 0.85 : items.bgOpacity) * 100
    );
    bgOpacityValueEl.textContent = `${bgOpacityEl.value}%`;
  }

  async function refreshState() {
    const isYouTube = Boolean(activeTab?.url?.startsWith('https://www.youtube.com/'));
    asrButtonEl.disabled = !isYouTube;

    if (!isYouTube) {
      setPageStatus('当前页面不是 YouTube 视频页', false);
      setAsrStatus('语音识别仅支持 YouTube 视频页');
      return;
    }

    try {
      contentStatus = await chrome.tabs.sendMessage(activeTab.id, {
        action: 'getStatus'
      });
    } catch {
      contentStatus = null;
    }

    if (contentStatus?.hasCaptions) {
      setPageStatus('已找到字幕，将优先提取并翻译成中文', true);
    } else if (!enabledEl.checked) {
      setPageStatus('字幕助手已关闭', false);
    } else {
      setPageStatus('正在查找原字幕或 YouTube 自动字幕', contentStatus?.enabled);
    }

    const state = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'asr:get-state'
    });

    asrRunning = Boolean(state?.running);
    updateAsrButton();
  }

  function bindEvents() {
    enabledEl.addEventListener('change', async () => {
      const enabled = enabledEl.checked;
      await chrome.storage.local.set({ enabled });
      await sendToContent({ action: 'toggle', value: enabled });
      await refreshState();
    });

    targetLangEl.addEventListener('change', async () => {
      const targetLang = targetLangEl.value;
      await chrome.storage.local.set({ targetLang });
      await sendToContent({ action: 'updateSettings', targetLang });
    });

    fontSizeEl.addEventListener('input', () => {
      fontSizeValueEl.textContent = `${fontSizeEl.value}px`;
    });
    fontSizeEl.addEventListener('change', async () => {
      const fontSize = Number(fontSizeEl.value);
      await chrome.storage.local.set({ fontSize });
      await sendToContent({ action: 'updateSettings', fontSize });
    });

    bgOpacityEl.addEventListener('input', () => {
      bgOpacityValueEl.textContent = `${bgOpacityEl.value}%`;
    });
    bgOpacityEl.addEventListener('change', async () => {
      const bgOpacity = Number(bgOpacityEl.value) / 100;
      await chrome.storage.local.set({ bgOpacity });
      await sendToContent({ action: 'updateSettings', bgOpacity });
    });

    asrButtonEl.addEventListener('click', async () => {
      if (!activeTab?.id) return;

      asrButtonEl.disabled = true;
      try {
        if (asrRunning) {
          setAsrStatus('正在停止语音识别');
          await chrome.runtime.sendMessage({
            target: 'background',
            type: 'asr:stop'
          });
          asrRunning = false;
        } else {
          setAsrStatus('正在接入标签页音频');
          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: activeTab.id
          });
          const result = await chrome.runtime.sendMessage({
            target: 'background',
            type: 'asr:start',
            tabId: activeTab.id,
            streamId
          });

          if (!result?.ok) {
            throw new Error(result?.error || '语音识别未能启动');
          }
          asrRunning = true;
        }
      } catch (error) {
        asrRunning = false;
        setAsrStatus(
          error instanceof Error ? error.message : '语音识别操作失败'
        );
      } finally {
        updateAsrButton();
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'background') return;
    if (!['asr:status', 'asr:segment'].includes(message.type)) return;

    if (message.type === 'asr:segment') {
      asrRunning = true;
      setAsrStatus('正在识别并翻译语音');
      updateAsrButton();
      return;
    }

    const payload = message.payload || {};
    if (payload.state === 'recording') {
      asrRunning = true;
      setAsrStatus(payload.message || '正在识别英文语音', payload);
    } else if (payload.state === 'transcribing') {
      asrRunning = true;
      setAsrStatus('正在识别并生成中文字幕', payload);
    } else if (payload.state === 'preparing' || payload.state === 'loading') {
      asrRunning = true;
      setAsrStatus(payload.message || '正在加载语音模型', payload);
    } else if (payload.state === 'stopped') {
      asrRunning = false;
      setAsrStatus('语音识别已停止');
    } else if (payload.state === 'error') {
      asrRunning = false;
      setAsrStatus(payload.message || '语音识别启动失败');
    }
    updateAsrButton();
  });

  async function sendToContent(message) {
    if (!activeTab?.id) return;
    try {
      await chrome.tabs.sendMessage(activeTab.id, message);
    } catch {
      // The YouTube page may have been refreshed.
    }
  }

  function setPageStatus(text, active) {
    pageStatusTextEl.textContent = text;
    pageStatusEl.classList.toggle('is-active', Boolean(active));
  }

  function setAsrStatus(text, payload = {}) {
    asrStatusEl.textContent = text;
    asrDetailEl.textContent = payload.queued
      ? `队列 ${payload.queued}`
      : '';

    const progress = Number(payload.progress);
    asrProgressEl.style.width = Number.isFinite(progress)
      ? `${Math.max(0, Math.min(100, progress))}%`
      : '0%';
  }

  function updateAsrButton() {
    asrButtonEl.disabled = !activeTab?.url?.startsWith('https://www.youtube.com/');
    asrButtonEl.classList.toggle('is-running', asrRunning);
    asrButtonEl.textContent = asrRunning
      ? '停止本地语音识别'
      : '开始本地语音识别';
  }
});
