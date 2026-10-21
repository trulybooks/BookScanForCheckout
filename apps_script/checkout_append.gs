/**
 * 結帳掃描器的寫入端點。
 *
 * 部署方式（比照官網 apps_script/tag_submit.gs 的獨立專案做法）：
 * 1. 到 https://script.google.com → 新增專案（不要從 Sheet 的「擴充功能」進入）。
 *    獨立專案可以避開「一個專案只能有一個 doPost」跟試算表既有腳本打架的問題。
 * 2. 把這個檔案整個貼進去，取代預設的 Code.gs。
 * 3. 先按執行鈕跑一次 testAppend()，確認寫得進去：
 *    - 第一次會跳授權，選自己的 Google 帳號。
 *    - 出現「Google 尚未驗證這個應用程式」時，點「進階」→「前往…（不安全）」。
 *      自己寫、沒送審的腳本都會這樣，屬正常。
 *    - 跑完去試算表看有沒有多一列測試資料，確認後自己刪掉。
 * 4. 部署 → 新增部署作業 → 網頁應用程式：
 *    - 執行身分：我
 *    - 誰可以存取：任何人
 * 5. 把拿到的 .../exec 網址填進掃描器的「設定」。
 * 6. ⚠️ 之後改了這個檔案，要「管理部署作業」→ 編輯 → 版本選「新版本」→ 部署，
 *    網址才會套用新程式碼。改完不會自動生效。
 */

var SPREADSHEET_ID = '1jr4zPFdsXxAW0a4JbG4MIbx6yerC6ABesVGu_d1TVQw';
var SHEET_GID = 679387958;

// 表頭在第 2 行，資料從第 3 行開始。
var HEADER_ROW = 2;
var FIRST_DATA_ROW = 3;

// 1-indexed 欄位位置。只寫這四欄，其餘維持原樣。
var COL_NAME = 3;    // C 姓名
var COL_ISBN = 6;    // F ISBN
var COL_ITEM = 7;    // G 商品
var COL_PRICE = 9;   // I 單價
//
// ⚠️ 不要寫 J 欄（金額）。那是公式（數量 × 單價），填了 I 欄它就會自己算出來；
// 直接寫值會把公式蓋掉，之後那一列就不會再跟著變動。

var MAX_ITEMS = 50;


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

function appendOrder_(name, items) {
  if (!items || !items.length) throw new Error('沒有要寫入的書');
  if (items.length > MAX_ITEMS) throw new Error('一次最多 ' + MAX_ITEMS + ' 本');

  var sheet = getSheet_();
  var rows = findWritableRows_(sheet, items.length);

  for (var i = 0; i < items.length; i++) {
    var row = rows[i];
    var item = items[i];

    sheet.getRange(row, COL_NAME).setValue(name);
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
    var data = JSON.parse(e.postData.contents);
    var name = String(data.name || '').trim();
    if (!name) throw new Error('缺少購買人姓名');

    var rows = appendOrder_(name, data.items);
    return json_({ status: 'ok', rows: rows, count: rows.length });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

/**
 * 讓前端可以在送單前確認網址有效、權限正常。
 * 純讀取，不寫入任何東西。
 */
function doGet() {
  try {
    var sheet = getSheet_();
    var rows = findWritableRows_(sheet, 1);
    return json_({ status: 'ok', sheet: sheet.getName(), nextRow: rows[0] });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

/** 部署前先在編輯器裡跑這個，確認權限與寫入位置都對。 */
function testAppend() {
  var rows = appendOrder_('測試資料請刪除', [
    { isbn: '9789573330806', title: '13 67', price: 350 }
  ]);
  Logger.log('寫入第 ' + rows.join('、') + ' 列，確認後請自行刪除');
}
