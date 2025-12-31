// Udemy Transcript Downloader - Popup Script
// 使用 Udemy API 批次下載字幕

document.addEventListener('DOMContentLoaded', async () => {
  const courseTitle = document.getElementById('course-title');
  const courseStats = document.getElementById('course-stats');
  const chaptersList = document.getElementById('chapters-list');
  const downloadBtn = document.getElementById('download-btn');
  const downloadAllBtn = document.getElementById('download-all-btn');
  const selectAllBtn = document.getElementById('select-all');
  const selectNoneBtn = document.getElementById('select-none');
  const includeTimestamps = document.getElementById('include-timestamps');
  const progressSection = document.querySelector('.progress-section');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const statusDiv = document.getElementById('status');
  const notUdemy = document.getElementById('not-udemy');
  const notLoggedIn = document.getElementById('not-logged-in');
  const noAccess = document.getElementById('no-access');
  const noAccessReason = document.getElementById('no-access-reason');
  const mainContent = document.getElementById('main-content');

  let courseData = null;
  let currentTab = null;

  // 獲取當前分頁
  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // 檢查是否在 Udemy 課程頁面
  function isUdemyCoursePage(url) {
    return url && url.includes('udemy.com/course/');
  }

  // 發送消息到 content script
  async function sendMessage(action, data = {}) {
    // 先嘗試注入 content script (如果還沒注入的話)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content.js']
      });
      await sleep(500);
    } catch (e) {
      // 可能已經注入過了，忽略錯誤
      console.log('Script may already be injected:', e.message);
    }

    // 發送消息
    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, { action, ...data });
      return response;
    } catch (error) {
      console.error('Failed to send message:', error);
      throw new Error('無法連接到頁面，請重新整理 Udemy 頁面後再試');
    }
  }

  // 顯示狀態訊息
  function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }

  // 更新進度
  function updateProgress(current, total, text) {
    const percent = Math.round((current / total) * 100);
    progressFill.style.width = `${percent}%`;
    progressText.textContent = text || `處理中... ${current}/${total} (${percent}%)`;
  }

  // 清理檔名
  function sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
  }

  // 渲染章節列表
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

  // 獲取選中的章節
  function getSelectedChapters() {
    const checkboxes = chaptersList.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
  }

  // 下載單個文字檔
  function downloadTextFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false
    });
  }

  // 批次下載選中的章節 (分開檔案)
  async function downloadSelectedChapters() {
    const selectedIndices = getSelectedChapters();

    if (selectedIndices.length === 0) {
      showStatus('請至少選擇一個章節', 'error');
      return;
    }

    const withTimestamps = includeTimestamps.checked;
    const courseName = sanitizeFilename(courseData.title);
    const courseId = courseData.courseId;

    downloadBtn.disabled = true;
    downloadAllBtn.disabled = true;
    progressSection.style.display = 'block';

    let totalLectures = 0;
    selectedIndices.forEach(idx => {
      totalLectures += courseData.chapters[idx].lectures.length;
    });

    let processedLectures = 0;
    let successCount = 0;

    try {
      for (const chapterIndex of selectedIndices) {
        const chapter = courseData.chapters[chapterIndex];
        const chapterNum = String(chapterIndex + 1).padStart(2, '0');
        const chapterName = sanitizeFilename(chapter.title);

        let chapterContent = `${'='.repeat(60)}\n`;
        chapterContent += `Chapter ${chapterNum}: ${chapter.title}\n`;
        chapterContent += `${'='.repeat(60)}\n\n`;

        for (let i = 0; i < chapter.lectures.length; i++) {
          const lecture = chapter.lectures[i];
          processedLectures++;

          updateProgress(
            processedLectures,
            totalLectures,
            `正在下載: ${lecture.title.substring(0, 40)}...`
          );

          // 使用 API 獲取字幕
          const result = await sendMessage('getLectureTranscript', {
            courseId: courseId,
            lectureId: lecture.id,
            includeTimestamps: withTimestamps
          });

          const lectureNum = String(i + 1).padStart(2, '0');
          chapterContent += `${'-'.repeat(40)}\n`;
          chapterContent += `Lecture ${lectureNum}: ${lecture.title}\n`;
          chapterContent += `${'-'.repeat(40)}\n\n`;

          if (result && result.success && result.data && result.data.transcript) {
            chapterContent += result.data.transcript;
            successCount++;
          } else {
            chapterContent += '[無字幕]';
          }

          chapterContent += '\n\n';

          // 小延遲避免請求過快
          await sleep(200);
        }

        // 下載這個章節的檔案
        const filename = `${courseName}/${chapterNum}_${chapterName}.txt`;
        downloadTextFile(chapterContent, filename);

        await sleep(300);
      }

      showStatus(`成功下載 ${selectedIndices.length} 個章節！(${successCount}/${totalLectures} 個講座有字幕)`, 'success');
    } catch (error) {
      console.error('Download error:', error);
      showStatus(`下載失敗: ${error.message}`, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadAllBtn.disabled = false;
      progressSection.style.display = 'none';
    }
  }

  // 下載全部為單一合併檔案
  async function downloadAllMerged() {
    const withTimestamps = includeTimestamps.checked;
    const courseName = sanitizeFilename(courseData.title);
    const courseId = courseData.courseId;

    downloadBtn.disabled = true;
    downloadAllBtn.disabled = true;
    progressSection.style.display = 'block';

    const totalLectures = courseData.chapters.reduce((sum, ch) => sum + ch.lectures.length, 0);
    let processedLectures = 0;
    let successCount = 0;

    let fullContent = `${'#'.repeat(60)}\n`;
    fullContent += `# ${courseData.title}\n`;
    fullContent += `# Total Chapters: ${courseData.chapters.length}\n`;
    fullContent += `# Total Lectures: ${totalLectures}\n`;
    fullContent += `${'#'.repeat(60)}\n\n`;

    try {
      for (let chapterIndex = 0; chapterIndex < courseData.chapters.length; chapterIndex++) {
        const chapter = courseData.chapters[chapterIndex];
        const chapterNum = String(chapterIndex + 1).padStart(2, '0');

        fullContent += `\n${'='.repeat(60)}\n`;
        fullContent += `Chapter ${chapterNum}: ${chapter.title}\n`;
        fullContent += `${'='.repeat(60)}\n\n`;

        for (let i = 0; i < chapter.lectures.length; i++) {
          const lecture = chapter.lectures[i];
          processedLectures++;

          updateProgress(
            processedLectures,
            totalLectures,
            `正在下載: ${lecture.title.substring(0, 40)}...`
          );

          // 使用 API 獲取字幕
          const result = await sendMessage('getLectureTranscript', {
            courseId: courseId,
            lectureId: lecture.id,
            includeTimestamps: withTimestamps
          });

          const lectureNum = String(i + 1).padStart(2, '0');
          fullContent += `${'-'.repeat(40)}\n`;
          fullContent += `Lecture ${lectureNum}: ${lecture.title}\n`;
          fullContent += `${'-'.repeat(40)}\n\n`;

          if (result && result.success && result.data && result.data.transcript) {
            fullContent += result.data.transcript;
            successCount++;
          } else {
            fullContent += '[無字幕]';
          }

          fullContent += '\n\n';

          // 小延遲避免請求過快
          await sleep(200);
        }
      }

      // 下載合併檔案
      const filename = `${courseName}_complete_transcript.txt`;
      downloadTextFile(fullContent, filename);

      showStatus(`成功下載完整課程！(${successCount}/${totalLectures} 個講座有字幕)`, 'success');
    } catch (error) {
      console.error('Download error:', error);
      showStatus(`下載失敗: ${error.message}`, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadAllBtn.disabled = false;
      progressSection.style.display = 'none';
    }
  }

  // 睡眠函數
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 隱藏所有錯誤訊息
  function hideAllErrors() {
    notUdemy.style.display = 'none';
    notLoggedIn.style.display = 'none';
    noAccess.style.display = 'none';
    mainContent.style.display = 'block';
  }

  // 顯示特定錯誤
  function showError(type, reason = '') {
    mainContent.style.display = 'none';

    if (type === 'not_udemy') {
      notUdemy.style.display = 'block';
    } else if (type === 'not_logged_in') {
      notLoggedIn.style.display = 'block';
    } else if (type === 'no_access') {
      noAccess.style.display = 'block';
      if (reason) {
        noAccessReason.textContent = reason;
      }
    }
  }

  // 初始化
  async function init() {
    try {
      currentTab = await getCurrentTab();

      if (!isUdemyCoursePage(currentTab.url)) {
        showError('not_udemy');
        return;
      }

      chaptersList.innerHTML = '<p class="loading">正在載入課程結構...</p>';

      // 獲取課程信息
      const result = await sendMessage('getCourseInfo');

      if (result && result.success) {
        hideAllErrors();
        courseData = result.data;
        courseTitle.textContent = courseData.title;
        courseStats.textContent = `${courseData.totalChapters} 個章節 · ${courseData.totalLectures} 個講座`;
        renderChapters(courseData.chapters);
      } else if (result && !result.success) {
        if (result.errorType === 'not_logged_in') {
          showError('not_logged_in');
        } else if (result.errorType === 'no_access') {
          showError('no_access', result.error);
        } else {
          chaptersList.innerHTML = `<p class="loading">${result.error || '無法載入課程資訊，請重新整理頁面後再試'}</p>`;
        }
      } else {
        chaptersList.innerHTML = '<p class="loading">無法載入課程資訊，請重新整理頁面後再試</p>';
      }
    } catch (error) {
      console.error('Init error:', error);
      chaptersList.innerHTML = `<p class="loading">載入失敗: ${error.message}</p>`;
    }
  }

  // 事件監聽
  selectAllBtn.addEventListener('click', () => {
    chaptersList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  });

  selectNoneBtn.addEventListener('click', () => {
    chaptersList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  });

  downloadBtn.addEventListener('click', downloadSelectedChapters);
  downloadAllBtn.addEventListener('click', downloadAllMerged);

  // 啟動
  init();
});
