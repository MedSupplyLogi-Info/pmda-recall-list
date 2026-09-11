// PMDA 医療機器回収情報（クラスI/II/III）統合CSV生成スクリプト
//
// 実行方法: node build.js
// PMDAサイトから最新のCSVを取得し、data/recall_list_merged.csv を再生成する。
// PMDA側のURLが年度更新される場合は下記 CLASSES の baseUrl を書き換えること。

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "data");
const OUT_CSV = path.join(OUT_DIR, "recall_list_merged.csv");
const OUT_LOG = path.join(OUT_DIR, "build-log.json");
const OUT_META_JS = path.join(OUT_DIR, "meta.js");
const NODATA = "NODATA"; // 空欄セルであることを示す固定コード

const CLASSES = [
  {
    label: "クラスI",
    gtinZipUrl: "https://www.info.pmda.go.jp/kaisyuu/rcidx26-1k2_all.zip",
    detailZipUrl: "https://www.info.pmda.go.jp/kaisyuu/rcidx26-1k_all.zip",
  },
  {
    label: "クラスII",
    gtinZipUrl: "https://www.info.pmda.go.jp/kaisyuu/rcidx26-2k2_all.zip",
    detailZipUrl: "https://www.info.pmda.go.jp/kaisyuu/rcidx26-2k_all.zip",
  },
  {
    label: "クラスIII",
    gtinZipUrl: "https://www.info.pmda.go.jp/kaisyuu/rcidx26-3k2_all.zip",
    detailZipUrl: "https://www.info.pmda.go.jp/kaisyuu/rcidx26-3k_all.zip",
  },
];

// ---------- HTTP ----------

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTPエラー ${res.status}: ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- 最小限のZIP展開（単一ファイル・deflate想定） ----------

function unzipFirstFile(buf) {
  // End Of Central Directory (EOCD) を末尾から探す
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("ZIP形式が不正です（EOCDが見つかりません）");

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const CD_SIG = 0x02014b50;
  if (buf.readUInt32LE(cdOffset) !== CD_SIG) throw new Error("ZIP形式が不正です（中央ディレクトリが見つかりません）");

  const compMethod = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
  const fileName = buf.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLen);

  const LFH_SIG = 0x04034b50;
  if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIG) throw new Error("ZIP形式が不正です（ローカルヘッダが見つかりません）");
  const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
  const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  const compData = buf.subarray(dataStart, dataStart + compSize);

  let content;
  if (compMethod === 0) content = compData; // 無圧縮
  else if (compMethod === 8) content = zlib.inflateRawSync(compData); // deflate
  else throw new Error(`未対応の圧縮方式です: ${compMethod}`);

  return { fileName, content };
}

// ---------- CSVパース（引用符内改行対応） ----------

function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

// ---------- 正規化ユーティリティ ----------

