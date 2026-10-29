// Main-world bridge: observe the caption responses fetched by YouTube itself.
(() => {
  if (document.documentElement.dataset.ytCnBridgeVersion === '1.1.1') {
    return;
  }
  document.documentElement.dataset.ytCnBridgeVersion = '1.1.1';

  const BRIDGE_SOURCE = 'yt-cn-caption-bridge';
  const CONTENT_SOURCE = 'yt-cn-content';
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      captureFetchResponse(args[0], response);
      return response;
    };
  }

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.__ytCnCaptionUrl = String(url || '');
    return originalXhrOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isTimedTextUrl(this.__ytCnCaptionUrl)) {
      this.addEventListener(
        'load',
        () => {
          try {
            const body =
              this.responseType === 'json' ? this.response : this.responseText;
            postCaptionTrack(this.__ytCnCaptionUrl, body);
          } catch {
            // XHR bodies can be unavailable for redirected or aborted requests.
          }
        },
        { once: true }
      );
    }

    return originalXhrSend.apply(this, args);
  };

  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== CONTENT_SOURCE ||
      !['enableCaptions', 'enableChineseCaptions'].includes(event.data?.type)
    ) {
      return;
    }

    if (event.data.type === 'enableChineseCaptions') {
      enableChineseCaptions();
      return;
    }

    enablePreferredCaptions();
  });

  async function captureFetchResponse(input, response) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;

    if (!isTimedTextUrl(url) || !response?.ok) return;

    try {
      const text = await response.clone().text();
      postCaptionTrack(url, text);
    } catch {
      // The player may cancel a caption request while switching languages.
    }
  }

  function isTimedTextUrl(url) {
    return String(url || '').includes('/api/timedtext');
  }

  function postCaptionTrack(url, body) {
    if (!body) return;

    let data = body;
    if (typeof body === 'string') {
      try {
        data = JSON.parse(body);
      } catch {
        return;
      }
    }

    if (!Array.isArray(data?.events) || !data.events.length) return;

    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: 'captionTrack',
        url: String(url),
        data,
        originalLanguage: getOriginalLanguage()
      },
      location.origin
    );
  }

  function getPlayer() {
    return (
      document.querySelector('#movie_player') ||
      document.querySelector('.html5-video-player')
    );
  }

  function getPlayerResponse() {
    try {
      return getPlayer()?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    } catch {
      return window.ytInitialPlayerResponse;
    }
  }

  function getOriginalLanguage() {
    const playerData = getPlayerResponse();
    const tracklist =
      playerData?.captions?.playerCaptionsTracklistRenderer;
    const audioTracks = tracklist?.audioTracks || [];
    const defaultIndex = Number(tracklist?.defaultAudioTrackIndex);
    const defaultAudioTrack =
      (Number.isInteger(defaultIndex) && audioTracks[defaultIndex]) ||
      audioTracks.find((track) => track.defaultAudioTrack);

    return String(
      playerData?.videoDetails?.defaultAudioLanguage ||
        defaultAudioTrack?.audioTrackId?.split('.')[0] ||
        ''
    ).toLowerCase();
  }

  function enablePreferredCaptions() {
    const player = getPlayer();
    const button = document.querySelector('.ytp-subtitles-button');

    if (
      button &&
      button.getAttribute('aria-disabled') !== 'true' &&
      !button.classList.contains('ytp-button-disabled') &&
      button.getAttribute('aria-pressed') !== 'true'
    ) {
      button.click();
    }

    try {
      const tracks = player?.getOption?.('captions', 'tracklist') || [];
      const originalLanguage = getOriginalLanguage();
      const languageMatches = (track, language) => {
        const code = String(track.languageCode || '').toLowerCase();
        return Boolean(
          language &&
            (code === language ||
              code.startsWith(`${language}-`) ||
              language.startsWith(`${code}-`))
        );
      };
      const preferred =
        tracks.find(
          (track) =>
            languageMatches(track, originalLanguage) &&
            track.kind !== 'asr'
        ) ||
        tracks.find((track) => languageMatches(track, originalLanguage)) ||
        tracks.find((track) => /^zh(?:-|$)/i.test(track.languageCode || '')) ||
        tracks.find(
          (track) =>
            /^en(?:-|$)/i.test(track.languageCode || '') &&
            track.kind !== 'asr'
        ) ||
        tracks.find((track) => /^en(?:-|$)/i.test(track.languageCode || '')) ||
        tracks[0];

      if (preferred) {
        player.setOption?.('captions', 'track', preferred);
      }
    } catch {
      // The visible CC button remains a reliable fallback.
    }
  }

  function enableChineseCaptions() {
    const player = getPlayer();
    if (!player) return;

    try {
      const currentTrack = player.getOption?.('captions', 'track');
      if (!currentTrack) return;

      const translationLanguages =
        player.getOption?.('captions', 'translationLanguages') || [];
      const chineseLanguage =
        translationLanguages.find((language) =>
          /^zh(?:-|$)/i.test(language.languageCode || '')
        ) || { languageCode: 'zh-Hans' };

      player.setOption?.('captions', 'track', {
        ...currentTrack,
        translationLanguageCode: chineseLanguage.languageCode
      });
    } catch (error) {
      console.debug('[YT-CN-BRIDGE] 无法切换中文译轨:', error);
    }
  }
})();
