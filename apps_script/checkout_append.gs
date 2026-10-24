/**
 * 結帳掃描器的寫入端點。
 *
 * ⚠️ 這個檔案在公開的 GitHub repo 裡。**不要把試算表 ID、密鑰或部署網址填進來
 * 之後又提交上去** —— 那等於把它們公開。下面兩個常數請只在 Apps Script 編輯器裡
 * 填寫（那個專案在你自己的 Google 帳號底下，不會公開）。
 *
 * 部署方式（比照官網 apps_script/tag_submit.gs 的獨立專案做法）：
 * 1. 到 https://script.google.com → 新增專案（不要從 Sheet 的「擴充功能」進入）。
 *    獨立專案可以避開「一個專案只能有一個 doPost」跟試算表既有腳本打架的問題。
 * 2. 把這個檔案整個貼進去，取代預設的 Code.gs。
 * 3. 填好 SPREADSHEET_ID 與 SHARED_SECRET（見下方說明）。
 * 4. 先按執行鈕跑一次 testConnection()，確認找得到分頁、也看得到會寫在第幾列。
 *    這個測試是唯讀的，不會動到任何資料。
 *    - 第一次會跳授權，選自己的 Google 帳號。
 *    - 出現「Google 尚未驗證這個應用程式」時，點「進階」→「前往…（不安全）」。
 *      自己寫、沒送審的腳本都會這樣，屬正常。
 * 5. 部署 → 新增部署作業 → 網頁應用程式：
 *    - 執行身分：我
 *    - 誰可以存取：任何人
 * 6. 把拿到的 .../exec 網址與 SHARED_SECRET 填進掃描器右上角的 ⚙️ 設定。
 * 7. ⚠️ 之後改了這個檔案，要「管理部署作業」→ 編輯 → 版本選「新版本」→ 部署，
 *    網址才會套用新程式碼。改完不會自動生效。
 *
 * 資安限制（請知道這個端點的實際保護強度）：
 * 「誰可以存取：任何人」代表這是無認證端點，任何人拿到網址都能呼叫。SHARED_SECRET
 * 讓「只知道網址」不足以寫入，但它必須存在店員的瀏覽器裡，所以能打開那台裝置的人
 * 就拿得到。這個架構（公開靜態網頁 + Apps Script）做不到更強的認證。
 * 實際的損害上限是「被灌入垃圾列」：腳本只寫 ISBN 與商品都空白的列，不覆蓋既有
 * 資料、不刪除、也不回傳試算表內容。
 */

// ⚠️ 只在 Apps Script 編輯器裡填，不要提交回 repo。
var SPREADSHEET_ID = '在這裡填入結帳試算表的 ID';

// ⚠️ 自己想一串長一點的隨機字串，並填進掃描器的設定頁。同樣不要提交回 repo。
var SHARED_SECRET = '在這裡填入一組長隨機字串';

var SHEET_GID = 679387958;

// 表頭在第 2 行，資料從第 3 行開始。
var HEADER_ROW = 2;
var FIRST_DATA_ROW = 3;

// 1-indexed 欄位位置。只寫這五欄，其餘維持原樣。
var COL_NAME = 3;     // C 姓名
var COL_CARRIER = 4;  // D 會員編號/發票（發票載具編號）
var COL_ISBN = 6;     // F ISBN
var COL_ITEM = 7;    // G 商品
var COL_PRICE = 9;   // I 單價
//
// ⚠️ 不要寫 J 欄（金額）。那是公式（數量 × 單價），填了 I 欄它就會自己算出來；
// 直接寫值會把公式蓋掉，之後那一列就不會再跟著變動。

var MAX_ITEMS = 50;


/** 沒設定好就直接拒絕，而不是帶著預設值跑出一個沒有保護的端點。 */
function assertConfigured_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID.indexOf('在這裡填入') === 0) {
    throw new Error('尚未設定 SPREADSHEET_ID');
  }
  if (!SHARED_SECRET || SHARED_SECRET.indexOf('在這裡填入') === 0) {
    throw new Error('尚未設定 SHARED_SECRET');
  }
}

function checkSecret_(provided) {
  if (String(provided || '') !== SHARED_SECRET) {
    throw new Error('密鑰不符');
  }
}

function getSheet_() {
  var sheets = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SHEET_GID) return sheets[i];
  }
  throw new Error('找不到 gid 為 ' + SHEET_GID + ' 的分頁');
}

