// Udemy Transcript Downloader - Background Service Worker (v2.0)
// 下載引擎：背景執行、重試機制、斷點續傳

'use strict';

// ============================================================
// 常數設定
// ============================================================
const CONFIG = {
  BASE_DELAY: 500,           // 基礎請求間隔 (ms)
  MAX_RETRIES: 3,            // 最大重試次數
  RETRY_BASE_DELAY: 1000,    // 重試基礎延遲 (ms)
  KEEPALIVE_INTERVAL: 25,    // Service Worker 保活間隔 (秒)
  API_BASE: 'https://www.udemy.com/api-2.0',
  PAGE_SIZE: 100,
};

// ============================================================
// 狀態管理
// ============================================================
let downloadState = {
  isRunning: false,
  isPaused: false,
  courseData: null,
  tabId: null,
  options: {},            // { includeTimestamps, locale, selectedChapterPlans, mergeMode }
  progress: {
    currentChapterIdx: 0,
    currentLectureIdx: 0,
    processedLectures: 0,
    totalLectures: 0,
    successCount: 0,
    currentLectureName: '',
  },
  completedLectures: {},  // { [lectureId]: transcriptText }
  chapterContents: {},    // { [chapterIndex]: contentString }
  error: null,
};

// ============================================================
// 工具函數
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

// 指數退避重試
async function fetchWithRetry(url, options = {}, retries = CONFIG.MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        // Rate Limited - 使用 Retry-After header 或指數退避
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter
          ? parseInt(retryAfter) * 1000
          : CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.log(`Rate limited, waiting ${waitTime}ms before retry ${attempt + 1}`);
        await sleep(waitTime);
        continue;
      }

      if (!response.ok && attempt < retries) {
        const waitTime = CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.log(`Request failed (${response.status}), retrying in ${waitTime}ms...`);
        await sleep(waitTime);
        continue;
      }

      return response;
    } catch (error) {
      if (attempt < retries) {
        const waitTime = CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.log(`Network error, retrying in ${waitTime}ms:`, error.message);
        await sleep(waitTime);
        continue;
      }
      throw error;
    }
  }
}

// ============================================================
// 字幕解析
// ============================================================
function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTimestampLabel(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const totalSeconds = Math.max(0, Math.floor(value));
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return hours === '00' ? `${minutes}:${seconds}` : `${hours}:${minutes}:${seconds}`;
  }

  const text = String(value).trim();
  const timeMatch = text.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  if (timeMatch) {
    return timeMatch[1];
  }

  const numericValue = Number(text);
  if (Number.isFinite(numericValue)) {
    return extractTimestampLabel(numericValue);
  }

  return '';
}

function appendTranscriptLine(result, seenTexts, text, timestamp, includeTimestamps) {
  const cleanText = normalizeWhitespace(text);
  if (!cleanText || seenTexts.has(cleanText)) {
    return;
  }

  seenTexts.add(cleanText);
  result.push(includeTimestamps && timestamp ? `[${timestamp}] ${cleanText}` : cleanText);
}

function parseVTT(vttContent, includeTimestamps = true) {
  const lines = String(vttContent).replace(/\r/g, '').split('\n');
  const result = [];
  const seenTexts = new Set();
  let currentTime = '';
  let currentText = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE')) {
      if (currentText.length > 0) {
        appendTranscriptLine(result, seenTexts, currentText.join(' '), currentTime, includeTimestamps);
        currentText = [];
      }
      continue;
    }

    if (line.includes('-->')) {
      if (currentText.length > 0) {
        appendTranscriptLine(result, seenTexts, currentText.join(' '), currentTime, includeTimestamps);
        currentText = [];
      }
      currentTime = extractTimestampLabel(line);
      continue;
    }

    if (/^\d+$/.test(line)) {
      continue;
    }

    currentText.push(line);
  }

  if (currentText.length > 0) {
    appendTranscriptLine(result, seenTexts, currentText.join(' '), currentTime, includeTimestamps);
  }

  return result.join('\n');
}

