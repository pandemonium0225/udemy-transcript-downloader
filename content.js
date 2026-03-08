// Udemy Transcript Downloader - Content Script (v2.0)
// 精簡版：只負責取得課程 ID 與基本資訊，下載邏輯在 background.js

(function() {
  'use strict';

  // ============================================================
  // 多策略取得課程 ID
  // ============================================================
  function getCourseId() {
    // 策略 1: 從 React data-module-args 取得
    const reactRoot = document.querySelector('[data-module-id="course-taking"]');
    if (reactRoot) {
      try {
        const moduleArgs = JSON.parse(reactRoot.dataset.moduleArgs || '{}');
        if (moduleArgs.courseId) return moduleArgs.courseId;
      } catch(e) {
        console.warn('Strategy 1 failed:', e.message);
      }
    }

    // 策略 2: 從頁面中的 JSON-LD 結構化資料取得
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data['@type'] === 'Course' && data.url) {
          const match = data.url.match(/\/course\/([^/]+)/);
          if (match) return match[1]; // slug, not numeric ID
        }
      } catch(e) { /* skip */ }
    }

    // 策略 3: 從 window 全域變數取得
    try {
      const udData = window.__UDEMY_DATA__;
      if (udData && udData.course && udData.course.id) {
        return udData.course.id;
      }
    } catch(e) { /* skip */ }

    // 策略 4: 從 body 上的 data 屬性取得
    const bodyDataCourse = document.body?.dataset?.courseId;
    if (bodyDataCourse) return bodyDataCourse;

    // 策略 5: 從 URL 解析 course slug，再用 API 取得數字 ID
    // (此策略需要額外的 API 呼叫，在 getCourseInfo handler 中處理)
    const urlMatch = window.location.pathname.match(/\/course\/([^/]+)/);
    if (urlMatch) {
      return { type: 'slug', slug: urlMatch[1] };
    }

    return null;
  }

  // 從 slug 解析出數字 ID
  async function resolveSlugToId(slug) {
    try {
      const response = await fetch(
        `https://www.udemy.com/api-2.0/courses/${slug}/?fields[course]=id,title`,
        { credentials: 'include' }
      );
      if (response.ok) {
        const data = await response.json();
        return data.id;
      }
    } catch(e) {
      console.error('Failed to resolve slug:', e);
    }
    return null;
  }

  // 獲取課程標題
  function getCourseTitle() {
    // 嘗試多個來源
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) return ogTitle.content.trim();

    const titleEl = document.querySelector('title');
    if (titleEl) return titleEl.textContent.replace(' | Udemy', '').trim();

    return 'Udemy Course';
  }

  // 取得可用的字幕語言列表
  async function getAvailableLocales(courseId) {
    try {
      const response = await fetch(
        `https://www.udemy.com/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=1&fields[lecture]=asset&fields[asset]=captions`,
        { credentials: 'include' }
      );
      if (!response.ok) return [];

      const data = await response.json();
      const locales = new Set();

      for (const item of data.results) {
        if (item._class === 'lecture' && item.asset && item.asset.captions) {
          for (const cap of item.asset.captions) {
            if (cap.locale_id) locales.add(cap.locale_id);
          }
        }
      }

      return Array.from(locales);
    } catch(e) {
      return [];
    }
  }

  // 檢查登入狀態 (改用 API 回應判斷)
  async function checkLoginViaAPI(courseId) {
    try {
      const response = await fetch(
        `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/?fields[course]=id`,
        { credentials: 'include' }
      );

      if (response.ok) return { isLoggedIn: true, hasAccess: true };
      if (response.status === 401) return { isLoggedIn: false, reason: '請先登入 Udemy 帳號' };
      if (response.status === 403) return { isLoggedIn: true, hasAccess: false, reason: '您可能尚未購買此課程' };

      return { isLoggedIn: null, reason: `API 回傳狀態碼: ${response.status}` };
    } catch(e) {
      return { isLoggedIn: null, reason: `連線失敗: ${e.message}` };
    }
  }

  // ============================================================
  // 訊息處理
  // ============================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getCourseInfo') {
      (async () => {
        try {
          let courseId = getCourseId();

          // 如果拿到的是 slug，需要解析成數字 ID
          if (courseId && typeof courseId === 'object' && courseId.type === 'slug') {
            const numericId = await resolveSlugToId(courseId.slug);
            if (numericId) {
              courseId = numericId;
            } else {
              sendResponse({
                success: false,
                error: '無法解析課程 ID，請重新整理頁面',
                errorType: 'no_course_id'
              });
              return;
            }
          }

          if (!courseId) {
            sendResponse({
              success: false,
              error: '無法獲取課程 ID，請確保在課程播放頁面',
              errorType: 'no_course_id'
            });
            return;
          }

          // 用 API 確認登入狀態
          const loginStatus = await checkLoginViaAPI(courseId);

          if (loginStatus.isLoggedIn === false) {
            sendResponse({ success: false, error: loginStatus.reason, errorType: 'not_logged_in' });
            return;
          }
          if (loginStatus.hasAccess === false) {
            sendResponse({ success: false, error: loginStatus.reason, errorType: 'no_access' });
            return;
          }

          const courseTitle = getCourseTitle();
          const availableLocales = await getAvailableLocales(courseId);

          sendResponse({
            success: true,
            data: {
              courseId,
              title: courseTitle,
              availableLocales,
            }
          });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    }

    return true;
  });

  console.log('Udemy Transcript Downloader v2.0: Content script loaded');
})();
