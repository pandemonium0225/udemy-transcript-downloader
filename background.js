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
  options: {},            // { includeTimestamps, locale, selectedIndices, mergeMode }
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
// VTT 解析 (含去重邏輯)
// ============================================================
function parseVTT(vttContent, includeTimestamps = true) {
  const lines = vttContent.split('\n');
  const result = [];
  let currentTime = '';
  let currentText = [];
  const seenTexts = new Set(); // 去重用

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === 'WEBVTT' || line === '' || line.startsWith('NOTE')) {
      if (currentText.length > 0) {
        const text = currentText.join(' ');
        if (!seenTexts.has(text)) {
          seenTexts.add(text);
          if (includeTimestamps && currentTime) {
            result.push(`[${currentTime}] ${text}`);
          } else {
            result.push(text);
          }
        }
        currentText = [];
      }
      continue;
    }

    if (line.includes('-->')) {
      if (currentText.length > 0) {
        const text = currentText.join(' ');
        if (!seenTexts.has(text)) {
          seenTexts.add(text);
          if (includeTimestamps && currentTime) {
            result.push(`[${currentTime}] ${text}`);
          } else {
            result.push(text);
          }
        }
        currentText = [];
      }
      const timeMatch = line.match(/^(\d{2}:\d{2})/);
      if (timeMatch) {
        currentTime = timeMatch[1];
      }
      continue;
    }

    if (/^\d+$/.test(line)) {
      continue;
    }

    if (line.length > 0) {
      const cleanText = line.replace(/<[^>]*>/g, '');
      if (cleanText) {
        currentText.push(cleanText);
      }
    }
  }

  // 處理最後一段
  if (currentText.length > 0) {
    const text = currentText.join(' ');
    if (!seenTexts.has(text)) {
      if (includeTimestamps && currentTime) {
        result.push(`[${currentTime}] ${text}`);
      } else {
        result.push(text);
      }
    }
  }

  return result.join('\n');
}

// ============================================================
// API 呼叫 (透過 content script 代理，以保留 cookie)
// ============================================================
async function proxyFetch(tabId, url) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (apiUrl) => {
        try {
          const resp = await fetch(apiUrl, { credentials: 'include' });
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
  let nextUrl = `${CONFIG.API_BASE}/courses/${courseId}/subscriber-curriculum-items/?page_size=${CONFIG.PAGE_SIZE}&fields[lecture]=title,asset&fields[chapter]=title&fields[asset]=captions&fields[caption]=url,locale_id`;

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
      currentChapter.lectures.push({
        id: item.id,
        title: item.title,
        hasCaptions: item.asset && item.asset.captions && item.asset.captions.length > 0,
      });
    }
  });

  return chapters;
}