/**
 * 找出可以寫入的列號。
 *
 * 不能用 getLastRow() + 1：這張表第 4 行以後已經預填了訂單編號、購買日期、數量、
 * 付款方式等公式與值，getLastRow() 會指到一百多列之後，把前面整片空白跳過去。
 * 判斷標準是「ISBN 與商品兩欄都空白」——跟店主平常看這張表的方式一致。
 */
function findWritableRows_(sheet, count) {
  var lastRow = Math.max(sheet.getLastRow(), HEADER_ROW);
  var rows = [];

  if (lastRow >= FIRST_DATA_ROW) {
    var height = lastRow - FIRST_DATA_ROW + 1;
    var isbns = sheet.getRange(FIRST_DATA_ROW, COL_ISBN, height, 1).getValues();
    var items = sheet.getRange(FIRST_DATA_ROW, COL_ITEM, height, 1).getValues();

    for (var i = 0; i < height && rows.length < count; i++) {
      var hasIsbn = String(isbns[i][0]).trim() !== '';
      var hasItem = String(items[i][0]).trim() !== '';
      if (!hasIsbn && !hasItem) rows.push(FIRST_DATA_ROW + i);
    }
  }

  // 預留的空白列用完了就接在表格最後面，不要因此拒絕這一單
  var appendAt = Math.max(lastRow + 1, FIRST_DATA_ROW);
  while (rows.length < count) {
    rows.push(appendAt++);
  }

  return rows;
}

function appendOrder_(name, carrier, items) {
  if (!items || !items.length) throw new Error('沒有要寫入的書');
  if (items.length > MAX_ITEMS) throw new Error('一次最多 ' + MAX_ITEMS + ' 本');

  var sheet = getSheet_();
  var rows = findWritableRows_(sheet, items.length);

  for (var i = 0; i < items.length; i++) {
    var row = rows[i];
    var item = items[i];

    sheet.getRange(row, COL_NAME).setValue(name);

    // 載具是整單共用的，跟姓名一樣每一列都填，店主看任何一列都知道這單開給誰。
    // 設成純文字：載具以 / 開頭，Google 會把它當成公式而噴 #ERROR!
    if (carrier) {
      sheet.getRange(row, COL_CARRIER).setNumberFormat('@').setValue(String(carrier));
    }

    // ISBN 設成純文字，否則 Google 會把 13 位數字轉成 9.78986E+12
    sheet.getRange(row, COL_ISBN).setNumberFormat('@').setValue(String(item.isbn || ''));
    sheet.getRange(row, COL_ITEM).setValue(String(item.title || ''));

    var price = Number(item.price);
    if (isFinite(price) && price > 0) {
      sheet.getRange(row, COL_PRICE).setValue(price);
    }
  }

  SpreadsheetApp.flush();
  return rows;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    assertConfigured_();

    var data = JSON.parse(e.postData.contents);
    checkSecret_(data.secret);

    var name = String(data.name || '').trim();
    if (!name) throw new Error('缺少購買人姓名');

    var rows = appendOrder_(name, String(data.carrier || '').trim(), data.items);
    return json_({ status: 'ok', rows: rows, count: rows.length });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

/**
 * 讓前端在送單前確認網址、密鑰與權限都正常。
 * 純讀取，不寫入任何東西，也不回傳試算表的內容。
 */
function doGet(e) {
  try {
    assertConfigured_();
    checkSecret_(e && e.parameter && e.parameter.secret);

    var sheet = getSheet_();
    var rows = findWritableRows_(sheet, 1);
    return json_({ status: 'ok', sheet: sheet.getName(), nextRow: rows[0] });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

/**
 * 部署前在編輯器裡跑這個，確認設定與權限。
 *
 * 這是唯讀的：只回報找不找得到分頁、下一單會寫在第幾列。
 * 以前這裡是 testAppend()，會真的寫一列測試資料進正式表再要人自己刪掉——
 * 拿正式的銷售紀錄當測試場地不是好主意，已經移除。
 * 真的要驗寫入的話，複製一份試算表、把 SPREADSHEET_ID 暫時指過去測。
 */
function testConnection() {
  assertConfigured_();
  var sheet = getSheet_();
  var rows = findWritableRows_(sheet, 3);
  Logger.log('分頁：' + sheet.getName());
  Logger.log('接下來三本會寫在第 ' + rows.join('、') + ' 列');
  Logger.log('（唯讀測試，沒有寫入任何資料）');
}