function toHalfWidth(str) {
  // 全角英数字を半角に変換
  return str.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

function sanitizeDigits(str) {
  return toHalfWidth(str || "").replace(/[^0-9]/g, "");
}

function sanitizeAlnum(str) {
  return toHalfWidth(str || "").replace(/[^0-9A-Za-z]/g, "");
}

// 製品名内の改行・連続空白（全角スペース含む）を半角スペース1つに正規化する
function cleanText(str) {
  return (str || "").replace(/[\s　]+/g, " ").trim();
}

const ERA_BASE = { 令和: 2018, 平成: 1988, 昭和: 1925 };

function convertEraDateToYyyymmdd(raw) {
  if (!raw) return null;
  const normalized = toHalfWidth(raw);
  const m = normalized.match(/(令和|平成|昭和)(元|[0-9]{1,2})年\s*([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日/);
  if (!m) return null;
  const [, era, yStr, mStr, dStr] = m;
  const y = yStr === "元" ? 1 : parseInt(yStr, 10);
  const year = ERA_BASE[era] + y;
  const month = String(parseInt(mStr, 10)).padStart(2, "0");
  const day = String(parseInt(dStr, 10)).padStart(2, "0");
  return `${year}${month}${day}`;
}

// 構造化CSV側でロット・シリアルが両方とも空欄の場合に、
// 「対象ロット、数量及び出荷時期」自由記述欄から列挙된コードを推測抽出する。
// 「全ロット」等の明記や、列挙が少数（誤検出防止のため5件未満）の場合は補完しない。
function extractEnumeratedCodesFromFreeText(freeText) {
  if (!freeText) return [];
  const normalized = toHalfWidth(freeText);
  if (/全ロット/.test(normalized)) return []; // 明示的に「全ロット」＝ロット非特定
  const tokens = normalized.match(/\b[0-9]{6,14}\b/g) || [];
  const unique = [...new Set(tokens)];
  return unique.length >= 5 ? unique : [];
}

// ---------- メイン処理 ----------

async function processClass(cls) {
  console.log(`[${cls.label}] ダウンロード中...`);
  const [gtinZipBuf, detailZipBuf] = await Promise.all([
    fetchBuffer(cls.gtinZipUrl),
    fetchBuffer(cls.detailZipUrl),
  ]);

  const gtinCsvText = unzipFirstFile(gtinZipBuf).content.toString("utf8");
  const detailCsvText = unzipFirstFile(detailZipBuf).content.toString("utf8");

  const gtinRows = parseCSV(gtinCsvText);
  const detailRows = parseCSV(detailCsvText);

  const gtinHeader = gtinRows[0];
  const gtinData = gtinRows.slice(1).filter((r) => r.length === gtinHeader.length);

  const detailHeader = detailRows[0];
  const detailData = detailRows.slice(1).filter((r) => r.length === detailHeader.length);

  // 回収番号 -> 対象ロット、数量及び出荷時期（自由記述）
  const freeTextByRecall = new Map();
  const freeTextColIdx = detailHeader.indexOf("対象ロット、数量及び出荷時期");
  for (const r of detailData) {
    freeTextByRecall.set(r[0], r[freeTextColIdx]);
  }

  const outputRows = [];
  const supplementedRecalls = new Set();
  const unresolvedRecalls = new Set();

  for (const r of gtinData) {
    const [recallNo, , rawName, rawDate, gtinOuter, gtinSale, gtinPack, rawLot, rawSerial] = r;

    const name = cleanText(rawName) || NODATA;
    const dateYmd = convertEraDateToYyyymmdd(rawDate) || NODATA;

    const gtinValues = [...new Set([gtinOuter, gtinSale, gtinPack].map((g) => sanitizeDigits(g)).filter(Boolean))];
    const gtinList = gtinValues.length > 0 ? gtinValues : [NODATA];

    let lot = sanitizeAlnum(rawLot);
    let serial = sanitizeAlnum(rawSerial);

    if (!lot && !serial) {
      const freeText = freeTextByRecall.get(recallNo);
      const codes = extractEnumeratedCodesFromFreeText(freeText);
      if (codes.length > 0) {
        supplementedRecalls.add(recallNo);
        for (const gtin of gtinList) {
          for (const code of codes) {
            outputRows.push([name, dateYmd, gtin, NODATA, code]);
          }
        }
        continue;
      } else {
        unresolvedRecalls.add(recallNo);
      }
    }

    const lotOut = lot || NODATA;
    const serialOut = serial || NODATA;
    for (const gtin of gtinList) {
      outputRows.push([name, dateYmd, gtin, lotOut, serialOut]);
    }
  }

  return { outputRows, supplementedRecalls: [...supplementedRecalls], unresolvedRecalls: [...unresolvedRecalls], recallCount: new Set(gtinData.map((r) => r[0])).size };
}

function toCsvField(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const allRows = [];
  const summary = [];

  for (const cls of CLASSES) {
    const result = await processClass(cls);
    allRows.push(...result.outputRows);
    summary.push({
      class: cls.label,
      recallCount: result.recallCount,
      rowCount: result.outputRows.length,
      supplementedRecalls: result.supplementedRecalls,
      unresolvedRecalls: result.unresolvedRecalls,
    });
    console.log(`[${cls.label}] 回収件数=${result.recallCount} 出力行数=${result.outputRows.length} 自由記述から補完=${result.supplementedRecalls.length}件 未解決=${result.unresolvedRecalls.length}件`);
  }

  // 重複行（同一の name/date/GTIN/lot/serial）を除去
  const seen = new Set();
  const dedupedRows = [];
  for (const row of allRows) {
    const key = row.join("");
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRows.push(row);
    }
  }

  const header = ["一般的名称及び販売名", "回収開始日", "GTIN", "ロット番号", "シリアル番号"];
  const csvLines = [header.map(toCsvField).join(",")];
  for (const row of dedupedRows) csvLines.push(row.map(toCsvField).join(","));
  const csvContent = "﻿" + csvLines.join("\r\n") + "\r\n";

  fs.writeFileSync(OUT_CSV, csvContent, "utf8");

  const log = {
    generatedAt: new Date().toISOString(),
    totalRows: dedupedRows.length,
    duplicatesRemoved: allRows.length - dedupedRows.length,
    nodataMarker: NODATA,
    classes: summary,
  };
  fs.writeFileSync(OUT_LOG, JSON.stringify(log, null, 2), "utf8");

  // index.html が file:// でも読み込めるよう、script タグ経由でメタ情報を渡す
  fs.writeFileSync(OUT_META_JS, "window.PMDA_META = " + JSON.stringify(log, null, 2) + ";\n", "utf8");

  console.log(`\n完了: ${dedupedRows.length}行 -> ${OUT_CSV}`);
  console.log(`ビルドログ -> ${OUT_LOG}`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
