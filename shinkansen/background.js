// background.js — Shinkansen Service Worker
// 職責：接收翻譯請求、呼叫 Gemini API、處理快取、處理快捷鍵、統一除錯 Log。

import { translateBatch } from './lib/gemini.js';
import { getSettings } from './lib/storage.js';
import { debugLog } from './lib/logger.js';
import * as cache from './lib/cache.js';
import { RateLimiter } from './lib/rate-limiter.js';
import { getLimitsForSettings } from './lib/tier-limits.js';

console.log('[Shinkansen] background service worker started');

// ─── Rate Limiter(全域 singleton) ──────────────────────
// 三維度 sliding window,同時約束 RPM / TPM / RPD。
// 設定變更時會透過 storage.onChanged 重新套用上限。
let limiter = null;

async function initLimiter() {
  const settings = await getSettings();
  const limits = getLimitsForSettings(settings);
  limiter = new RateLimiter(limits);
  debugLog('info', 'rate limiter initialized', {
    tier: settings.tier,
    model: settings.geminiConfig.model,
    rpm: limits.rpm,
    tpm: limits.tpm,
    rpd: limits.rpd,
    safetyMargin: limits.safetyMargin,
  });
}
initLimiter();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  // 只要設定類相關欄位變動就重新套用上限
  const relevant = ['tier', 'geminiConfig', 'safetyMargin', 'rpmOverride', 'tpmOverride', 'rpdOverride'];
  if (relevant.some(k => k in changes)) {
    getSettings().then(settings => {
      const limits = getLimitsForSettings(settings);
      if (limiter) {
        limiter.updateLimits(limits);
        debugLog('info', 'rate limiter limits updated', limits);
      } else {
        limiter = new RateLimiter(limits);
      }
    });
  }
});

/** 簡易 input token 估算:英文約 4 字元/token、中文約 1.5 字元/token,取中間值 3.5 偏保守。 */
function estimateInputTokens(texts) {
  let total = 0;
  for (const t of texts) total += t?.length || 0;
  return Math.ceil(total / 3.5);
}

// ─── 啟動時：版本檢查，版本變更則清空快取 ───────────────────
(async () => {
  const currentVersion = chrome.runtime.getManifest().version;
  const result = await cache.checkVersionAndClear(currentVersion);
  if (result.cleared) {
    console.log(
      `[Shinkansen] cache cleared (v${result.oldVersion ?? '?'} → v${currentVersion}), removed ${result.removed} entries`
    );
  } else {
    console.log(`[Shinkansen] cache up-to-date (v${currentVersion})`);
  }
})();

// ─── 使用量累計（chrome.storage.local) ────────────────────
// 結構：
//   usageStats: {
//     totalInputTokens: number,
//     totalOutputTokens: number,
//     totalCostUSD: number,
//     since: ISO timestamp  // 最後一次重置時間
//   }
const USAGE_KEY = 'usageStats';

async function getUsageStats() {
  const { [USAGE_KEY]: s } = await chrome.storage.local.get(USAGE_KEY);
  return s || {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    since: new Date().toISOString(),
  };
}

async function addUsage(inputTokens, outputTokens, costUSD) {
  const s = await getUsageStats();
  s.totalInputTokens += inputTokens;
  s.totalOutputTokens += outputTokens;
  s.totalCostUSD += costUSD;
  await chrome.storage.local.set({ [USAGE_KEY]: s });
  return s;
}

async function resetUsageStats() {
  const fresh = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    since: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [USAGE_KEY]: fresh });
  return fresh;
}

function computeCostUSD(inputTokens, outputTokens, pricing) {
  const inRate = Number(pricing?.inputPerMTok) || 0;
  const outRate = Number(pricing?.outputPerMTok) || 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/**
 * v0.48: 計算套用 Gemini implicit context cache 折扣後的實付費用。
 * Gemini 對 cache 命中部分只收原價 25%（省 75%），未命中部分與 output 全價。
 * 公式：billed = ((inputTokens - cachedTokens) + cachedTokens × 0.25) × inRate / 1M
 *             + outputTokens × outRate / 1M
 */
function computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing) {
  const inRate = Number(pricing?.inputPerMTok) || 0;
  const outRate = Number(pricing?.outputPerMTok) || 0;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  const effectiveInput = uncached + cachedTokens * 0.25;
  return (effectiveInput / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

// ─── Extension icon badge(已翻譯紅點提示） ─────────────────
// 使用浮世繪圖示上的旭日紅 #cf3a2c，視覺上延續「太陽」的意象。
const BADGE_COLOR = '#cf3a2c';
const BADGE_TEXT = '●';

async function setTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    // 某些 Chrome 版本支援白色 badge 文字，舊版本會忽略此呼叫
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
    }
    await chrome.action.setBadgeText({ text: BADGE_TEXT, tabId });
  } catch (err) {
    debugLog('warn', 'setBadge failed', { error: err.message });
  }
}

