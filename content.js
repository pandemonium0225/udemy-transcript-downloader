// Udemy Transcript Downloader - Content Script
// 使用 Udemy API 獲取課程結構和字幕

(function() {
  'use strict';

  // 從頁面獲取課程 ID
  function getCourseId() {
    const reactRoot = document.querySelector('[data-module-id="course-taking"]');
    if (reactRoot) {
      try {
        const moduleArgs = JSON.parse(reactRoot.dataset.moduleArgs || '{}');
        return moduleArgs.courseId;
      } catch(e) {
        console.error('Failed to parse module args:', e);
      }
    }
    return null;
  }

  // 獲取課程標題
  function getCourseTitle() {
    const titleEl = document.querySelector('title');
    if (titleEl) {
      return titleEl.textContent.replace(' | Udemy', '').trim();
    }
    return 'Udemy Course';
  }

  // 使用 API 獲取課程結構
  async function fetchCourseStructure(courseId) {
    const allItems = [];
    let nextUrl = `https://www.udemy.com/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=100&fields[lecture]=title,asset&fields[chapter]=title&fields[asset]=captions`;

    while (nextUrl) {
      try {
        const response = await fetch(nextUrl, { credentials: 'include' });
        if (!response.ok) {
          console.error('API error:', response.status);
          break;
        }
        const data = await response.json();
        allItems.push(...data.results);
        nextUrl = data.next;
      } catch (error) {
        console.error('Fetch error:', error);
        break;
      }
    }

    // 組織成章節和講座結構
    const chapters = [];
    let currentChapter = null;

    allItems.forEach(item => {
      if (item._class === 'chapter') {
        currentChapter = {
          id: item.id,
          title: item.title,
          lectures: []
        };
        chapters.push(currentChapter);
      } else if (item._class === 'lecture' && currentChapter) {
        currentChapter.lectures.push({
          id: item.id,
          title: item.title,
          hasCaptions: item.asset && item.asset.captions && item.asset.captions.length > 0
        });
      }
    });

    return chapters;
  }

  // 獲取單個講座的字幕
  async function fetchLectureCaption(courseId, lectureId, locale = 'en') {
    try {
      const response = await fetch(
        `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset,title&fields[asset]=captions`,
        { credentials: 'include' }
      );

      if (!response.ok) {
        console.error('Lecture API error:', response.status);
        return null;
      }

      const data = await response.json();

      if (!data.asset || !data.asset.captions || data.asset.captions.length === 0) {
        return { title: data.title, transcript: null };
      }

      // 找到合適的字幕 (優先英文)
      const captions = data.asset.captions;
      let caption = captions.find(c => c.locale_id && c.locale_id.startsWith(locale));
      if (!caption) {
        caption = captions.find(c => c.locale_id && c.locale_id.startsWith('en'));
      }
      if (!caption) {
        caption = captions[0];
      }

      if (!caption || !caption.url) {
        return { title: data.title, transcript: null };
      }

      // 下載 VTT 內容
      const vttResponse = await fetch(caption.url);
      const vttContent = await vttResponse.text();

      // 解析 VTT 為文字
      const transcript = parseVTT(vttContent);

      return {
        title: data.title,
        transcript: transcript,
        locale: caption.locale_id
      };
    } catch (error) {
      console.error('Error fetching caption:', error);
      return null;
    }
  }

  // 解析 VTT 格式為純文字
  function parseVTT(vttContent, includeTimestamps = true) {
    const lines = vttContent.split('\n');
    const result = [];
    let currentTime = '';
    let currentText = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 跳過 WEBVTT 標頭和空行
      if (line === 'WEBVTT' || line === '' || line.startsWith('NOTE')) {
        if (currentText.length > 0) {
          if (includeTimestamps && currentTime) {
            result.push(`[${currentTime}] ${currentText.join(' ')}`);
          } else {
            result.push(currentText.join(' '));
          }
          currentText = [];
        }
        continue;
      }

      // 檢查是否為時間軸行 (格式: 00:00.000 --> 00:00.000)
      if (line.includes('-->')) {
        if (currentText.length > 0) {
          if (includeTimestamps && currentTime) {
            result.push(`[${currentTime}] ${currentText.join(' ')}`);
          } else {
            result.push(currentText.join(' '));
          }
          currentText = [];
        }
        // 提取開始時間
        const timeMatch = line.match(/^(\d{2}:\d{2})/);
        if (timeMatch) {
          currentTime = timeMatch[1];
        }
        continue;
      }

      // 跳過純數字行 (cue 標識符)
      if (/^\d+$/.test(line)) {
        continue;
      }

      // 這是字幕文字
      if (line.length > 0) {
        // 移除 HTML 標籤
        const cleanText = line.replace(/<[^>]*>/g, '');
        if (cleanText) {
          currentText.push(cleanText);
        }
      }
    }

    // 處理最後一段
    if (currentText.length > 0) {
      if (includeTimestamps && currentTime) {
        result.push(`[${currentTime}] ${currentText.join(' ')}`);
      } else {
        result.push(currentText.join(' '));
      }
    }

    return result.join('\n');
  }

  // 檢查登入狀態
  function checkLoginStatus() {
    const userMenuSelectors = [
      '[data-purpose="user-dropdown"]',
      '.ud-avatar',
      '[class*="user-profile"]'
    ];

    for (const selector of userMenuSelectors) {
      if (document.querySelector(selector)) {
        return { isLoggedIn: true };
      }
    }

    const loginButtonSelectors = [
      '[data-purpose="header-login"]',
      'a[href*="/join/login"]'
    ];

    for (const selector of loginButtonSelectors) {
      if (document.querySelector(selector)) {
        return { isLoggedIn: false, reason: '請先登入 Udemy 帳號' };
      }
    }

    // 檢查是否有課程內容 (表示已登入)
    if (document.querySelector('[data-purpose="curriculum-section-container"]')) {
      return { isLoggedIn: true };
    }

    return { isLoggedIn: null, reason: '無法確認登入狀態' };
  }

  // 監聽來自 popup 的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Content script received:', request.action);

    if (request.action === 'getCourseInfo') {
      (async () => {
        try {
          const loginStatus = checkLoginStatus();
          if (loginStatus.isLoggedIn === false) {
            sendResponse({
              success: false,
              error: loginStatus.reason,
              errorType: 'not_logged_in'
            });
            return;
          }

          const courseId = getCourseId();
          console.log('Course ID:', courseId);

          if (!courseId) {
            sendResponse({
              success: false,
              error: '無法獲取課程 ID，請確保在課程播放頁面',
              errorType: 'no_course_id'
            });
            return;
          }

          const courseTitle = getCourseTitle();
          console.log('Course Title:', courseTitle);

          // 使用 API 獲取課程結構
          const chapters = await fetchCourseStructure(courseId);
          console.log('Chapters:', chapters.length);

          const totalLectures = chapters.reduce((sum, ch) => sum + ch.lectures.length, 0);

          sendResponse({
            success: true,
            data: {
              courseId: courseId,
              title: courseTitle,
              chapters: chapters,
              totalChapters: chapters.length,
              totalLectures: totalLectures
            }
          });
        } catch (error) {
          console.error('getCourseInfo error:', error);
          sendResponse({
            success: false,
            error: error.message
          });
        }
      })();
      return true; // 保持消息通道開啟
    }

    else if (request.action === 'getLectureTranscript') {
      (async () => {
        try {
          const { courseId, lectureId, includeTimestamps } = request;
          console.log(`Fetching transcript for lecture ${lectureId}`);

          const result = await fetchLectureCaption(courseId, lectureId);

          if (result) {
            // 重新解析 VTT 根據時間戳記設定
            if (result.transcript && !includeTimestamps) {
              // 需要重新下載並解析
              const response = await fetch(
                `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset,title&fields[asset]=captions`,
                { credentials: 'include' }
              );
              const data = await response.json();
              const captions = data.asset?.captions || [];
              let caption = captions.find(c => c.locale_id?.startsWith('en')) || captions[0];

              if (caption && caption.url) {
                const vttResponse = await fetch(caption.url);
                const vttContent = await vttResponse.text();
                result.transcript = parseVTT(vttContent, includeTimestamps);
              }
            }

            sendResponse({
              success: true,
              data: result
            });
          } else {
            sendResponse({
              success: false,
              error: '無法獲取字幕'
            });
          }
        } catch (error) {
          console.error('getLectureTranscript error:', error);
          sendResponse({
            success: false,
            error: error.message
          });
        }
      })();
      return true;
    }

    return true;
  });

  console.log('Udemy Transcript Downloader: Content script loaded (API version)');
})();