function parseSRT(srtContent, includeTimestamps = true) {
  const lines = String(srtContent).replace(/\r/g, '').split('\n');
  const result = [];
  const seenTexts = new Set();
  let currentTime = '';
  let currentText = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      if (currentText.length > 0) {
        appendTranscriptLine(result, seenTexts, currentText.join(' '), currentTime, includeTimestamps);
        currentText = [];
      }
      continue;
    }

    if (/^\d+$/.test(line)) {
      continue;
    }

    if (line.includes('-->')) {
      if (currentText.length > 0) {
        appendTranscriptLine(result, seenTexts, currentText.join(' '), currentTime, includeTimestamps);
        currentText = [];
      }
      currentTime = extractTimestampLabel(line);
      continue;
    }

    currentText.push(line);
  }

  if (currentText.length > 0) {
    appendTranscriptLine(result, seenTexts, currentText.join(' '), currentTime, includeTimestamps);
  }

  return result.join('\n');
}

function parseCaptionJson(payload, includeTimestamps = true) {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    const text = normalizeWhitespace(payload);
    return text || null;
  }

  if (Array.isArray(payload)) {
    const result = [];
    const seenTexts = new Set();

    payload.forEach(item => {
      if (typeof item === 'string') {
        appendTranscriptLine(result, seenTexts, item, '', includeTimestamps);
        return;
      }

      if (!item || typeof item !== 'object') {
        return;
      }

      const segmentText = Array.isArray(item.segs)
        ? item.segs.map(seg => seg.utf8 || seg.text || seg.content || '').join('')
        : item.text || item.content || item.caption || item.value || item.line || item.transcript || item.utf8 || '';

      const timestamp = extractTimestampLabel(
        item.start ?? item.startTime ?? item.start_time ?? item.from ?? item.offset ?? item.begin ?? item.time
      );

      appendTranscriptLine(result, seenTexts, segmentText, timestamp, includeTimestamps);
    });

    return result.length > 0 ? result.join('\n') : null;
  }

  const nestedList = payload.cues
    || payload.events
    || payload.captions
    || payload.results
    || payload.segments
    || payload.transcript;

  if (nestedList) {
    return parseCaptionJson(nestedList, includeTimestamps);
  }

  if (typeof payload.text === 'string') {
    return normalizeWhitespace(payload.text) || null;
  }

  return null;
}

function extractTranscriptFromBody(body, includeTimestamps = true) {
  if (!body) {
    return null;
  }

  const trimmed = String(body).trim();
  if (!trimmed) {
    return null;
  }

  if (/^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith('WEBVTT')) {
    return parseVTT(trimmed, includeTimestamps) || null;
  }

  if (trimmed.includes('-->') && trimmed.includes(',')) {
    const srtTranscript = parseSRT(trimmed, includeTimestamps);
    if (srtTranscript) {
      return srtTranscript;
    }
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const jsonTranscript = parseCaptionJson(parsed, includeTimestamps);
      if (jsonTranscript) {
        return jsonTranscript;
      }
    } catch (error) {
      console.warn('Caption JSON parse failed:', error.message);
    }
  }

  const plainText = normalizeWhitespace(trimmed);
  return plainText || null;
}

function normalizeCaptionUrl(url) {
  if (!url) {
    return '';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `https://www.udemy.com${url}`;
  }

  return url;
}

function buildLocaleVariants(locale) {
  const variants = new Set();
  const normalizedLocale = String(locale || 'en').trim();

  if (normalizedLocale) {
    variants.add(normalizedLocale.toLowerCase());
    variants.add(normalizedLocale.replace('-', '_').toLowerCase());
    variants.add(normalizedLocale.replace('_', '-').toLowerCase());

    const language = normalizedLocale.split(/[-_]/)[0];
    if (language) {
      variants.add(language.toLowerCase());
    }
  }

  variants.add('en');
  return Array.from(variants);
}

