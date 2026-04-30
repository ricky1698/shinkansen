// Regression: ASR 雙語模式直接啟動時,應由 overlay 自己畫出「原文上 / 譯文下」(v1.8.25)
//
// 背景:
//   舊版雙語 ASR 依賴「保留原生英文 CC + 中文 overlay 上抬」,
//   實際順序變成中文在上、英文在下,和 README / 使用者預期相反。
//
// 修法(v1.8.25):
//   1. bilingual=true 時也維持 _setAsrHidingMode(true),不再顯示原生 CC
//   2. _updateOverlay 把 cue.sourceText 一起傳入 _setOverlayContent
//   3. _setOverlayContent 在雙語模式下顯示 .src row,形成 overlay 內部兩行:
//        .src = 原文(上)
//        .tgt = 譯文(下)
//
// 驗證:
//   - 雙語 ASR 直接啟動時 stylesheet 仍會注入
//   - player root 維持 shinkansen-asr-active(原生 CC 被隱藏)
//   - overlay host 有 [bilingual] attribute
//   - shadow DOM 內 .src / .tgt 都可見,且順序為原文在上、譯文在下

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-spa-navigate';

test('youtube-bilingual-reload-stylesheet: ASR 雙語直接啟動 → 原生 CC 隱藏 + overlay 顯示原文上譯文下', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-content', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__SK.YT.active = true;
    window.__SK.YT.isAsr = true;
    window.__SK.YT.config = { bilingualMode: true };
    window.__SK._setOverlayContentForTest('你好世界', 'hello world');
    window.__SK._applyBilingualModeForTest(true);
  `);

  const result = await evaluate(`
    (() => {
      const styleExists = !!document.getElementById('shinkansen-asr-hide-css');
      const root = document.querySelector('.html5-video-player');
      const host = document.querySelector('shinkansen-yt-overlay');
      const shadow = host?.shadowRoot;
      const src = shadow?.querySelector('.src');
      const tgt = shadow?.querySelector('.tgt');
      return {
        styleExists,
        playerHiddenClass: root?.classList.contains('shinkansen-asr-active') === true,
        hostBilingualAttr: host?.getAttribute('bilingual') || null,
        srcHidden: src?.hidden ?? null,
        srcText: src?.textContent || '',
        tgtText: tgt?.textContent || '',
      };
    })()
  `);

  expect(result.styleExists, '#shinkansen-asr-hide-css 應已注入').toBe(true);
  expect(result.playerHiddenClass, '雙語 ASR 也應隱藏原生 CC,避免與 overlay 重疊').toBe(true);
  expect(result.hostBilingualAttr, 'overlay host 應有 bilingual="true" attribute').toBe('true');
  expect(result.srcHidden, '雙語模式的原文 row 應可見').toBe(false);
  expect(result.srcText, 'overlay 上排應顯示原文').toBe('hello world');
  expect(result.tgtText, 'overlay 下排應顯示譯文').toBe('你好世界');

  await page.close();
});
