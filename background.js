// Udemy Transcript Downloader - Background Service Worker

// 監聽擴充功能安裝事件
chrome.runtime.onInstalled.addListener(() => {
  console.log('Udemy Transcript Downloader installed');
});

// 保持 service worker 活躍
chrome.runtime.onStartup.addListener(() => {
  console.log('Udemy Transcript Downloader started');
});