function collectCaptionTracks(payload) {
  const rawTracks = [];
  const containers = [
    payload?.asset?.captions,
    payload?.captions,
    payload?.asset?.tracks,
    payload?.tracks,
    payload?.asset?.text_tracks,
    payload?.text_tracks,
  ];

  containers.forEach(container => {
    if (Array.isArray(container)) {
      rawTracks.push(...container);
    }
  });

  if (payload?.asset?.caption_urls && typeof payload.asset.caption_urls === 'object') {
    Object.entries(payload.asset.caption_urls).forEach(([locale, url]) => {
      rawTracks.push({ locale_id: locale, url });
    });
  }

  const uniqueTracks = new Map();

  rawTracks.forEach(track => {
    if (!track || typeof track !== 'object') {
      return;
    }

    const url = normalizeCaptionUrl(
      track.url || track.src || track.file || track.file_url || track.webvtt_url || track.vtt_url
    );

    if (!url) {
      return;
    }

    const locale = String(track.locale_id || track.locale || track.language || '').trim();
    const key = `${locale}|${url}`;

    if (!uniqueTracks.has(key)) {
      uniqueTracks.set(key, { locale, url });
    }
  });

  return Array.from(uniqueTracks.values());
}

function selectCaptionTracks(tracks, preferredLocale) {
  const localeVariants = buildLocaleVariants(preferredLocale);

  const rankTrack = (track) => {
    const locale = String(track.locale || '').toLowerCase().replace('-', '_');
    if (!locale) return 50;

    for (let i = 0; i < localeVariants.length; i++) {
      const variant = localeVariants[i].replace('-', '_');
      if (locale === variant) return i;
      if (locale.startsWith(`${variant}_`)) return i + 10;
    }

    if (locale.startsWith('en')) return 80;
    return 100;
  };

  return [...tracks].sort((a, b) => rankTrack(a) - rankTrack(b));
}

// ============================================================
// API 呼叫 (透過 content script 代理，以保留 cookie)
// ============================================================
async function proxyFetch(tabId, url) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (apiUrl) => {
        try {
          const targetUrl = new URL(apiUrl, window.location.href).toString();
          const shouldIncludeCredentials = targetUrl.startsWith(window.location.origin);
          const resp = await fetch(targetUrl, {
            credentials: shouldIncludeCredentials ? 'include' : 'omit',
          });
          if (!resp.ok) {
            return { error: true, status: resp.status, statusText: resp.statusText };
          }
          const text = await resp.text();
          return { error: false, body: text, status: resp.status };
        } catch (e) {
          return { error: true, message: e.message };
        }
      },
      args: [url],
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return { error: true, message: 'No result from content script' };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

// 帶重試的 API 代理呼叫
async function proxyFetchWithRetry(tabId, url, retries = CONFIG.MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await proxyFetch(tabId, url);

    if (!result.error) {
      return result;
    }

    if (result.status === 429) {
      const waitTime = CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt);
      console.log(`Rate limited, waiting ${waitTime}ms before retry ${attempt + 1}`);
      await sleep(waitTime);
      continue;
    }

    if (result.status === 401 || result.status === 403) {
      // 認證失敗，不重試
      return result;
    }

    if (attempt < retries) {
      const waitTime = CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt);
      console.log(`API error (${result.status || result.message}), retrying in ${waitTime}ms...`);
      await sleep(waitTime);
      continue;
    }

    return result;
  }
}

// ============================================================
// 課程資料取得
// ============================================================
async function fetchCourseStructure(tabId, courseId) {
  const allItems = [];
  let nextUrl = `${CONFIG.API_BASE}/courses/${courseId}/subscriber-curriculum-items/?page_size=${CONFIG.PAGE_SIZE}&fields[lecture]=title,asset&fields[chapter]=title&fields[asset]=captions,text_tracks&fields[caption]=url,locale_id`;

  while (nextUrl) {
    const result = await proxyFetchWithRetry(tabId, nextUrl);
    if (result.error) {
      console.error('API error fetching structure:', result.status || result.message);
      break;
    }

    const data = JSON.parse(result.body);
    allItems.push(...data.results);
    nextUrl = data.next;
  }

  const chapters = [];
  let currentChapter = null;

  allItems.forEach(item => {
    if (item._class === 'chapter') {
      currentChapter = { id: item.id, title: item.title, lectures: [] };
      chapters.push(currentChapter);
    } else if (item._class === 'lecture' && currentChapter) {
      const captionTracks = collectCaptionTracks(item);
      currentChapter.lectures.push({
        id: item.id,
        title: item.title,
        hasCaptions: captionTracks.length > 0,
      });
    }
  });

  return chapters;
}

