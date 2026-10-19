// 一時利用スクリプト：PMDAの回収情報一覧ページ（HTML）の「備考」欄に「回収終了」と
// 記載されている回収のうち、現行のGTIN版/詳細版CSVに既に存在しないものを、
// data/history.json の removedArchive へ一括登録する（2026-10-19 時点の状態を遡及反映）。
//
// 実行方法: node _scripts_onetime/backfill_removed.js
// このスクリプトは一度限りの利用を想定しており、通常のビルド（build.js）には組み込まない。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HISTORY_PATH = path.join(ROOT, "data", "history.json");
const NODATA = "NODATA";

function toHalfWidth(str) {
  return str.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}
function sanitizeDigits(str) { return toHalfWidth(str || "").replace(/[^0-9]/g, ""); }
function sanitizeAlnum(str) { return toHalfWidth(str || "").replace(/[^0-9A-Za-z]/g, ""); }
function cleanText(str) { return (str || "").replace(/[\s　]+/g, " ").trim(); }
function convertSlashDateToYyyymmdd(raw) {
  if (!raw) return null;
  const m = toHalfWidth(raw).match(/([0-9]{4})\/([0-9]{1,2})\/([0-9]{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}${mo.padStart(2, "0")}${d.padStart(2, "0")}`;
}

function classLabelFor(recallNo) {
  const prefix = recallNo.split("-")[0];
  return { "1": "クラスI", "2": "クラスII", "3": "クラスIII" }[prefix] || "不明";
}

async function main() {
  const details = JSON.parse(fs.readFileSync(path.join(__dirname, "done_details.json"), "utf8"));
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));

  let added = 0;
  const notes = [];

  for (const d of details) {
    if (history.removedArchive[d.recallNo]) {
      console.log(`スキップ（既に登録済み）: ${d.recallNo}`);
      continue;
    }

    const name = cleanText([d.generalName, d.brandName].filter(Boolean).join(" ")) || NODATA;
    const postDateYmd = convertSlashDateToYyyymmdd(d.postDate) || NODATA;
    const dateYmd = d.dateYmd || NODATA;

    let rows;
    if (d.rows.length > 0) {
      rows = d.rows.map((r) => [d.recallNo, name, postDateYmd, dateYmd, r.gtin, r.lot, r.serial]);
    } else {
      rows = [[d.recallNo, name, postDateYmd, dateYmd, NODATA, NODATA, NODATA]];
    }

    history.removedArchive[d.recallNo] = {
      recallNo: d.recallNo,
      class: classLabelFor(d.recallNo),
      generalName: d.generalName,
      brandName: d.brandName,
      rows,
      removedAt: "2026-10-19T00:00:00.000Z",
      detectedVia: "remarks_backfill",
      note: d.truncated
        ? "PMDA個別ページで「該当GTINが多数のため、一部のみ表示しています」との表示あり。GTIN情報が全件でない可能性がある。"
        : undefined,
    };
    added++;
    if (d.truncated) notes.push(d.recallNo);
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 1), "utf8");
  console.log(`\n完了: ${added}件を removedArchive へ追加しました。`);
  if (notes.length > 0) console.log("※一部のみ表示の警告があった回収（データ不完全の可能性）:", notes.join(", "));
}

main();
