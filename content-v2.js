// YouTube 中文字幕助手 - Content Script
'use strict';

(() => {
  const DEFAULTS = {
    enabled: true,
    targetLang: 'zh-CN',
    fontSize: 18,
    bgOpacity: 0.85
  };

  const CHINESE_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const CHINESE_TEXT_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const LATIN_LETTER_RE = /[A-Za-z]/g;
  const SUBTITLE_MAX_GAP_SECONDS = 6.5;
  const SUBTITLE_MAX_CHARS = 180;
  const BRIDGE_SOURCE = 'yt-cn-caption-bridge';
  const CONTENT_SOURCE = 'yt-cn-content';

  let enabled = DEFAULTS.enabled;
  let targetLang = DEFAULTS.targetLang;
  let subtitleFontSize = DEFAULTS.fontSize;
  let subtitleBgOpacity = DEFAULTS.bgOpacity;

  let captions = [];
  let captionMode = 'none';
  let sourceCaptionLanguage = '';
  let currentCaption = null;
  let currentVideoId = null;
  let loadSequence = 0;
  let subtitleSequence = 0;

  let panelEl = null;
  let textEl = null;
  let statusEl = null;
  let playerEl = null;
  let videoEl = null;
  let lastNavigationUrl = location.href;

  let injectionTimer = null;
  let captionCheckInterval = null;
  let navigationObserver = null;
  let nativeCaptionObserver = null;
  let nativeCaptionTimer = null;
  let videoListenersAttached = false;

  const translationCache = new Map();
  const translationInFlight = new Map();
  const localTranslators = new Map();
  let languageDetectorPromise = null;
  let prefetchQueue = [];
  let prefetchQueuedKeys = new Set();
  let prefetchRunning = false;
  let prefetchGeneration = 0;
  let lastPrefetchCheck = 0;
  let asrState = 'idle';
  let asrAnchor = null;
  let bridgedTracks = new Map();
  let bridgeTrackOrder = 0;

  chrome.storage.local.get(Object.keys(DEFAULTS), (items) => {
    enabled = items.enabled !== false;
    targetLang = items.targetLang || DEFAULTS.targetLang;
    subtitleFontSize = Number(items.fontSize) || DEFAULTS.fontSize;
    subtitleBgOpacity =
      items.bgOpacity === undefined ? DEFAULTS.bgOpacity : Number(items.bgOpacity);

    if (enabled) init();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    if (message.action === 'toggle') {
      enabled = Boolean(message.value);
      if (enabled) {
        init();
      } else {
        destroy();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === 'updateSettings') {
      applySettings(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === 'asrStatus') {
      handleAsrStatus(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === 'asrSegment') {
      handleAsrSegment(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === 'getStatus') {
      sendResponse({
        ok: true,
        enabled,
        captionMode,
        hasCaptions: captions.length > 0,
        asrState,
        videoId: currentVideoId
      });
      return false;
    }

    return false;
  });

  window.addEventListener('message', handleBridgeMessage);

  function init() {
    if (!panelEl) createPanel();
    watchNavigation();
    tryInjectPanel();

    if (!injectionTimer) {
      injectionTimer = setInterval(() => {
        if (!enabled) return;
        if (tryInjectPanel() && captionMode !== 'none') {
          clearInterval(injectionTimer);
          injectionTimer = null;
        }
      }, 800);
    }
  }

  function destroy() {
    loadSequence += 1;
    subtitleSequence += 1;

    if (panelEl) panelEl.remove();
    panelEl = null;
    textEl = null;
    statusEl = null;
    playerEl = null;

    if (injectionTimer) {
      clearInterval(injectionTimer);
      injectionTimer = null;
    }
    if (captionCheckInterval) {
      clearInterval(captionCheckInterval);
      captionCheckInterval = null;
    }
    if (nativeCaptionTimer) {
      clearTimeout(nativeCaptionTimer);
      nativeCaptionTimer = null;
    }
    if (nativeCaptionObserver) {
      nativeCaptionObserver.disconnect();
      nativeCaptionObserver = null;
    }
    if (navigationObserver) {
      navigationObserver.disconnect();
      navigationObserver = null;
    }

    document.removeEventListener('yt-navigate-finish', handleNavigation);
    detachVideoListeners();
    document.documentElement.classList.remove('yt-cn-showing-subtitles');

    captions = [];
    captionMode = 'none';
    currentCaption = null;
    currentVideoId = null;
    sourceCaptionLanguage = '';
    translationCache.clear();
    translationInFlight.clear();
    localTranslators.clear();
    languageDetectorPromise = null;
    prefetchQueue = [];
    prefetchQueuedKeys.clear();
    prefetchGeneration += 1;
    bridgedTracks.clear();
    bridgeTrackOrder = 0;
    asrAnchor = null;
    asrState = 'idle';
  }

  function applySettings(settings) {
    if (settings.targetLang && settings.targetLang !== targetLang) {
      targetLang = settings.targetLang;
      translationCache.clear();
      translationInFlight.clear();
      localTranslators.clear();
      currentCaption = null;
    }

    if (settings.fontSize) {
      subtitleFontSize = Number(settings.fontSize);
      applyPanelAppearance();
    }

    if (settings.bgOpacity !== undefined) {
      subtitleBgOpacity = Number(settings.bgOpacity);
      applyPanelAppearance();
    }
  }

  function createPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'yt-cn-subtitle-panel';
    panelEl.setAttribute('aria-live', 'polite');
    panelEl.setAttribute('translate', 'no');

    textEl = document.createElement('div');
    textEl.id = 'yt-cn-subtitle-text';
    textEl.textContent = '正在获取字幕';

    statusEl = document.createElement('span');
    statusEl.id = 'yt-cn-status';
    statusEl.textContent = '准备中';

    panelEl.append(textEl, statusEl);
    applyPanelAppearance();
  }

  function applyPanelAppearance() {
    if (!panelEl) return;
    panelEl.style.setProperty('--yt-cn-font-size', `${subtitleFontSize}px`);
    panelEl.style.setProperty('--yt-cn-bg-alpha', String(subtitleBgOpacity));
  }

  function getVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function getPlayerContainer() {
    return (
      document.querySelector('#movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.querySelector('#player-container') ||
      document.querySelector('ytd-watch-flexy #player-container-outer')
    );
  }

  function tryInjectPanel() {
    if (!enabled || !panelEl) return false;

    const videoId = getVideoId();
    if (!videoId) {
      if (panelEl.parentElement) panelEl.remove();
      currentVideoId = null;
      return false;
    }

    const nextPlayer = getPlayerContainer();
    if (!nextPlayer) return false;

    playerEl = nextPlayer;
    if (panelEl.parentElement !== playerEl) {
      playerEl.appendChild(panelEl);
    }

    if (videoId !== currentVideoId) {
      currentVideoId = videoId;
      resetForVideo(videoId);
    }

    return true;
  }

  function resetForVideo(videoId) {
    loadSequence += 1;
    subtitleSequence += 1;

    captions = [];
    captionMode = 'none';
    currentCaption = null;
    sourceCaptionLanguage = '';
    translationCache.clear();
    translationInFlight.clear();
    localTranslators.clear();
    prefetchQueue = [];
    prefetchQueuedKeys.clear();
    prefetchGeneration += 1;
    bridgedTracks.clear();
    bridgeTrackOrder = 0;
    lastPrefetchCheck = 0;
    asrAnchor = null;

    textEl.textContent = '正在获取字幕';
    setStatus('准备中');
    document.documentElement.classList.remove('yt-cn-showing-subtitles');

    detachVideoListeners();
    videoEl =
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video');

    startCaptionMonitor(videoId);
  }

  function startCaptionMonitor(videoId) {
    if (captionCheckInterval) {
      clearInterval(captionCheckInterval);
      captionCheckInterval = null;
    }

    if (!videoEl) {
      let retries = 0;
      captionCheckInterval = setInterval(() => {
        retries += 1;
        videoEl =
          document.querySelector('video.html5-main-video') ||
          document.querySelector('video');

        if (videoEl) {
          clearInterval(captionCheckInterval);
          captionCheckInterval = null;
          startCaptionMonitor(videoId);
        } else if (retries >= 40) {
          clearInterval(captionCheckInterval);
          captionCheckInterval = null;
          showNoCaptionsMessage('正在等待视频播放');
        }
      }, 500);
      return;
    }

    attachVideoListeners();
    ensureNativeCaptionObserver();

    const sequence = ++loadSequence;
    loadCaptionData(videoId).then((result) => {
      if (!enabled || sequence !== loadSequence || videoId !== currentVideoId) return;

      if (result?.captions?.length) {
        captions = result.captions;
        captionMode = 'track';
        sourceCaptionLanguage = result.language || '';
        textEl.textContent = '';
        setStatus(result.usedYoutubeTranslation ? '中文译轨' : '字幕就绪');
        ensureTranslationPrefetchWindow(true);
        onTimeUpdate();
        return;
      }

      const captionsEnabled = enableYoutubeCaptions();
      requestBridgeCaptions();

      if (!captionsEnabled) {
        showNoCaptionsMessage(
          '没有找到可用字幕。若视频包含英文语音，可打开插件启用本地语音识别。'
        );
      } else {
        textEl.textContent = '正在读取 YouTube 原生字幕';
        setStatus('等待字幕');
      }
    });

    captionCheckInterval = setInterval(onTimeUpdate, 250);
  }

  function attachVideoListeners() {
    if (!videoEl || videoListenersAttached) return;
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('play', onTimeUpdate);
    videoEl.addEventListener('seeked', onTimeUpdate);
    videoListenersAttached = true;
  }

  function detachVideoListeners() {
    if (!videoEl || !videoListenersAttached) return;
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    videoEl.removeEventListener('play', onTimeUpdate);
    videoEl.removeEventListener('seeked', onTimeUpdate);
    videoListenersAttached = false;
  }

  function watchNavigation() {
    if (!navigationObserver) {
      document.addEventListener('yt-navigate-finish', handleNavigation);
      navigationObserver = new MutationObserver(() => {
        if (location.href === lastNavigationUrl) return;
        lastNavigationUrl = location.href;
        if (!enabled) return;
        setTimeout(tryInjectPanel, 500);
      });
      navigationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }
  }

  function handleNavigation() {
    if (!enabled) return;
    setTimeout(() => {
      tryInjectPanel();
      ensureNativeCaptionObserver();
    }, 500);
  }

  async function loadCaptionData(videoId) {
    try {
      const playerData = await getPlayerData(videoId);
      if (!playerData) return null;

      const tracks = getCaptionTracks(playerData);
      if (!tracks.length) return null;

      const rankedTracks = rankCaptionTracks(tracks, playerData);

      for (const track of rankedTracks.slice(0, 5)) {
        try {
          const sourceData = await fetchTimedText(track.baseUrl);
          const parsed = parseTimedText(sourceData);
          if (!parsed.length) continue;

          return {
            captions: parsed,
            language: track.languageCode || 'auto',
            usedYoutubeTranslation: false
          };
        } catch (error) {
          console.debug('[YT-CN] 字幕轨不可用，尝试下一轨:', error);
        }
      }

      return null;
    } catch (error) {
      console.debug('[YT-CN] 获取字幕失败:', error);
      return null;
    }
  }

  async function getPlayerData(videoId) {
    const fromPage = findPlayerResponse(document.documentElement.innerHTML);
    if (fromPage?.videoDetails?.videoId === videoId && hasCaptionTracks(fromPage)) {
      return fromPage;
    }

    const response = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      { credentials: 'include', cache: 'no-store' },
      12000
    );
    if (!response.ok) return null;

    const html = await response.text();
    const data = findPlayerResponse(html);
    if (data?.videoDetails?.videoId !== videoId) return null;
    return data;
  }

  function findPlayerResponse(html) {
    try {
      if (window.ytInitialPlayerResponse?.videoDetails) {
        return window.ytInitialPlayerResponse;
      }
    } catch {
      // Content scripts normally have an isolated JavaScript world.
    }

    return extractJsonAfterMarker(html, 'ytInitialPlayerResponse');
  }

  function extractJsonAfterMarker(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;

    const objectStart = text.indexOf('{', markerIndex);
    if (objectStart < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = objectStart; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(text.slice(objectStart, index + 1));
        }
      }
    }

    return null;
  }

  function hasCaptionTracks(playerData) {
    return Boolean(
      playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length
    );
  }

  function getCaptionTracks(playerData) {
    return (
      playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
    ).filter((track) => Boolean(track?.baseUrl));
  }

  function rankCaptionTracks(tracks, playerData) {
    const originalLanguage = getOriginalLanguage(playerData);
    const manualFor = (language, source = tracks) =>
      source.filter(
        (track) =>
          normalizeLanguage(track.languageCode).startsWith(language) &&
          track.kind !== 'asr'
      );
    const automaticFor = (language, source = tracks) =>
      source.filter(
        (track) =>
          normalizeLanguage(track.languageCode).startsWith(language) &&
          track.kind === 'asr'
      );
    const ordered = [];

    if (isChineseLanguage(originalLanguage)) {
      ordered.push(
        ...manualFor('zh'),
        ...automaticFor('zh'),
        ...tracks.filter((track) => track.isDefault)
      );
    } else {
      if (originalLanguage) {
        ordered.push(
          ...manualFor(originalLanguage),
          ...automaticFor(originalLanguage)
        );
      }
      ordered.push(...tracks.filter((track) => track.isDefault));

      if (normalizeLanguage(originalLanguage) !== 'en') {
        ordered.push(...manualFor('en'), ...automaticFor('en'));
      }

      ordered.push(...manualFor('zh'), ...automaticFor('zh'));
    }

    ordered.push(...tracks);
    return ordered.filter(
      (track, index, list) =>
        track?.baseUrl &&
        list.findIndex(
          (candidate) =>
            candidate.baseUrl === track.baseUrl &&
            candidate.languageCode === track.languageCode
        ) === index
    );
  }

  function getOriginalLanguage(playerData) {
    const tracklist =
      playerData?.captions?.playerCaptionsTracklistRenderer;
    const audioTracks = tracklist?.audioTracks || [];
    const defaultIndex = Number(tracklist?.defaultAudioTrackIndex);
    const defaultAudioTrack =
      (Number.isInteger(defaultIndex) && audioTracks[defaultIndex]) ||
      audioTracks.find((track) => track.defaultAudioTrack);
    const audioLanguage =
      playerData?.videoDetails?.defaultAudioLanguage ||
      defaultAudioTrack?.audioTrackId?.split('.')[0] ||
      '';
    return normalizeLanguage(audioLanguage);
  }

  async function fetchTimedText(baseUrl, translatedLanguage = '') {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');
    if (translatedLanguage) url.searchParams.set('tlang', translatedLanguage);

    const response = await fetchWithTimeout(
      url.toString(),
      { credentials: 'include', cache: 'no-store' },
      12000
    );
    if (!response.ok) throw new Error(`字幕请求失败: ${response.status}`);
    return response.json();
  }

  function parseTimedText(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    const cues = [];
    let pending = null;

    const flush = () => {
      if (!pending) return;
      const text = cleanCaptionText(pending.text);
      if (text) {
        cues.push({
          start: pending.start,
          end: Math.max(pending.end, pending.start + 0.8),
          dur: Math.max(pending.end - pending.start, 0.8),
          text
        });
      }
      pending = null;
    };

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!Array.isArray(event?.segs)) continue;

      const eventStart = Number(event.tStartMs) / 1000;
      if (!Number.isFinite(eventStart) || eventStart < 0) continue;

      const nextStartMs = Number(events[index + 1]?.tStartMs);
      const explicitDurationMs = Number(
        event.dDurationMs ?? event.dDurMs ?? event.dDtendMs
      );
      const inferredDurationMs =
        Number.isFinite(nextStartMs) && nextStartMs > Number(event.tStartMs)
          ? nextStartMs - Number(event.tStartMs)
          : 2500;
      const durationMs =
        Number.isFinite(explicitDurationMs) && explicitDurationMs > 0
          ? explicitDurationMs
          : inferredDurationMs;
      const eventEnd = eventStart + durationMs / 1000;
      const text = cleanCaptionText(
        event.segs.map((segment) => segment?.utf8 || '').join('')
      );
      if (!text) continue;

      if (
        pending &&
        (eventStart - pending.start > SUBTITLE_MAX_GAP_SECONDS ||
          pending.text.length + text.length > SUBTITLE_MAX_CHARS)
      ) {
        flush();
      }

      if (!pending) {
        pending = { start: eventStart, end: eventEnd, text };
      } else {
        pending.text = joinCaptionText(pending.text, text);
        pending.end = Math.max(pending.end, eventEnd);
      }

      if (
        /[.!?。！？]["'”’）)]?$/.test(text) ||
        pending.end - pending.start >= SUBTITLE_MAX_GAP_SECONDS
      ) {
        flush();
      }
    }

    flush();
    return deduplicateCues(cues);
  }

  function cleanCaptionText(text) {
    return String(text || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\[(?:music|applause|laughter)\]/gi, '')
      .trim();
  }

  function joinCaptionText(left, right) {
    if (!left) return right;
    if (!right) return left;
    if (CHINESE_CHAR_RE.test(left.at(-1) || '') && CHINESE_CHAR_RE.test(right[0] || '')) {
      return `${left}${right}`;
    }
    if (/^[,.;:!?，。；：！？)\]]/.test(right)) return `${left}${right}`;
    return `${left} ${right}`;
  }

  function deduplicateCues(cues) {
    const output = [];
    let previousText = '';

    for (const cue of cues) {
      if (cue.text === previousText) continue;
      output.push(cue);
      previousText = cue.text;
    }

    return output;
  }

  function onTimeUpdate() {
    if (!videoEl || !textEl) return;
    if (!captions.length) return;
    if (videoEl.paused || videoEl.ended) return;
    ensureTranslationPrefetchWindow();

    const nextCaption = findCaption(videoEl.currentTime);
    if (nextCaption === currentCaption) return;

    currentCaption = nextCaption;
    if (nextCaption) {
      setSubtitle(nextCaption.text);
    } else {
      clearSubtitle();
    }
  }

  function findCaption(time) {
    let low = 0;
    let high = captions.length - 1;
    let nearest = null;

    while (low <= high) {
      const middle = (low + high) >> 1;
      const cue = captions[middle];

      if (time < cue.start) {
        high = middle - 1;
      } else if (time > cue.end) {
        low = middle + 1;
      } else {
        return cue;
      }

      nearest = cue;
    }

    if (nearest && time >= nearest.start - 0.15 && time <= nearest.end + 0.35) {
      return nearest;
    }
    return null;
  }

  async function setSubtitle(sourceText) {
    const cleanText = cleanCaptionText(sourceText);
    if (!cleanText || !textEl) return;

    const requestId = ++subtitleSequence;
    panelEl.classList.add('yt-cn-active');
    document.documentElement.classList.add('yt-cn-showing-subtitles');

    if (isMostlyChinese(cleanText)) {
      textEl.textContent = cleanText;
      setStatus(captionMode === 'asr' ? '语音识别' : '原文');
      return;
    }

    const cached = translationCache.get(`${targetLang}:${cleanText}`);
    if (cached) {
      textEl.textContent = cached;
      setStatus('中文翻译');
      return;
    }

    if (!isMostlyChinese(textEl.textContent)) {
      textEl.textContent = '正在翻译';
    }
    setStatus('翻译中');
    const result = await translateToChinese(cleanText);
    if (requestId !== subtitleSequence || !textEl) return;

    if (!result.ok) {
      textEl.textContent = '正在生成中文字幕';
      setStatus('切换翻译引擎');
      requestBridgeChineseCaptions();
      return;
    }

    textEl.textContent = result.text || cleanText;
    setStatus('中文翻译');
  }

  function clearSubtitle() {
    subtitleSequence += 1;
    if (!textEl) return;
    textEl.textContent = '';
    panelEl?.classList.remove('yt-cn-active');
    document.documentElement.classList.remove('yt-cn-showing-subtitles');
  }

  async function translateToChinese(text) {
    if (isMostlyChinese(text)) return { ok: true, text };

    const cacheKey = `${targetLang}:${text}`;
    if (translationCache.has(cacheKey)) {
      return { ok: true, text: translationCache.get(cacheKey) };
    }

    if (translationInFlight.has(cacheKey)) {
      return translationInFlight.get(cacheKey);
    }

    const request = (async () => {
      const localResult = await translateWithChromeTranslator(text);
      if (localResult.ok) {
        translationCache.set(cacheKey, localResult.text);
        return localResult;
      }

      try {
        const response = await chrome.runtime.sendMessage({
          target: 'background',
          type: 'translate:request',
          text,
          targetLang
        });
        if (!response?.ok) {
          throw new Error(response?.error || '翻译请求失败');
        }

        const translated = response.text?.trim() || '';

        if (!translated) throw new Error('翻译结果为空');
        translationCache.set(cacheKey, translated);
        return { ok: true, text: translated };
      } catch (error) {
        console.debug('[YT-CN] 翻译失败:', error);
        return { ok: false, text };
      }
    })();

    translationInFlight.set(cacheKey, request);
    request.finally(() => translationInFlight.delete(cacheKey));
    return request;
  }

  async function translateWithChromeTranslator(text) {
    if (typeof globalThis.Translator !== 'function') {
      return { ok: false, text };
    }

    try {
      const sourceLanguage = await resolveTranslatorSourceLanguage(text);
      const targetLanguage = getTranslatorTargetLanguage();
      if (!sourceLanguage || sourceLanguage === targetLanguage) {
        return { ok: true, text };
      }

      const key = `${sourceLanguage}:${targetLanguage}`;
      let translatorPromise = localTranslators.get(key);

      if (!translatorPromise) {
        translatorPromise = createChromeTranslator(
          sourceLanguage,
          targetLanguage
        );
        localTranslators.set(key, translatorPromise);
      }

      const translator = await translatorPromise;
      if (!translator) {
        localTranslators.delete(key);
        return { ok: false, text };
      }

      const translated = await translator.translate(text);
      return translated?.trim()
        ? { ok: true, text: translated.trim() }
        : { ok: false, text };
    } catch (error) {
      console.debug('[YT-CN] Chrome 本地翻译不可用:', error);
      return { ok: false, text };
    }
  }

  async function createChromeTranslator(sourceLanguage, targetLanguage) {
    const availability = await globalThis.Translator.availability({
      sourceLanguage,
      targetLanguage
    });

    if (availability === 'unavailable') return null;

    try {
      return await globalThis.Translator.create({
        sourceLanguage,
        targetLanguage,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            const percentage = event.total
              ? Math.round((event.loaded / event.total) * 100)
              : null;
            setStatus(
              percentage === null ? '下载翻译模型' : `翻译模型 ${percentage}%`
            );
          });
        }
      });
    } catch (error) {
      if (error?.name !== 'NotSupportedError') throw error;

      await new Promise((resolve) => setTimeout(resolve, 800));
      return globalThis.Translator.create({
        sourceLanguage,
        targetLanguage
      });
    }
  }

  async function resolveTranslatorSourceLanguage(text) {
    const knownLanguage = normalizeLanguage(sourceCaptionLanguage);
    if (knownLanguage && knownLanguage !== 'auto') {
      return normalizeTranslatorLanguage(knownLanguage);
    }

    if (typeof globalThis.LanguageDetector !== 'function') {
      return 'en';
    }

    try {
      if (!languageDetectorPromise) {
        languageDetectorPromise = globalThis.LanguageDetector.create();
      }
      const detector = await languageDetectorPromise;
      const results = await detector.detect(text.slice(0, 300));
      return (
        normalizeTranslatorLanguage(results?.[0]?.detectedLanguage) || 'en'
      );
    } catch {
      return 'en';
    }
  }

  function getTranslatorTargetLanguage() {
    return targetLang === 'zh-TW' ? 'zh-Hant' : 'zh';
  }

  function normalizeTranslatorLanguage(language) {
    const normalized = normalizeLanguage(language);
    if (!normalized) return '';
    if (normalized.startsWith('zh-hant') || normalized.startsWith('zh-tw')) {
      return 'zh-Hant';
    }
    if (normalized.startsWith('zh')) return 'zh';
    return normalized.split('-')[0];
  }

  function ensureTranslationPrefetchWindow(force = false) {
    if (
      captionMode !== 'track' ||
      !captions.length ||
      isChineseLanguage(sourceCaptionLanguage)
    ) {
      return;
    }

    const currentTime = videoEl?.currentTime || 0;
    if (!force && Math.abs(currentTime - lastPrefetchCheck) < 4) return;
    lastPrefetchCheck = currentTime;

    const startIndex = findCaptionIndexAtTime(currentTime);
    const upcoming = captions.slice(startIndex, startIndex + 48);

    for (const cue of upcoming) {
      if (isMostlyChinese(cue.text)) continue;
      const cacheKey = `${targetLang}:${cue.text}`;
      if (
        translationCache.has(cacheKey) ||
        translationInFlight.has(cacheKey) ||
        prefetchQueuedKeys.has(cacheKey)
      ) {
        continue;
      }

      prefetchQueuedKeys.add(cacheKey);
      prefetchQueue.push(cue.text);
    }

    runTranslationPrefetch(prefetchGeneration);
  }

  async function runTranslationPrefetch(generation) {
    if (prefetchRunning) return;
    prefetchRunning = true;

    while (
      generation === prefetchGeneration &&
      prefetchQueue.length &&
      enabled
    ) {
      const batch = prefetchQueue.splice(0, 3);
      await Promise.all(
        batch.map(async (text) => {
          try {
            await translateToChinese(text);
          } finally {
            prefetchQueuedKeys.delete(`${targetLang}:${text}`);
          }
        })
      );

      if (prefetchQueue.length) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    prefetchRunning = false;
    if (
      generation === prefetchGeneration &&
      prefetchQueue.length &&
      enabled
    ) {
      runTranslationPrefetch(generation);
    }
  }

  function findCaptionIndexAtTime(time) {
    let low = 0;
    let high = captions.length - 1;
    let result = 0;

    while (low <= high) {
      const middle = (low + high) >> 1;
      if (captions[middle].start <= time) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return result;
  }

  function isMostlyChinese(text) {
    const chineseCount = (text.match(CHINESE_TEXT_RE) || []).length;
    if (!chineseCount) return false;

    const latinCount = (text.match(LATIN_LETTER_RE) || []).length;
    return chineseCount / Math.max(chineseCount + latinCount, 1) >= 0.45;
  }

  function isChineseLanguage(languageCode) {
    return /^zh(?:-|$)/i.test(String(languageCode || ''));
  }

  function normalizeLanguage(languageCode) {
    return String(languageCode || '').toLowerCase();
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function showNoCaptionsMessage(message) {
    if (captionMode === 'track' || captionMode === 'asr') return;
    captionMode = 'none';
    textEl.textContent = message;
    panelEl?.classList.add('yt-cn-active');
    document.documentElement.classList.remove('yt-cn-showing-subtitles');
    setStatus('无字幕');
  }

  function ensureNativeCaptionObserver() {
    if (nativeCaptionObserver) nativeCaptionObserver.disconnect();

    const player = getPlayerContainer();
    if (!player) return;

    nativeCaptionObserver = new MutationObserver(scheduleNativeCaptionRead);
    nativeCaptionObserver.observe(player, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function scheduleNativeCaptionRead() {
    if (captionMode === 'track' || captionMode === 'asr') return;
    if (nativeCaptionTimer) return;

    nativeCaptionTimer = setTimeout(() => {
      nativeCaptionTimer = null;
      readNativeCaption();
    }, 220);
  }

  function readNativeCaption() {
    if (captionMode === 'track' || captionMode === 'asr') return;

    const captionWindows = Array.from(
      document.querySelectorAll('.ytp-caption-window-container')
    ).filter((windowEl) => getComputedStyle(windowEl).display !== 'none');
    const lines = [];

    for (const windowEl of captionWindows) {
      const segments = Array.from(
        windowEl.querySelectorAll('.ytp-caption-segment')
      )
        .filter((segment) => {
          const rect = segment.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((segment) => cleanCaptionText(segment.textContent))
        .filter(Boolean);

      for (const segment of segments) {
        if (!lines.includes(segment)) lines.push(segment);
      }
    }

    const text = cleanCaptionText(lines.join(' '));
    if (!text || text === textEl?.dataset.lastNative) return;

    captionMode = 'native';
    if (textEl) textEl.dataset.lastNative = text;
    setSubtitle(text);
  }

  function enableYoutubeCaptions() {
    const button = document.querySelector('.ytp-subtitles-button');
    if (
      !button ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.classList.contains('ytp-button-disabled')
    ) {
      return false;
    }

    if (button.getAttribute('aria-pressed') !== 'true') {
      button.click();
    }
    return true;
  }

  function requestBridgeCaptions() {
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type: 'enableCaptions'
      },
      location.origin
    );
  }

  function requestBridgeChineseCaptions() {
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        type: 'enableChineseCaptions'
      },
      location.origin
    );
  }

  function handleBridgeMessage(event) {
    if (
      !enabled ||
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== BRIDGE_SOURCE ||
      event.data?.type !== 'captionTrack'
    ) {
      return;
    }

    try {
      const trackUrl = new URL(event.data.url);
      const language = normalizeLanguage(trackUrl.searchParams.get('lang'));
      if (!language) return;

      const parsed = parseTimedText(event.data.data);
      if (!parsed.length) return;

      const kind = trackUrl.searchParams.get('kind') || 'manual';
      const key = `${language}:${kind}`;
      bridgedTracks.set(key, {
        captions: parsed,
        language,
        kind,
        originalLanguage: normalizeLanguage(event.data.originalLanguage),
        order: bridgeTrackOrder++
      });

      const bestTrack = chooseBridgedTrack();
      if (
        bestTrack &&
        (captionMode === 'none' ||
          captionMode === 'native' ||
          captionMode === 'track')
      ) {
        applyBridgedTrack(bestTrack);
      }
    } catch (error) {
      console.debug('[YT-CN] 无法解析旁路字幕:', error);
    }
  }

  function chooseBridgedTrack() {
    const tracks = Array.from(bridgedTracks.values());
    if (!tracks.length) return null;

    const originalLanguage =
      tracks.find((track) => track.originalLanguage)?.originalLanguage || '';
    const isOriginalChinese = isChineseLanguage(originalLanguage);
    const isOriginalEnglish = originalLanguage.startsWith('en');
    const languageMatches = (track, language) =>
      Boolean(
        language &&
          (track.language === language ||
            track.language.startsWith(`${language}-`) ||
            language.startsWith(`${track.language}-`))
      );

    return tracks
      .map((track) => {
        let score = 100 - track.order / 1000;
        if (languageMatches(track, originalLanguage)) score -= 50;
        if (track.kind !== 'asr') score -= 8;
        if (isOriginalChinese && isChineseLanguage(track.language)) score -= 45;
        if (isOriginalEnglish && track.language.startsWith('en')) score -= 12;
        if (!originalLanguage && track.language.startsWith('en')) score -= 20;
        return { track, score };
      })
      .sort((left, right) => left.score - right.score)[0].track;
  }

  function applyBridgedTrack(track) {
    const previousLanguage = sourceCaptionLanguage;
    const previousMode = captionMode;
    const sameTrack =
      previousMode === 'track' &&
      previousLanguage === track.language &&
      captions.length === track.captions.length &&
      captions[0]?.text === track.captions[0]?.text;

    if (sameTrack) return;

    captions = track.captions;
    captionMode = 'track';
    sourceCaptionLanguage = track.language;
    currentCaption = null;
    translationCache.clear();
    translationInFlight.clear();
    prefetchQueue = [];
    prefetchQueuedKeys.clear();
    prefetchGeneration += 1;
    lastPrefetchCheck = 0;
    textEl.textContent = '';
    setStatus('字幕就绪');
    ensureTranslationPrefetchWindow(true);
    onTimeUpdate();
  }

  function handleAsrStatus(message) {
    asrState = message.state || 'idle';

    if (asrState === 'recording') {
      if (!asrAnchor) {
        asrAnchor = {
          videoTime: videoEl?.currentTime || 0,
          wallTime: Date.now()
        };
      }
      if (captionMode !== 'track') {
        captionMode = 'asr';
        panelEl?.classList.add('yt-cn-active');
        setStatus('识别中');
      }
      return;
    }

    if (asrState === 'stopped') {
      asrAnchor = null;
      if (!captions.length) showNoCaptionsMessage('语音识别已停止');
      return;
    }

    if (asrState === 'error') {
      asrAnchor = null;
      textEl.textContent = message.message || '本地语音识别启动失败';
      setStatus('识别失败');
      panelEl?.classList.add('yt-cn-active');
      return;
    }

    if (captionMode === 'track') return;

    if (asrState === 'preparing') {
      textEl.textContent = message.message || '正在准备本地语音模型';
      setStatus('语音识别');
      panelEl?.classList.add('yt-cn-active');
    } else if (asrState === 'transcribing') {
      setStatus('识别中');
    } else if (asrState === 'loading') {
      textEl.textContent = message.message || '正在加载语音模型';
      setStatus('语音识别');
      panelEl?.classList.add('yt-cn-active');
    }
  }

  function handleAsrSegment(message) {
    const text = cleanCaptionText(message.text);
    if (!text || !asrAnchor) return;

    const start = asrAnchor.videoTime + Number(message.offsetStart || 0);
    const duration = Math.max(Number(message.duration || 6), 0.8);
    const cue = {
      start,
      end: start + duration,
      dur: duration,
      text,
      source: 'asr'
    };

    captions.push(cue);
    captions.sort((left, right) => left.start - right.start);
    captionMode = 'asr';

    const currentTime = videoEl?.currentTime || 0;
    if (currentTime >= start - 1 && currentTime <= cue.end + 4) {
      currentCaption = cue;
      setSubtitle(text);
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled) {
      ensureNativeCaptionObserver();
    }
  });

  console.log('[YT-CN] YouTube 中文字幕助手已加载');
})();
