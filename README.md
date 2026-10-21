# 結帳掃描器 BookScanForCheckout

真的書店結帳櫃台用的開單工具。

填入購買人姓名、發票載具與這一單的書（ISBN 或書名擇一即可），系統會從書目查出定價與新舊書，
算出應付總額與該送的購物金，確認後把每一本寫回結帳試算表。

## 功能

- 📝 **一單多本** — 按「＋ 加一本書」可以一直加，每本只要有 ISBN 或書名其中之一
- 📷 **掃 ISBN 帶入表單** — 每一列旁邊的相機鈕，掃完直接填進該列
- 🧾 **掃發票載具** — 載具是 Code 39，與 ISBN 分開辨識
- 🔍 **書名模糊比對** — 只打部分書名也查得到；多本相符時在確認畫面勾選
- 💰 **自動算帳** — 應付總額，以及舊書小計對應的購物金（滿 300 送 100、滿 600 送 300，600 為上限）
- 📤 **寫回試算表** — 一本一行，填姓名、ISBN、商品、單價

## 技術

- **TypeScript** — 用 esbuild 打包成單一 bundle
- **zxing-wasm** — zxing-cpp 編譯成 WebAssembly 的條碼解碼器。比 JS 解碼器可靠得多，
  在 iOS 與 Android 上表現一致，也不必依賴 iOS 那個時好時壞的原生 `BarcodeDetector`
- **無框架、無狀態** — 沒有 localStorage、沒有後端、沒有追蹤

## 專案結構

```
BookScanForCustomer/
├── src/
│   ├── app.ts          # 啟動相機、掃到條碼後開啟單書頁
│   ├── scanner.ts      # 相機串流與條碼解碼（這支是核心）
│   └── utils.ts        # toast 與 modal
├── dist/               # 打包輸出（含 zxing_reader.wasm，由 build 複製過去）
├── img/                # 官網 logo 與 favicon
├── index.html
├── styles.css          # 沿用「真的書店」官網設計系統
└── package.json
```

## 開發

```bash
npm install
npm run build   # 打包到 dist/bundle.js，並複製 zxing_reader.wasm
npm run watch   # 同上，監看變更
npm run serve   # 在 :8080 起一個靜態伺服器
```

`npx http-server` 若因 npm cache 權限問題裝不起來，用 `python3 -m http.server 8080` 也可以。

開啟 <http://localhost:8080>。

沒有測試框架，也沒有 linter。

## 部署

推到 `main` 就會由 GitHub Actions 部署到 GitHub Pages（`.github/workflows/deploy.yml`）。

要自己架的話，把 `index.html`、`styles.css`、`img/`、`dist/` 丟到任何靜態主機即可。

## 單書頁的網址規則

```
https://trulybookstore.in-common.tw/books/book-<條碼>/
```

條碼就是唯一的 key。系列書的每一冊都有自己的頁面，所以不需要另外處理系列。條碼也不一定
是 ISBN — 書單裡有 `4711488873708` 這類 EAN-13，掃描器一律接受 13 位數字。

**這個 app 無法事先知道某本書有沒有頁面。** 官網放在 Netlify 上、沒有送 CORS header，
跨網域的 `fetch` 讀不到狀態碼，`no-cors` 拿到的 opaque response 也分不出 200 和 404。
所以做法是不檢查、直接開，由官網自己的 404 頁面（`truly-bookstore/404.html`）說明
「這本書還不在書單裡」並提供回書單的連結。

## 授權

MIT
