# Pending Regression Tests

> **這是什麼**：待補的 regression test 清單。每筆代表「bug 已修但對應的
> regression spec 還沒寫」(對應 CLAUDE.md 硬規則 9 的路徑 B fallback)。
>
> **誰會讀**：
>   - **Cowork 端** 每次新對話會檢查本檔,若非空必須在第一句話提醒 Jimmy
>     (CLAUDE.md「開始新對話時的標準動作」第 4 步)
>   - **Claude Code 端** 跑完 `npm test` 全綠後若本檔非空,必須主動提醒
>   - **Jimmy** 看到提醒後可以決定要立刻清,還是先繼續手上的事
>
> **怎麼清**：見 `測試流程說明.md` 的「指令 G:清 pending regression queue」。
>
> **空 queue 的判斷**：本檔只剩本段 header + 「(目前沒有 pending 條目)」
> 那行 placeholder = 空。任何在「## 條目」section 之下的內容都算待清。

---

## 條目

### v0.74 — 2026-04-09 — 術語表擷取被 thinking token 截斷
- **症狀**：glossary extraction 回傳 `finishReason=MAX_TOKENS`，但 `candidatesTokenCount` 只有 300 多（maxOutputTokens 設 4096+），JSON 被截斷 parse 失敗，整個 glossary 變空
- **根因**：`gemini-2.5-flash` 是 thinking model，思考 token 計入 `maxOutputTokens` 額度，吃掉了大部分額度
- **修在**：`shinkansen/lib/gemini.js` 的 `extractGlossary()`，新增 `thinkingConfig: { thinkingBudget: 0 }`
- **為什麼還不能寫測試**：需要 mock Gemini API 回應來模擬 thinking model 截斷場景（返回 truncated JSON + `finishReason=MAX_TOKENS`），現有 regression fixture 架構是 DOM 注入測試，不適合直接套用。需要先建立 API mock 基礎設施
- **建議 spec 位置**：`test/regression/glossary-thinking-truncation.spec.js`
- **建議測試策略**：mock fetch 回傳 truncated JSON + MAX_TOKENS finishReason，驗證加上 thinkingConfig 後不再被截斷（或驗證 thinkingConfig 有被正確帶入 request body）

<!--
條目格式範例(實際加入時把上面那行 placeholder 刪掉):

### v0.60 — 2026-04-12 — 簡短描述 bug
- **症狀**:Jimmy 觀察到的現象 (例如「Substack 卡片標題被吃掉變空字串」)
- **來源 URL**:https://example.com/some-page (若為公開頁面)
- **修在**:shinkansen/content.js 的 XX 函式 / commit hash
- **為什麼還不能寫測試**:
    例:還沒抽出最小重現結構;原頁面太複雜、含三層 wrapper + 動態載入,
    需要再觀察是哪個 attribute 是真正觸發條件
- **建議 spec 位置**:test/regression/inject-substack-title.spec.js
- **建議 fixture 結構**(若已知):
    ```html
    <article>
      <h2 class="...">
        <span>...</span>
      </h2>
    </article>
    ```
-->