// 取得單個講座字幕
async function fetchLectureCaption(tabId, courseId, lectureId, locale = 'en', includeTimestamps = true) {
  const url = `${CONFIG.API_BASE}/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset,title&fields[asset]=captions&fields[caption]=url,locale_id,title`;
  const result = await proxyFetchWithRetry(tabId, url);

  if (result.error) {
    console.error('Lecture API error:', result.status || result.message);
    return null;
  }

  const data = JSON.parse(result.body);

  if (!data.asset || !data.asset.captions || data.asset.captions.length === 0) {
    return { title: data.title, transcript: null };
  }

  const captions = data.asset.captions;
  let caption = captions.find(c => c.locale_id && c.locale_id.startsWith(locale));
  if (!caption) caption = captions.find(c => c.locale_id && c.locale_id.startsWith('en'));
  if (!caption) caption = captions[0];

  if (!caption || !caption.url) {
    return { title: data.title, transcript: null };
  }

  // 先嘗試直接 fetch VTT（CDN 簽名 URL 通常不需 cookie）
  try {
    const vttResponse = await fetchWithRetry(caption.url);
    if (vttResponse.ok) {
      const vttContent = await vttResponse.text();
      const transcript = parseVTT(vttContent, includeTimestamps);
      return { title: data.title, transcript, locale: caption.locale_id };
    }
  } catch (e) {
    console.warn('Direct VTT fetch failed, trying proxy:', e.message);
  }

  // 直接 fetch 失敗時，透過頁面 context 代理存取
  try {
    const vttResult = await proxyFetchWithRetry(tabId, caption.url);
    if (!vttResult.error) {
      const transcript = parseVTT(vttResult.body, includeTimestamps);
      return { title: data.title, transcript, locale: caption.locale_id };
    }
  } catch (e) {
    console.error('Proxy VTT fetch also failed:', e.message);
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
async function startDownload(tabId, courseData, options) {
  const { includeTimestamps, locale, selectedIndices, mergeMode } = options;
  const courseId = courseData.courseId;
  const courseName = sanitizeFilename(courseData.title);

  // 計算需處理的總講座數
  let totalLectures = 0;
  const indices = selectedIndices || courseData.chapters.map((_, i) => i);
  indices.forEach(idx => {
    totalLectures += courseData.chapters[idx].lectures.length;
  });

  // 初始化或恢復狀態
  downloadState.isRunning = true;
  downloadState.isPaused = false;
  downloadState.courseData = courseData;
  downloadState.tabId = tabId;
  downloadState.options = options;
  downloadState.error = null;
  downloadState.progress.totalLectures = totalLectures;

  await saveState();
  broadcastProgress();

  // 設定 keepalive alarm
  chrome.alarms.create('keepalive', { periodInMinutes: CONFIG.KEEPALIVE_INTERVAL / 60 });

  try {
    if (mergeMode) {
      await downloadMerged(tabId, courseData, indices, courseName, courseId, includeTimestamps, locale);
    } else {
      await downloadByChapter(tabId, courseData, indices, courseName, courseId, includeTimestamps, locale);
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

async function downloadByChapter(tabId, courseData, indices, courseName, courseId, includeTimestamps, locale) {
  // 從斷點恢復：跳過已完成的章節
  const startChapterPos = downloadState.progress.currentChapterIdx || 0;

  for (let pos = startChapterPos; pos < indices.length; pos++) {
    if (!downloadState.isRunning || downloadState.isPaused) {
      await saveState();
      return;
    }

    const chapterIndex = indices[pos];
    const chapter = courseData.chapters[chapterIndex];
    const chapterNum = String(chapterIndex + 1).padStart(2, '0');
    const chapterName = sanitizeFilename(chapter.title);

    let chapterContent = `${'='.repeat(60)}\n`;
    chapterContent += `Chapter ${chapterNum}: ${chapter.title}\n`;
    chapterContent += `${'='.repeat(60)}\n\n`;

    const startLecture = (pos === startChapterPos) ? (downloadState.progress.currentLectureIdx || 0) : 0;

    for (let i = startLecture; i < chapter.lectures.length; i++) {
      // 檢查暫停/停止
      while (downloadState.isPaused) {
        await sleep(1000);
        if (!downloadState.isRunning) return;
      }
      if (!downloadState.isRunning) return;

      const lecture = chapter.lectures[i];
      downloadState.progress.currentChapterIdx = pos;
      downloadState.progress.currentLectureIdx = i;
      downloadState.progress.currentLectureName = lecture.title;
      broadcastProgress();

      const lectureNum = String(i + 1).padStart(2, '0');
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
      downloadState.progress.processedLectures++;
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

    // 重設 lecture index
    downloadState.progress.currentLectureIdx = 0;
  }
}

async function downloadMerged(tabId, courseData, indices, courseName, courseId, includeTimestamps, locale) {
  let fullContent = `${'#'.repeat(60)}\n`;
  fullContent += `# ${courseData.title}\n`;
  fullContent += `# Total Chapters: ${courseData.chapters.length}\n`;
  fullContent += `# Total Lectures: ${downloadState.progress.totalLectures}\n`;
  fullContent += `${'#'.repeat(60)}\n\n`;

  const startChapterPos = downloadState.progress.currentChapterIdx || 0;

  for (let pos = startChapterPos; pos < indices.length; pos++) {
    if (!downloadState.isRunning || downloadState.isPaused) {
      await saveState();
      return;
    }

    const chapterIndex = indices[pos];
    const chapter = courseData.chapters[chapterIndex];
    const chapterNum = String(chapterIndex + 1).padStart(2, '0');

    fullContent += `\n${'='.repeat(60)}\n`;
    fullContent += `Chapter ${chapterNum}: ${chapter.title}\n`;
    fullContent += `${'='.repeat(60)}\n\n`;

    const startLecture = (pos === startChapterPos) ? (downloadState.progress.currentLectureIdx || 0) : 0;

    for (let i = startLecture; i < chapter.lectures.length; i++) {
      while (downloadState.isPaused) {
        await sleep(1000);
        if (!downloadState.isRunning) return;
      }
      if (!downloadState.isRunning) return;

      const lecture = chapter.lectures[i];
      downloadState.progress.currentChapterIdx = pos;
      downloadState.progress.currentLectureIdx = i;
      downloadState.progress.currentLectureName = lecture.title;
      broadcastProgress();

      const lectureNum = String(i + 1).padStart(2, '0');
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
      downloadState.progress.processedLectures++;
      broadcastProgress();

      if (downloadState.progress.processedLectures % 5 === 0) {
        await saveState();
      }

      await sleep(CONFIG.BASE_DELAY);
    }

    downloadState.progress.currentLectureIdx = 0;
  }

  // 下載合併檔案
  const filename = `${courseName}_complete_transcript.txt`;
  downloadTextFile(fullContent, filename);
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
      startDownload(downloadState.tabId, downloadState.courseData, downloadState.options);
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
