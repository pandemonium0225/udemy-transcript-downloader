// Udemy Transcript Downloader - Popup Script (v2.0)
// 純 UI 控制器：顯示資訊、發送指令給 background.js

document.addEventListener('DOMContentLoaded', async () => {
  // ============================================================
  // DOM 元素
  // ============================================================
  const courseTitle = document.getElementById('course-title');
  const courseStats = document.getElementById('course-stats');
  const chaptersList = document.getElementById('chapters-list');
  const downloadBtn = document.getElementById('download-btn');
  const downloadAllBtn = document.getElementById('download-all-btn');
  const selectAllBtn = document.getElementById('select-all');
  const selectNoneBtn = document.getElementById('select-none');
  const includeTimestamps = document.getElementById('include-timestamps');
  const localeSelect = document.getElementById('locale-select');
  const progressSection = document.querySelector('.progress-section');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const statusDiv = document.getElementById('status');
  const notUdemy = document.getElementById('not-udemy');
  const notLoggedIn = document.getElementById('not-logged-in');
  const noAccess = document.getElementById('no-access');
  const noAccessReason = document.getElementById('no-access-reason');
  const mainContent = document.getElementById('main-content');
  const pauseBtn = document.getElementById('pause-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const downloadControls = document.getElementById('download-controls');
  const runningControls = document.getElementById('running-controls');

  let courseData = null;
  let currentTab = null;

  // ============================================================
  // 工具函數
  // ============================================================
  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function isUdemyCoursePage(url) {
    return url && url.includes('udemy.com/course/');
  }

  async function sendToContentScript(action, data = {}) {
    // 嘗試注入 content script
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content.js']
      });
      await sleep(300);
    } catch (e) {
      // 可能已注入
    }

    try {
      return await chrome.tabs.sendMessage(currentTab.id, { action, ...data });
    } catch (error) {
      throw new Error('無法連接到頁面，請重新整理 Udemy 頁面後再試');
    }
  }

  async function sendToBackground(action, data = {}) {
    return chrome.runtime.sendMessage({ action, ...data });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
  }

  // ============================================================
  // UI 更新
  // ============================================================
  function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }

  function updateProgress(progress) {
    const { processedLectures, totalLectures, currentLectureName } = progress;
    const percent = totalLectures > 0 ? Math.round((processedLectures / totalLectures) * 100) : 0;
    progressFill.style.width = `${percent}%`;
    const displayName = currentLectureName
      ? currentLectureName.substring(0, 40) + (currentLectureName.length > 40 ? '...' : '')
      : '';
    progressText.textContent = `${processedLectures}/${totalLectures} (${percent}%) ${displayName}`;
  }

  function showDownloadUI() {
    downloadControls.style.display = 'flex';
    runningControls.style.display = 'none';
    progressSection.style.display = 'none';
  }

  function showRunningUI(isPaused) {
    downloadControls.style.display = 'none';
    runningControls.style.display = 'flex';
    progressSection.style.display = 'block';
    pauseBtn.textContent = isPaused ? '繼續' : '暫停';
    pauseBtn.className = isPaused ? 'btn-primary' : 'btn-secondary';
  }

  function renderChapters(chapters) {
    if (!chapters || chapters.length === 0) {
      chaptersList.innerHTML = '<p class="loading">找不到章節，請確保課程內容已載入</p>';
      return;
    }

    chaptersList.innerHTML = chapters.map((chapter, index) => `
      <div class="chapter-item">
        <input type="checkbox" id="chapter-${index}" data-index="${index}" checked>
        <label for="chapter-${index}">
          <span class="chapter-title">${chapter.title || `Chapter ${index + 1}`}</span>
          <span class="chapter-lectures">${chapter.lectures.length} 個講座</span>
        </label>
      </div>
    `).join('');

    downloadBtn.disabled = false;
    downloadAllBtn.disabled = false;
  }

  function getSelectedChapters() {
    const checkboxes = chaptersList.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
  }

  function renderLocaleSelect(locales) {
    if (!locales || locales.length === 0) {
      localeSelect.innerHTML = '<option value="en">English (預設)</option>';
      return;
    }

    const localeNames = {
      'en_US': 'English (US)',
      'en_GB': 'English (UK)',
      'zh_TW': '繁體中文',
      'zh_CN': '簡體中文',
      'ja_JP': '日本語',
      'ko_KR': '한국어',
      'es_ES': 'Español',
      'fr_FR': 'Français',
      'de_DE': 'Deutsch',
      'pt_BR': 'Português (BR)',
      'it_IT': 'Italiano',
      'vi_VN': 'Tiếng Việt',
      'th_TH': 'ไทย',
      'id_ID': 'Bahasa Indonesia',
    };

    localeSelect.innerHTML = locales.map(loc => {
      const name = localeNames[loc] || loc;
      return `<option value="${loc}">${name}</option>`;
    }).join('');
  }

  function hideAllErrors() {
    notUdemy.style.display = 'none';
    notLoggedIn.style.display = 'none';
    noAccess.style.display = 'none';
    mainContent.style.display = 'block';
  }

  function showError(type, reason = '') {
    mainContent.style.display = 'none';
    if (type === 'not_udemy') notUdemy.style.display = 'block';
    else if (type === 'not_logged_in') notLoggedIn.style.display = 'block';
    else if (type === 'no_access') {
      noAccess.style.display = 'block';
      if (reason) noAccessReason.textContent = reason;
    }
  }

  // ============================================================
  // 下載動作
  // ============================================================
  async function startDownload(mergeMode) {
    const selectedIndices = mergeMode ? null : getSelectedChapters();

    if (!mergeMode && selectedIndices.length === 0) {
      showStatus('請至少選擇一個章節', 'error');
      return;
    }

    const options = {
      includeTimestamps: includeTimestamps.checked,
      locale: localeSelect.value,
      selectedIndices: mergeMode
        ? courseData.chapters.map((_, i) => i)
        : selectedIndices,
      mergeMode,
    };

    showRunningUI(false);

    try {
      await sendToBackground('startDownload', {
        tabId: currentTab.id,
        courseData,
        options,
      });
    } catch (error) {
      showStatus(`啟動下載失敗: ${error.message}`, 'error');
      showDownloadUI();
    }
  }

  // ============================================================
  // 監聽 background 進度廣播
  // ============================================================
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'progressUpdate') {
      const { isRunning, isPaused, progress, error } = message.state;

      if (isRunning) {
        showRunningUI(isPaused);
        updateProgress(progress);
      } else {
        showDownloadUI();
        if (error) {
          showStatus(`下載失敗: ${error}`, 'error');
        } else if (progress.processedLectures > 0) {
          showStatus(
            `下載完成！(${progress.successCount}/${progress.totalLectures} 個講座有字幕)`,
            'success'
          );
        }
      }
    }
  });

  // ============================================================
  // 初始化
  // ============================================================
  async function init() {
    try {
      currentTab = await getCurrentTab();

      if (!isUdemyCoursePage(currentTab.url)) {
        showError('not_udemy');
        return;
      }

      // 先檢查是否有正在執行的下載
      const bgState = await sendToBackground('getDownloadState');
      if (bgState && bgState.isRunning) {
        showRunningUI(bgState.isPaused);
        updateProgress(bgState.progress);
        return;
      }

      chaptersList.innerHTML = '<p class="loading">正在載入課程結構...</p>';

      // 從 content script 取得課程基本資訊
      const result = await sendToContentScript('getCourseInfo');

      if (result && result.success) {
        hideAllErrors();

        const { courseId, title, availableLocales } = result.data;

        // 用 background 的 API 代理取得完整課程結構
        const structResult = await sendToBackground('fetchCourseInfo', {
          tabId: currentTab.id,
          courseId,
        });

        if (structResult && structResult.success) {
          courseData = {
            courseId,
            title,
            chapters: structResult.data.chapters,
            totalChapters: structResult.data.totalChapters,
            totalLectures: structResult.data.totalLectures,
          };

          courseTitle.textContent = title;
          courseStats.textContent = `${courseData.totalChapters} 個章節 · ${courseData.totalLectures} 個講座`;
          renderChapters(courseData.chapters);
          renderLocaleSelect(availableLocales);
        } else {
          chaptersList.innerHTML = `<p class="loading">${structResult?.error || '無法載入課程結構'}</p>`;
        }

      } else if (result && !result.success) {
        if (result.errorType === 'not_logged_in') showError('not_logged_in');
        else if (result.errorType === 'no_access') showError('no_access', result.error);
        else chaptersList.innerHTML = `<p class="loading">${result.error || '無法載入課程資訊'}</p>`;
      } else {
        chaptersList.innerHTML = '<p class="loading">無法載入課程資訊，請重新整理頁面後再試</p>';
      }
    } catch (error) {
      console.error('Init error:', error);
      chaptersList.innerHTML = `<p class="loading">載入失敗: ${error.message}</p>`;
    }
  }

  // ============================================================
  // 事件綁定
  // ============================================================
  selectAllBtn.addEventListener('click', () => {
    chaptersList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  });

  selectNoneBtn.addEventListener('click', () => {
    chaptersList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  });

  downloadBtn.addEventListener('click', () => startDownload(false));
  downloadAllBtn.addEventListener('click', () => startDownload(true));

  pauseBtn.addEventListener('click', async () => {
    const state = await sendToBackground('getDownloadState');
    if (state.isPaused) {
      await sendToBackground('resumeDownload');
      pauseBtn.textContent = '暫停';
      pauseBtn.className = 'btn-secondary';
    } else {
      await sendToBackground('pauseDownload');
      pauseBtn.textContent = '繼續';
      pauseBtn.className = 'btn-primary';
    }
  });

  cancelBtn.addEventListener('click', async () => {
    await sendToBackground('cancelDownload');
    showDownloadUI();
    showStatus('已取消下載', 'info');
  });

  // 啟動
  init();
});
