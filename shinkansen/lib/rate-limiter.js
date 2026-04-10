// rate-limiter.js — 三維度 sliding window rate limiter
//
// 對應 Gemini API 的三維度限制：
//   RPM: 每分鐘請求數       (sliding 60 秒視窗)
//   TPM: 每分鐘 input tokens(sliding 60 秒視窗)
//   RPD: 每日請求數         (太平洋時間午夜重置,persist 到 chrome.storage.local)
//
// 使用方式：
//   const limiter = new RateLimiter({ rpm, tpm, rpd, safetyMargin });
//   await limiter.acquire(estInputTokens);
//   // ... 做實際的 API 請求
//
// v0.89 重構：移除 priority queue + dispatchLoop 架構。
// 原因：dispatchLoop 透過 Promise.resolve().then() 或 setTimeout(0) 排程，
// 在 Chrome Service Worker 環境中會被吞掉不執行（推測 SW idle 排程問題），
// 導致所有翻譯請求卡在 acquire 永遠不 resolve。
// 新架構：每個 acquire 自己 inline 等待 + 記錄用量，不依賴外部 dispatcher。
// 代價：失去 p0/p1 priority 排序（術語表不再優先於翻譯請求），
// 但實際影響很小——術語表請求在翻譯開始前就發出，不會跟翻譯請求搶 slot。

import { debugLog } from './logger.js';

const WINDOW_MS = 60_000;
const RPD_KEY_PREFIX = 'rateLimit_rpd_';

/** 取得太平洋時間的 YYYYMMDD 字串,用於 RPD key。 */
function getPacificDateKey(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now).replace(/-/g, ''); // YYYYMMDD
}

export class RateLimiter {
  constructor({ rpm, tpm, rpd, safetyMargin = 0.1 }) {
    this.updateLimits({ rpm, tpm, rpd, safetyMargin });

    // Sliding window 緩衝區
    this.requests = [];              // 時間戳陣列（ms）
    this.tokens = [];                // { t: 時間戳, n: token 數 }

    // RPD 狀態（從 storage 讀入）
    this.rpdDateKey = null;          // 對應哪一天
    this.rpdCount = 0;
    this.rpdLoaded = false;
    this.rpdLoadingPromise = null;
  }

  updateLimits({ rpm, tpm, rpd, safetyMargin = 0.1 }) {
    this.safetyMargin = Math.max(0, Math.min(0.5, safetyMargin));
    const factor = 1 - this.safetyMargin;
    this.rpmCap = Math.max(1, Math.floor(rpm * factor));
    this.tpmCap = Math.max(1, Math.floor(tpm * factor));
    this.rpdCap = Math.max(1, Math.floor(rpd * factor));
  }

  async loadRpdIfNeeded() {
    if (this.rpdLoaded) {
      // 跨日檢查
      const nowKey = getPacificDateKey();
      if (nowKey !== this.rpdDateKey) {
        this.rpdDateKey = nowKey;
        this.rpdCount = 0;
        await this.persistRpd();
      }
      return;
    }
    if (this.rpdLoadingPromise) {
      await this.rpdLoadingPromise;
      return;
    }
    this.rpdLoadingPromise = (async () => {
      const nowKey = getPacificDateKey();
      const storageKey = RPD_KEY_PREFIX + nowKey;
      const result = await chrome.storage.local.get(storageKey);
      this.rpdDateKey = nowKey;
      this.rpdCount = Number(result[storageKey]) || 0;
      this.rpdLoaded = true;

      // 順手清掉前幾天的 RPD key（garbage collection)
      const all = await chrome.storage.local.get(null);
      const staleKeys = Object.keys(all).filter(
        k => k.startsWith(RPD_KEY_PREFIX) && k !== storageKey
      );
      if (staleKeys.length) {
        await chrome.storage.local.remove(staleKeys);
      }
    })();
    await this.rpdLoadingPromise;
    this.rpdLoadingPromise = null;
  }

  async persistRpd() {
    if (!this.rpdDateKey) return;
    const storageKey = RPD_KEY_PREFIX + this.rpdDateKey;
    await chrome.storage.local.set({ [storageKey]: this.rpdCount });
  }

