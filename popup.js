// Udemy Transcript Downloader - Popup Script (v2.1)
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
  const selectionSummary = document.getElementById('selection-summary');
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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getLectureCheckboxes(chapterIndex) {
    return Array.from(
      chaptersList.querySelectorAll(`.lecture-checkbox[data-chapter-index="${chapterIndex}"]`)
    );
  }

  function buildAllChapterPlans() {
    if (!courseData) return [];

    return courseData.chapters
      .map((chapter, chapterIndex) => ({
        chapterIndex,
        lectureIndices: chapter.lectures.map((_, lectureIndex) => lectureIndex),
      }))
      .filter(plan => plan.lectureIndices.length > 0);
  }

  function getSelectedChapterPlans() {
    if (!courseData) return [];

    return courseData.chapters
      .map((_, chapterIndex) => {
        const lectureIndices = getLectureCheckboxes(chapterIndex)
          .filter(checkbox => checkbox.checked)
          .map(checkbox => parseInt(checkbox.dataset.lectureIndex, 10));

        return lectureIndices.length > 0 ? { chapterIndex, lectureIndices } : null;
      })
      .filter(Boolean);
  }

  function syncChapterCheckbox(chapterIndex) {
    const chapterCheckbox = chaptersList.querySelector(`.chapter-checkbox[data-index="${chapterIndex}"]`);
    if (!chapterCheckbox) return;

    const lectureCheckboxes = getLectureCheckboxes(chapterIndex);
    const checkedCount = lectureCheckboxes.filter(checkbox => checkbox.checked).length;

    chapterCheckbox.checked = checkedCount > 0 && checkedCount === lectureCheckboxes.length;
    chapterCheckbox.indeterminate = checkedCount > 0 && checkedCount < lectureCheckboxes.length;
  }

  function syncAllChapterCheckboxes() {
    if (!courseData) return;
    courseData.chapters.forEach((_, chapterIndex) => syncChapterCheckbox(chapterIndex));
  }

  function updateSelectionSummary() {
    const chapterPlans = getSelectedChapterPlans();
    const lectureCount = chapterPlans.reduce((sum, plan) => sum + plan.lectureIndices.length, 0);

    if (lectureCount === 0) {
      selectionSummary.textContent = '目前未選擇任何講座';
      downloadBtn.disabled = true;
      downloadAllBtn.disabled = false;
      return;
    }

    selectionSummary.textContent = `已選擇 ${chapterPlans.length} 個章節中的 ${lectureCount} 個講座`;
    downloadBtn.disabled = false;
    downloadAllBtn.disabled = false;
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
      selectionSummary.textContent = '目前未選擇任何講座';
      return;
    }

    chaptersList.innerHTML = chapters.map((chapter, chapterIndex) => {
      const chapterTitle = escapeHtml(chapter.title || `Chapter ${chapterIndex + 1}`);
      const lectureItems = chapter.lectures.map((lecture, lectureIndex) => {
        const lectureTitle = escapeHtml(lecture.title || `Lecture ${lectureIndex + 1}`);
        const lectureMeta = lecture.hasCaptions
          ? '偵測到字幕來源'
          : '未預先偵測到字幕，仍會嘗試抓取';

        return `
          <div class="lecture-item ${lecture.hasCaptions ? '' : 'lecture-no-captions'}">
            <input
              type="checkbox"
              id="lecture-${chapterIndex}-${lectureIndex}"
              class="lecture-checkbox"
              data-chapter-index="${chapterIndex}"
              data-lecture-index="${lectureIndex}"
            >
            <label for="lecture-${chapterIndex}-${lectureIndex}">
              <span class="lecture-title">${String(lectureIndex + 1).padStart(2, '0')}. ${lectureTitle}</span>
              <span class="lecture-meta">${lectureMeta}</span>
            </label>
          </div>
        `;
      }).join('');

      return `
        <div class="chapter-card">
          <div class="chapter-item">
            <div class="chapter-main">
              <input type="checkbox" id="chapter-${chapterIndex}" class="chapter-checkbox" data-index="${chapterIndex}">
              <label for="chapter-${chapterIndex}">
                <span class="chapter-title">${chapterTitle}</span>
                <span class="chapter-lectures">${chapter.lectures.length} 個講座</span>
              </label>
            </div>
            <button type="button" class="btn-small toggle-lectures" data-index="${chapterIndex}" aria-expanded="true">收合</button>
          </div>
          <div class="lectures-list" id="lectures-${chapterIndex}">
            ${lectureItems}
          </div>
        </div>
      `;
    }).join('');

    syncAllChapterCheckboxes();
    updateSelectionSummary();
  }

  function renderLocaleSelect(locales) {
    if (!locales || locales.length === 0) {
      localeSelect.innerHTML = '<option value="en">English (預設)</option>';
      return;
    }

    const localeNames = {
      en: 'English',
      en_US: 'English (US)',
      en_GB: 'English (UK)',
      zh_TW: '繁體中文',
      zh_CN: '簡體中文',
      ja_JP: '日本語',
      ko_KR: '한국어',
      es_ES: 'Español',
      fr_FR: 'Français',
      de_DE: 'Deutsch',
      pt_BR: 'Português (BR)',
      it_IT: 'Italiano',
      vi_VN: 'Tiếng Việt',
      th_TH: 'ไทย',
      id_ID: 'Bahasa Indonesia',
    };

    localeSelect.innerHTML = locales.map(locale => {
      const name = localeNames[locale] || locale;
      return `<option value="${escapeHtml(locale)}">${escapeHtml(name)}</option>`;
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
    const selectedChapterPlans = mergeMode ? buildAllChapterPlans() : getSelectedChapterPlans();

    if (selectedChapterPlans.length === 0) {
      showStatus('請至少選擇一個講座', 'error');
      return;
    }

    const options = {
      includeTimestamps: includeTimestamps.checked,
      locale: localeSelect.value,
      selectedChapterPlans,
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
            `下載完成！(${progress.successCount}/${progress.totalLectures} 個講座成功取得字幕)`,
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

      const bgState = await sendToBackground('getDownloadState');
      if (bgState && bgState.isRunning) {
        showRunningUI(bgState.isPaused);
        updateProgress(bgState.progress);
        return;
      }

      downloadBtn.disabled = true;
      downloadAllBtn.disabled = true;
      chaptersList.innerHTML = '<p class="loading">正在載入課程結構...</p>';

      const result = await sendToContentScript('getCourseInfo');

      if (result && result.success) {
        hideAllErrors();

        const { courseId, title, availableLocales } = result.data;
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
    chaptersList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.checked = true;
    });
    syncAllChapterCheckboxes();
    updateSelectionSummary();
  });

  selectNoneBtn.addEventListener('click', () => {
    chaptersList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.checked = false;
    });
    syncAllChapterCheckboxes();
    updateSelectionSummary();
  });

  chaptersList.addEventListener('change', (event) => {
    const target = event.target;

    if (target.classList.contains('chapter-checkbox')) {
      const chapterIndex = parseInt(target.dataset.index, 10);
      getLectureCheckboxes(chapterIndex).forEach(checkbox => {
        checkbox.checked = target.checked;
      });
      syncChapterCheckbox(chapterIndex);
      updateSelectionSummary();
      return;
    }

    if (target.classList.contains('lecture-checkbox')) {
      const chapterIndex = parseInt(target.dataset.chapterIndex, 10);
      syncChapterCheckbox(chapterIndex);
      updateSelectionSummary();
    }
  });

  chaptersList.addEventListener('click', (event) => {
    const toggleButton = event.target.closest('.toggle-lectures');
    if (!toggleButton) return;

    const chapterIndex = toggleButton.dataset.index;
    const lectureList = document.getElementById(`lectures-${chapterIndex}`);
    const isExpanded = toggleButton.getAttribute('aria-expanded') === 'true';

    lectureList.classList.toggle('is-collapsed', isExpanded);
    toggleButton.setAttribute('aria-expanded', String(!isExpanded));
    toggleButton.textContent = isExpanded ? '展開' : '收合';
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

  init();
});