// 取得單個講座字幕
async function fetchLectureCaption(tabId, courseId, lectureId, locale = 'en', includeTimestamps = true) {
  const url = `${CONFIG.API_BASE}/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset,title,captions&fields[asset]=captions,text_tracks,caption_urls&fields[caption]=url,locale_id,title`;
  const result = await proxyFetchWithRetry(tabId, url);

  if (result.error) {
    console.error('Lecture API error:', result.status || result.message);
    return null;
  }

  const data = JSON.parse(result.body);

  const captionTracks = selectCaptionTracks(collectCaptionTracks(data), locale || 'en');
  if (captionTracks.length === 0) {
    return { title: data.title, transcript: null };
  }

  for (const track of captionTracks) {
    try {
      const proxyResult = await proxyFetchWithRetry(tabId, track.url);
      if (!proxyResult.error) {
        const transcript = extractTranscriptFromBody(proxyResult.body, includeTimestamps);
        if (transcript) {
          return { title: data.title, transcript, locale: track.locale };
        }
      }
    } catch (error) {
      console.warn('Page-world caption fetch failed:', error.message, track.url);
    }

    try {
      const directResponse = await fetchWithRetry(track.url);
      if (directResponse.ok) {
        const responseBody = await directResponse.text();
        const transcript = extractTranscriptFromBody(responseBody, includeTimestamps);
        if (transcript) {
          return { title: data.title, transcript, locale: track.locale };
        }
      }
    } catch (error) {
      console.warn('Extension caption fetch failed:', error.message, track.url);
    }
  }

  return { title: data.title, transcript: null };
}

// ============================================================
// 進度持久化
// ============================================================
async function saveState() {
  const stateToSave = {
    isRunning: downloadState.isRunning,
    isPaused: downloadState.isPaused,
    courseData: downloadState.courseData,
    tabId: downloadState.tabId,
    options: downloadState.options,
    progress: downloadState.progress,
    completedLectures: downloadState.completedLectures,
    chapterContents: downloadState.chapterContents,
    error: downloadState.error,
  };
  await chrome.storage.local.set({ downloadState: stateToSave });
}

async function loadState() {
  const result = await chrome.storage.local.get('downloadState');
  if (result.downloadState) {
    Object.assign(downloadState, result.downloadState);
  }
}

async function clearState() {
  downloadState = {
    isRunning: false, isPaused: false, courseData: null, tabId: null,
    options: {}, progress: { currentChapterIdx: 0, currentLectureIdx: 0, processedLectures: 0, totalLectures: 0, successCount: 0, currentLectureName: '' },
    completedLectures: {}, chapterContents: {}, error: null,
  };
  await chrome.storage.local.remove('downloadState');
}

// 廣播進度給所有 popup
function broadcastProgress() {
  chrome.runtime.sendMessage({
    type: 'progressUpdate',
    state: {
      isRunning: downloadState.isRunning,
      isPaused: downloadState.isPaused,
      progress: downloadState.progress,
      error: downloadState.error,
    }
  }).catch(() => { /* popup 可能沒開，忽略 */ });
}

// ============================================================
// 下載檔案
// ============================================================
function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const reader = new FileReader();
  reader.onload = function() {
    const dataUrl = reader.result;
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false,
    });
  };
  reader.readAsDataURL(blob);
}

