// YouTube 中文字幕助手 - Offscreen Whisper
'use strict';

import { env, pipeline } from './vendor/transformers/transformers.min.js';

const MODEL_ID = 'Xenova/whisper-tiny.en';
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 6;
const PROCESSOR_BUFFER_SIZE = 4096;
const MIN_AUDIO_RMS = 0.0012;

let transcriber = null;
let transcriberPromise = null;
let session = null;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.remoteHost = 'https://huggingface.co/';

if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths =
    chrome.runtime.getURL('vendor/transformers/');
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  (async () => {
    try {
      if (message.type === 'asr:start') {
        await startRecognition(message);
        sendResponse({ ok: true });
      } else if (message.type === 'asr:stop') {
        await stopRecognition({ notify: true });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '未知的离屏请求' });
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      sendStatus('error', messageText, message.tabId);
      await stopRecognition({ notify: false });
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});

async function startRecognition({ streamId, tabId }) {
  if (!streamId || !tabId) throw new Error('缺少标签页音频标识');
  if (session) await stopRecognition({ notify: false });

  sendStatus(
    'preparing',
    '正在接入标签页音频并准备本地语音模型',
    tabId
  );

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioContext = new AudioContext();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(
    PROCESSOR_BUFFER_SIZE,
    1,
    1
  );
  const silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;

  // Capturing a tab normally mutes it; route it back to the speakers.
  source.connect(audioContext.destination);
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);

  session = {
    tabId,
    stream,
    audioContext,
    source,
    processor,
    silentOutput,
    modelReady: false,
    bufferParts: [],
    bufferLength: 0,
    recordedSamples: 0,
    chunkIndex: 0,
    queue: Promise.resolve(),
    queueCount: 0
  };

  const currentSession = session;
  processor.onaudioprocess = (event) => {
    collectAudio(currentSession, event.inputBuffer.getChannelData(0));
  };
  stream.getAudioTracks()[0]?.addEventListener(
    'ended',
    () => stopRecognition({ notify: true }),
    { once: true }
  );

  prepareModel(currentSession).catch(async (error) => {
    if (session !== currentSession) return;
    const message = error instanceof Error ? error.message : String(error);
    sendStatus('error', `本地语音模型加载失败：${message}`, tabId);
    await stopRecognition({ notify: false });
  });
}

async function prepareModel(currentSession) {
  sendStatus('loading', '正在下载并加载本地 Whisper 模型', currentSession.tabId);
  const model = await getTranscriber(currentSession.tabId);

  if (session !== currentSession) return;
  transcriber = model;
  currentSession.modelReady = true;
  currentSession.bufferParts = [];
  currentSession.bufferLength = 0;
  currentSession.recordedSamples = 0;

  sendStatus(
    'recording',
    '本地语音模型已就绪，正在识别英文语音',
    currentSession.tabId
  );
}

async function getTranscriber(tabId) {
  if (transcriber) return transcriber;
  if (transcriberPromise) return transcriberPromise;

  let lastProgress = -1;
  transcriberPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
      quantized: true,
      progress_callback: (progress) => {
        if (progress.status !== 'progress' || !Number.isFinite(progress.progress)) {
          return;
        }

        const percentage = Math.round(progress.progress);
        if (percentage === lastProgress) return;
        lastProgress = percentage;
        sendStatus(
          'loading',
          `正在下载语音模型 ${percentage}%`,
          tabId,
          { progress: percentage }
        );
      }
    })
    .then((model) => {
      transcriber = model;
      return model;
    })
    .catch((error) => {
      transcriberPromise = null;
      throw error;
    });

  return transcriberPromise;
}

function collectAudio(currentSession, inputSamples) {
  if (session !== currentSession || !currentSession.modelReady) return;

  const copy = new Float32Array(inputSamples);
  currentSession.bufferParts.push(copy);
  currentSession.bufferLength += copy.length;
  currentSession.recordedSamples += copy.length;

  const sourceRate = currentSession.audioContext.sampleRate;
  const chunkSamples = Math.round(sourceRate * CHUNK_SECONDS);

  while (currentSession.bufferLength >= chunkSamples) {
    const combined = concatenateFloat32(
      currentSession.bufferParts,
      currentSession.bufferLength
    );
    const chunk = combined.slice(0, chunkSamples);
    const remainder = combined.slice(chunkSamples);

    currentSession.bufferParts = remainder.length ? [remainder] : [];
    currentSession.bufferLength = remainder.length;

    const offsetStart = currentSession.chunkIndex * CHUNK_SECONDS;
    currentSession.chunkIndex += 1;
    enqueueTranscription(currentSession, chunk, offsetStart, sourceRate);
  }
}

function enqueueTranscription(currentSession, samples, offsetStart, sourceRate) {
  if (calculateRms(samples) < MIN_AUDIO_RMS) return;

  currentSession.queueCount += 1;
  sendStatus(
    'transcribing',
    '正在识别语音',
    currentSession.tabId,
    { queued: currentSession.queueCount }
  );

  currentSession.queue = currentSession.queue
    .then(async () => {
      if (session !== currentSession) return;

      const audio = resampleTo16k(samples, sourceRate);
      const result = await transcriber(audio, {
        return_timestamps: false
      });
      const text = cleanTranscript(result?.text || '');

      if (text && session === currentSession) {
        sendSegment(currentSession.tabId, {
          text,
          offsetStart,
          duration: CHUNK_SECONDS
        });
      }
    })
    .catch((error) => {
      console.warn('[YT-CN] Whisper 识别失败:', error);
      sendStatus(
        'transcribing',
        '这一段音频识别失败，继续监听',
        currentSession.tabId
      );
    })
    .finally(() => {
      currentSession.queueCount = Math.max(0, currentSession.queueCount - 1);
      if (session === currentSession && currentSession.queueCount === 0) {
        sendStatus(
          'recording',
          '正在监听英文语音',
          currentSession.tabId
        );
      }
    });
}

function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[(?:music|applause|laughter|silence)\]/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-–—]\s*/, '')
    .trim();
}

function resampleTo16k(samples, sourceRate) {
  if (sourceRate === TARGET_SAMPLE_RATE) return samples;

  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
    const fraction = sourcePosition - leftIndex;
    output[index] =
      samples[leftIndex] * (1 - fraction) + samples[rightIndex] * fraction;
  }

  return output;
}

function concatenateFloat32(parts, totalLength) {
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function calculateRms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / Math.max(samples.length, 1));
}

async function stopRecognition({ notify }) {
  const currentSession = session;
  session = null;
  if (!currentSession) return;

  currentSession.processor.onaudioprocess = null;

  try {
    currentSession.processor.disconnect();
    currentSession.source.disconnect();
    currentSession.silentOutput.disconnect();
  } catch {
    // Parts of the graph may already be disconnected.
  }

  for (const track of currentSession.stream.getTracks()) {
    track.stop();
  }

  try {
    await currentSession.audioContext.close();
  } catch {
    // The context may already be closed.
  }

  if (notify) {
    sendStatus('stopped', '语音识别已停止', currentSession.tabId);
  }
}

function sendStatus(state, message, tabId, extra = {}) {
  if (!tabId) return;

  chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'asr:status',
      tabId,
      payload: { state, message, ...extra }
    })
    .catch(() => {});
}

function sendSegment(tabId, segment) {
  chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'asr:segment',
      tabId,
      payload: segment
    })
    .catch(() => {});
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('[YT-CN] 离屏语音识别未处理错误:', event.reason);
});