async function clearTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeText({ text: '', tabId });
  } catch (err) {
    debugLog('warn', 'clearBadge failed', { error: err.message });
  }
}

// 分頁重新導航時自動清掉 badge(SPA 同站導航除外，需依賴 content.js 重新通知）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTranslatedBadge(tabId);
  }
});

// ─── 訊息路由 ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TRANSLATE_BATCH') {
    handleTranslate(message.payload, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => {
        debugLog('error', 'translate failed', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }
  if (message?.type === 'CLEAR_CACHE') {
    cache.clearAll()
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'CACHE_STATS') {
    cache.stats()
      .then((s) => sendResponse({ ok: true, ...s }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'USAGE_STATS') {
    getUsageStats()
      .then((s) => sendResponse({ ok: true, ...s }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'RESET_USAGE') {
    resetUsageStats()
      .then((s) => sendResponse({ ok: true, ...s }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'SET_BADGE_TRANSLATED') {
    setTranslatedBadge(sender?.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'CLEAR_BADGE') {
    clearTranslatedBadge(sender?.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function handleTranslate(payload, sender) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error('尚未設定 Gemini API Key，請至設定頁填入。');
  }
  const texts = payload.texts;

  // 1. 先撈快取
  const cached = await cache.getBatch(texts);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });

  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache lookup', {
    total: texts.length,
    hits: cacheHits,
    misses: missingTexts.length,
  });

  // 2. 缺的部分送 Gemini(透過 rate limiter 節流)
  let fresh = [];
  let batchUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let batchCostUSD = 0;
  // v0.48: hoist 到 if 外面，讓後面組 return usage 能讀到
  let billedInputTokens = 0;
  let billedCostUSD = 0;
  if (missingTexts.length) {
    // 先過 rate limiter 取得一個 slot(會自動等待到 RPM/TPM/RPD 都有餘裕)
    if (!limiter) await initLimiter();
    const estTokens = estimateInputTokens(missingTexts);
    await limiter.acquire(estTokens, /* priority */ 1);

    const t0 = Date.now();
    const res = await translateBatch(missingTexts, settings);
    fresh = res.translations;
    batchUsage = res.usage;
    batchCostUSD = computeCostUSD(batchUsage.inputTokens, batchUsage.outputTokens, settings.pricing);
    debugLog('info', 'gemini batch done', {
      count: missingTexts.length,
      ms: Date.now() - t0,
      tabId: sender?.tab?.id,
      usage: batchUsage,
      costUSD: batchCostUSD,
    });
    // 3. 寫回快取
    await cache.setBatch(missingTexts, fresh);
    // 3.5 累計到全域使用量統計
    // v0.48: 改為累計「實付」值（套用 implicit cache 折扣後的等效 input tokens
    // 與實付費用），讓 popup 累計顯示的 token / 費用等於 Gemini 帳單實際扣款。
    // billedInputTokens = inputTokens - cachedTokens × 0.75
    //   （未命中的 token 全價 + 命中的 token 25% 折扣 → 等效 token 數）
    billedInputTokens = Math.max(
      0,
      Math.round(batchUsage.inputTokens - (batchUsage.cachedTokens || 0) * 0.75),
    );
    billedCostUSD = computeBilledCostUSD(
      batchUsage.inputTokens,
      batchUsage.cachedTokens || 0,
      batchUsage.outputTokens,
      settings.pricing,
    );
    await addUsage(billedInputTokens, batchUsage.outputTokens, billedCostUSD);
  }

  // 4. 合併結果（快取 + 新翻譯）按原順序回傳
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => {
    result[idx] = fresh[k];
  });
  return {
    result,
    usage: {
      // 原始（未套 implicit cache 折扣）數字，保留給 content 端算 hit% / saved%
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      // Gemini implicit context cache 命中的輸入 token 數（v0.46 新增）。
      // 注意這跟下面的 `cacheHits`(本地 tc_<sha1> 翻譯快取命中段數) 是兩回事。
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      // v0.48: 套 implicit cache 折扣後的「實付」數字。toast 與 popup 都顯示這組
      billedInputTokens,
      billedCostUSD,
      cacheHits,
    },
  };
}

// ─── 快捷鍵 ────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-translate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // 在 chrome://、Chrome Web Store、新分頁等頁面按快捷鍵時,該 tab 沒有
    // content script listening,sendMessage 會 reject:
    //   "Could not establish connection. Receiving end does not exist."
    // 這是預期情境（使用者可能不小心按到快捷鍵),靜默吞掉即可,不讓它冒成
    // uncaught promise rejection 污染 background.js 的錯誤面板。
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' }).catch(() => {});
  }
});

// ─── 安裝/更新事件 ─────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.log(`[Shinkansen] installed (${reason})`);
  // 安裝/更新時也檢查一次版本（雙重保險，SW 啟動時已經跑過一次）
  const currentVersion = chrome.runtime.getManifest().version;
  await cache.checkVersionAndClear(currentVersion);
});