// ============================================================
// 核心下載引擎
// ============================================================
function normalizeChapterPlans(courseData, selectedChapterPlans = null, selectedIndices = null) {
  const rawPlans = Array.isArray(selectedChapterPlans) && selectedChapterPlans.length > 0
    ? selectedChapterPlans
    : Array.isArray(selectedIndices) && selectedIndices.length > 0
      ? selectedIndices.map(chapterIndex => ({
          chapterIndex,
          lectureIndices: (courseData.chapters[chapterIndex]?.lectures || []).map((_, lectureIndex) => lectureIndex),
        }))
      : courseData.chapters.map((chapter, chapterIndex) => ({
          chapterIndex,
          lectureIndices: chapter.lectures.map((_, lectureIndex) => lectureIndex),
        }));

  return rawPlans
    .map(plan => {
      const chapter = courseData.chapters[plan.chapterIndex];
      if (!chapter) return null;

      const lectureIndices = Array.from(new Set(plan.lectureIndices || []))
        .filter(index => Number.isInteger(index) && chapter.lectures[index])
        .sort((a, b) => a - b);

      return lectureIndices.length > 0
        ? { chapterIndex: plan.chapterIndex, lectureIndices }
        : null;
    })
    .filter(Boolean);
}

function countLecturesInPlans(chapterPlans) {
  return chapterPlans.reduce((sum, plan) => sum + plan.lectureIndices.length, 0);
}

function createFreshProgress(totalLectures) {
  return {
    currentChapterIdx: 0,
    currentLectureIdx: 0,
    processedLectures: 0,
    totalLectures,
    successCount: 0,
    currentLectureName: '',
  };
}

async function startDownload(tabId, courseData, options, resume = false) {
  const { includeTimestamps, locale, mergeMode } = options;
  const chapterPlans = normalizeChapterPlans(courseData, options.selectedChapterPlans, options.selectedIndices);
  const courseId = courseData.courseId;
  const courseName = sanitizeFilename(courseData.title);

  if (chapterPlans.length === 0) {
    throw new Error('沒有可下載的講座');
  }

  const totalLectures = countLecturesInPlans(chapterPlans);

  downloadState.isRunning = true;
  downloadState.isPaused = false;
  downloadState.courseData = courseData;
  downloadState.tabId = tabId;
  downloadState.options = {
    includeTimestamps,
    locale,
    mergeMode,
    selectedChapterPlans: chapterPlans,
  };
  downloadState.error = null;

  if (!resume) {
    downloadState.progress = createFreshProgress(totalLectures);
    downloadState.completedLectures = {};
    downloadState.chapterContents = {};
  } else {
    downloadState.progress.totalLectures = totalLectures;
  }

  await saveState();
  broadcastProgress();

  // 設定 keepalive alarm
  chrome.alarms.create('keepalive', { periodInMinutes: CONFIG.KEEPALIVE_INTERVAL / 60 });

  try {
    if (mergeMode) {
      await downloadMerged(tabId, courseData, chapterPlans, courseName, courseId, includeTimestamps, locale);
    } else {
      await downloadByChapter(tabId, courseData, chapterPlans, courseName, courseId, includeTimestamps, locale);
    }
  } catch (error) {
    downloadState.error = error.message;
    broadcastProgress();
  } finally {
    downloadState.isRunning = false;
    chrome.alarms.clear('keepalive');
    await saveState();
    broadcastProgress();
  }
}

