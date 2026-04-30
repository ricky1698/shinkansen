// Regression: ASR 雙語字幕可插入 watch 頁 player 與 title 之間的面板(v1.8.25)
//
// 驗證:
//   1. bilingual + ASR + watch 頁時, current cue 會寫入頁面面板
//   2. 面板優先插入在 #below 開頭(真實 YouTube watch 頁較穩定)
//   3. 上排為原文,下排為譯文
//   4. cue 結束但下一句尚未就緒時,面板保留上一句,不立刻消失

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-borderless';

test('youtube-page-panel: ASR 雙語在 watch 頁插入 player/title 間面板', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=test`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#primary-inner', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      window.__SK.isYouTubePage = () => true;
      const video = document.querySelector('video');
      Object.defineProperty(video, 'currentTime', { value: 0.5, configurable: true });

      window.__SK.YT.active = true;
      window.__SK.YT.isAsr = true;
      window.__SK.YT.videoEl = video;
      window.__SK.YT.config = { bilingualMode: true };
      window.__SK.YT.displayCues = [
        { startMs: 0, endMs: 2000, sourceText: 'hello world', targetText: '你好世界' },
      ];

      window.__SK._updateOverlayForTest();

      const panel = document.getElementById('shinkansen-yt-page-subtitles');
      const below = document.querySelector('#below');
      return {
        exists: !!panel,
        parentId: panel?.parentElement?.id || '',
        firstInBelow: !!(panel && below && below.firstElementChild === panel),
        srcText: panel?.querySelector('.sk-yt-page-src')?.textContent || '',
        tgtText: panel?.querySelector('.sk-yt-page-tgt')?.textContent || '',
        display: panel?.style.display || '',
      };
    })()
  `);

  expect(result.exists, '應建立頁面字幕面板').toBe(true);
  expect(result.parentId, '面板應掛在 #below').toBe('below');
  expect(result.firstInBelow, '面板應成為 #below 的第一個子節點').toBe(true);
  expect(result.srcText, '上排應顯示原文').toBe('hello world');
  expect(result.tgtText, '下排應顯示譯文').toBe('你好世界');
  expect(result.display, '面板應顯示').toBe('block');

  await page.close();
});

test('youtube-page-panel: cue 結束後若暫時沒有下一句,面板保留上一句', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=test`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#primary-inner', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      window.__SK.isYouTubePage = () => true;
      const video = document.querySelector('video');
      window.__SK.YT.active = true;
      window.__SK.YT.isAsr = true;
      window.__SK.YT.videoEl = video;
      window.__SK.YT.config = { bilingualMode: true };
      window.__SK.YT.displayCues = [
        { startMs: 0, endMs: 2000, sourceText: 'hello world', targetText: '你好世界' },
      ];

      Object.defineProperty(video, 'currentTime', { value: 0.5, configurable: true });
      window.__SK._updateOverlayForTest();

      Object.defineProperty(video, 'currentTime', { value: 5.5, configurable: true });
      window.__SK._updateOverlayForTest();

      const panel = document.getElementById('shinkansen-yt-page-subtitles');
      return {
        srcText: panel?.querySelector('.sk-yt-page-src')?.textContent || '',
        tgtText: panel?.querySelector('.sk-yt-page-tgt')?.textContent || '',
        display: panel?.style.display || '',
      };
    })()
  `);

  expect(result.srcText, '沒有 active cue 時應保留上一句原文').toBe('hello world');
  expect(result.tgtText, '沒有 active cue 時應保留上一句譯文').toBe('你好世界');
  expect(result.display, '面板應保持顯示').toBe('block');

  await page.close();
});

test('youtube-page-panel: 非 ASR 雙語命中快取時寫入頁面面板並隱藏播放器字幕', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html?v=test`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#primary-inner', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      window.__SK.isYouTubePage = () => true;
      window.__SK.YT.active = true;
      window.__SK.YT.isAsr = false;
      window.__SK.YT.config = { bilingualMode: true };
      window.__SK.YT.captionMap.set('hello there', '你好啊');

      let container = document.querySelector('.ytp-caption-window-container');
      if (!container) {
        container = document.createElement('div');
        container.className = 'ytp-caption-window-container';
        document.querySelector('#movie_player')?.appendChild(container);
      }
      const span = document.createElement('span');
      span.className = 'ytp-caption-segment';
      span.id = 'cached-seg';
      span.textContent = 'hello there';
      container.appendChild(span);

      window.__SK._replaceSegmentEl(span);

      const panel = document.getElementById('shinkansen-yt-page-subtitles');
      return {
        panelExists: !!panel,
        srcText: panel?.querySelector('.sk-yt-page-src')?.textContent || '',
        tgtText: panel?.querySelector('.sk-yt-page-tgt')?.textContent || '',
        segText: span.textContent,
        playerClass: document.querySelector('#movie_player')?.className || '',
      };
    })()
  `);

  expect(result.panelExists, '非 ASR 雙語也應建立頁面字幕面板').toBe(true);
  expect(result.srcText, '面板上排應顯示原文').toBe('hello there');
  expect(result.tgtText, '面板下排應顯示譯文').toBe('你好啊');
  expect(result.segText, 'DOM 仍保留原文,避免改寫原生 cue').toBe('hello there');
  expect(result.playerClass, 'page panel 模式應隱藏播放器字幕').toContain('shinkansen-asr-active');

  await page.close();
});