  /** 清除 60 秒之前的舊時間戳。 */
  pruneWindow(now) {
    const cutoff = now - WINDOW_MS;
    while (this.requests.length && this.requests[0] < cutoff) {
      this.requests.shift();
    }
    while (this.tokens.length && this.tokens[0].t < cutoff) {
      this.tokens.shift();
    }
  }

  /** 取得目前 60 秒視窗內累積的 token 數。 */
  currentTokenSum() {
    return this.tokens.reduce((s, e) => s + e.n, 0);
  }

  /**
   * 等待並取得一個 slot。若任何維度超限則 sleep 到最近的釋放時間點再重試。
   * @param {number} estTokens 本次請求估計 input token 數
   * @param {number} priority 保留參數，目前不使用（向下相容）
   * @returns {Promise<void>}
   */
  async acquire(estTokens, priority = 1) {
    await this.loadRpdIfNeeded();

    // Inline 等待：自己 loop 直到 RPM/TPM 有 slot
    // 注意：RPD 不在此強制等待——RPD 只是軟性預算警告，
    // 真正的每日限額由 Gemini API 自己回傳 429 錯誤。
    let attempts = 0;
    while (true) {
      const waitMs = this.computeWaitMs(estTokens);
      if (waitMs <= 0) break;

      attempts++;
      if (attempts === 1) {
        debugLog('info', 'rate-limit', 'acquire waiting', {
          waitMs, estTokens,
          rpmUsed: this.requests.length, rpmCap: this.rpmCap,
          rpdUsed: this.rpdCount, rpdCap: this.rpdCap,
        });
      }
      await this.sleep(waitMs);
    }

    // 記錄用量
    const now = Date.now();
    this.requests.push(now);
    this.tokens.push({ t: now, n: estTokens });
    this.rpdCount += 1;
    // Persist RPD 寫入不等待完成（小量資料,容忍短暫不一致）
    this.persistRpd().catch(err =>
      debugLog('warn', 'rate-limit', 'rpd persist failed', { error: err.message })
    );

    // RPD 超過預算上限 → 回傳警告旗標（不阻擋翻譯）
    const rpdExceeded = this.rpdCount > this.rpdCap;
    if (rpdExceeded) {
      debugLog('warn', 'rate-limit', 'RPD budget exceeded', {
        rpdUsed: this.rpdCount, rpdCap: this.rpdCap,
      });
    }
    return { rpdExceeded };
  }

  /**
   * 判斷目前若要放 estTokens 這一次,需要等幾毫秒。
   * 回傳 0 代表可以立即放行。
   */
  computeWaitMs(estTokens) {
    const now = Date.now();
    this.pruneWindow(now);

    // RPD 不在此強制等待——RPD 只是軟性預算警告，見 acquire() 說明。

    let wait = 0;

    // RPM 檢查
    if (this.requests.length + 1 > this.rpmCap) {
      const earliest = this.requests[this.requests.length - this.rpmCap];
      const releaseAt = earliest + WINDOW_MS;
      wait = Math.max(wait, releaseAt - now + 5);
    }

    // TPM 檢查
    const currentTok = this.currentTokenSum();
    if (currentTok + estTokens > this.tpmCap) {
      const needToRelease = currentTok + estTokens - this.tpmCap;
      let released = 0;
      for (const e of this.tokens) {
        released += e.n;
        if (released >= needToRelease) {
          const releaseAt = e.t + WINDOW_MS;
          wait = Math.max(wait, releaseAt - now + 5);
          break;
        }
      }
      if (released < needToRelease) {
        wait = Math.max(wait, WINDOW_MS + 5);
      }
    }

    return wait;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 取得目前狀態快照,供 popup / debug 顯示。 */
  snapshot() {
    const now = Date.now();
    this.pruneWindow(now);
    return {
      rpmUsed: this.requests.length,
      rpmCap: this.rpmCap,
      tpmUsed: this.currentTokenSum(),
      tpmCap: this.tpmCap,
      rpdUsed: this.rpdCount,
      rpdCap: this.rpdCap,
      rpdDateKey: this.rpdDateKey,
      safetyMargin: this.safetyMargin,
    };
  }
}