async function downloadByChapter(tabId, courseData, chapterPlans, courseName, courseId, includeTimestamps, locale) {
  const startChapterPos = downloadState.progress.currentChapterIdx || 0;

  for (let pos = startChapterPos; pos < chapterPlans.length; pos++) {
    if (!downloadState.isRunning || downloadState.isPaused) {
      await saveState();
      return;
    }

    const { chapterIndex, lectureIndices } = chapterPlans[pos];
    const chapter = courseData.chapters[chapterIndex];
    const chapterNum = String(chapterIndex + 1).padStart(2, '0');
    const chapterName = sanitizeFilename(chapter.title);
    let chapterContent = downloadState.chapterContents[chapterIndex];

    if (!chapterContent) {
      chapterContent = `${'='.repeat(60)}\n`;
      chapterContent += `Chapter ${chapterNum}: ${chapter.title}\n`;
      chapterContent += `${'='.repeat(60)}\n\n`;
      downloadState.chapterContents[chapterIndex] = chapterContent;
    }

    const startLecturePos = pos === startChapterPos ? (downloadState.progress.currentLectureIdx || 0) : 0;

    for (let lecturePos = startLecturePos; lecturePos < lectureIndices.length; lecturePos++) {
      while (downloadState.isPaused) {
        await sleep(1000);
        if (!downloadState.isRunning) return;
      }
      if (!downloadState.isRunning) return;

      const lectureIndex = lectureIndices[lecturePos];
      const lecture = chapter.lectures[lectureIndex];
      downloadState.progress.currentChapterIdx = pos;
      downloadState.progress.currentLectureName = lecture.title;
      broadcastProgress();

      const lectureNum = String(lectureIndex + 1).padStart(2, '0');
      chapterContent += `${'-'.repeat(40)}\n`;
      chapterContent += `Lecture ${lectureNum}: ${lecture.title}\n`;
      chapterContent += `${'-'.repeat(40)}\n\n`;

      // 檢查是否已有快取
      if (downloadState.completedLectures[lecture.id]) {
        chapterContent += downloadState.completedLectures[lecture.id];
        downloadState.progress.successCount++;
      } else {
        const result = await fetchLectureCaption(tabId, courseId, lecture.id, locale || 'en', includeTimestamps);

        if (result && result.transcript) {
          chapterContent += result.transcript;
          downloadState.completedLectures[lecture.id] = result.transcript;
          downloadState.progress.successCount++;
        } else {
          chapterContent += '[無字幕]';
        }
      }

      chapterContent += '\n\n';
      downloadState.chapterContents[chapterIndex] = chapterContent;
      downloadState.progress.processedLectures++;
      downloadState.progress.currentLectureIdx = lecturePos + 1;
      broadcastProgress();

      // 定期保存進度 (每 5 個講座)
      if (downloadState.progress.processedLectures % 5 === 0) {
        await saveState();
      }

      await sleep(CONFIG.BASE_DELAY);
    }

    // 下載這個章節的檔案
    const filename = `${courseName}/${chapterNum}_${chapterName}.txt`;
    downloadTextFile(chapterContent, filename);
    await sleep(300);

    delete downloadState.chapterContents[chapterIndex];
    downloadState.progress.currentChapterIdx = pos + 1;
    downloadState.progress.currentLectureIdx = 0;
    await saveState();
  }
}

async function downloadMerged(tabId, courseData, chapterPlans, courseName, courseId, includeTimestamps, locale) {
  const mergedContentKey = '__merged__';
  let fullContent = downloadState.chapterContents[mergedContentKey];

  if (!fullContent) {
    fullContent = `${'#'.repeat(60)}\n`;
    fullContent += `# ${courseData.title}\n`;
    fullContent += `# Total Chapters: ${chapterPlans.length}\n`;
    fullContent += `# Total Lectures: ${downloadState.progress.totalLectures}\n`;
    fullContent += `${'#'.repeat(60)}\n\n`;
    downloadState.chapterContents[mergedContentKey] = fullContent;
  }

  const startChapterPos = downloadState.progress.currentChapterIdx || 0;

  for (let pos = startChapterPos; pos < chapterPlans.length; pos++) {
    if (!downloadState.isRunning || downloadState.isPaused) {
      await saveState();
      return;
    }

    const { chapterIndex, lectureIndices } = chapterPlans[pos];
    const chapter = courseData.chapters[chapterIndex];
    const chapterNum = String(chapterIndex + 1).padStart(2, '0');

    fullContent += `\n${'='.repeat(60)}\n`;
    fullContent += `Chapter ${chapterNum}: ${chapter.title}\n`;
    fullContent += `${'='.repeat(60)}\n\n`;

    const startLecturePos = pos === startChapterPos ? (downloadState.progress.currentLectureIdx || 0) : 0;

    for (let lecturePos = startLecturePos; lecturePos < lectureIndices.length; lecturePos++) {
      while (downloadState.isPaused) {
        await sleep(1000);
        if (!downloadState.isRunning) return;
      }
      if (!downloadState.isRunning) return;

      const lectureIndex = lectureIndices[lecturePos];
      const lecture = chapter.lectures[lectureIndex];
      downloadState.progress.currentChapterIdx = pos;
      downloadState.progress.currentLectureName = lecture.title;
      broadcastProgress();

      const lectureNum = String(lectureIndex + 1).padStart(2, '0');
      fullContent += `${'-'.repeat(40)}\n`;
      fullContent += `Lecture ${lectureNum}: ${lecture.title}\n`;
      fullContent += `${'-'.repeat(40)}\n\n`;

      if (downloadState.completedLectures[lecture.id]) {
        fullContent += downloadState.completedLectures[lecture.id];
        downloadState.progress.successCount++;
      } else {
        const result = await fetchLectureCaption(tabId, courseId, lecture.id, locale || 'en', includeTimestamps);

        if (result && result.transcript) {
          fullContent += result.transcript;
          downloadState.completedLectures[lecture.id] = result.transcript;
          downloadState.progress.successCount++;
        } else {
          fullContent += '[無字幕]';
        }
      }

      fullContent += '\n\n';
      downloadState.chapterContents[mergedContentKey] = fullContent;
      downloadState.progress.processedLectures++;
      downloadState.progress.currentLectureIdx = lecturePos + 1;
      broadcastProgress();

      if (downloadState.progress.processedLectures % 5 === 0) {
        await saveState();
      }

      await sleep(CONFIG.BASE_DELAY);
    }

    downloadState.progress.currentChapterIdx = pos + 1;
    downloadState.progress.currentLectureIdx = 0;
    await saveState();
  }

  // 下載合併檔案
  const filename = `${courseName}_complete_transcript.txt`;
  downloadTextFile(fullContent, filename);
  delete downloadState.chapterContents[mergedContentKey];
}

// ============================================================
// 訊息處理
// ============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received:', request.action || request.type);

  // === popup 請求：取得課程資訊 ===
  if (request.action === 'fetchCourseInfo') {
    (async () => {
      try {
        const { tabId, courseId } = request;
        const chapters = await fetchCourseStructure(tabId, courseId);
        const totalLectures = chapters.reduce((sum, ch) => sum + ch.lectures.length, 0);
        sendResponse({
          success: true,
          data: { chapters, totalChapters: chapters.length, totalLectures }
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // === popup 請求：開始下載 ===
  if (request.action === 'startDownload') {
    const { tabId, courseData, options } = request;
    startDownload(tabId, courseData, options);
    sendResponse({ success: true });
    return true;
  }

  // === popup 請求：暫停下載 ===
  if (request.action === 'pauseDownload') {
    downloadState.isPaused = true;
    saveState();
    broadcastProgress();
    sendResponse({ success: true });
    return true;
  }

  // === popup 請求：繼續下載 ===
  if (request.action === 'resumeDownload') {
    if (downloadState.isPaused && downloadState.isRunning) {
      downloadState.isPaused = false;
      broadcastProgress();
    } else if (!downloadState.isRunning && downloadState.courseData) {
      // 從中斷恢復
      startDownload(downloadState.tabId, downloadState.courseData, downloadState.options, true);
    }
    sendResponse({ success: true });
    return true;
  }

  // === popup 請求：取消下載 ===
  if (request.action === 'cancelDownload') {
    downloadState.isRunning = false;
    downloadState.isPaused = false;
    clearState();
    broadcastProgress();
    sendResponse({ success: true });
    return true;
  }

  // === popup 請求：取得目前狀態 ===
  if (request.action === 'getDownloadState') {
    sendResponse({
      isRunning: downloadState.isRunning,
      isPaused: downloadState.isPaused,
      progress: downloadState.progress,
      error: downloadState.error,
      hasSavedState: !!(downloadState.courseData),
    });
    return true;
  }

  return true;
});

// ============================================================
// Service Worker 生命週期
// ============================================================
chrome.runtime.onInstalled.addListener(() => {
  console.log('Udemy Transcript Downloader v2.0 installed');
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('Udemy Transcript Downloader started');
  await loadState();
});

// Keepalive alarm handler
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    console.log('Keepalive ping');
  }
});
