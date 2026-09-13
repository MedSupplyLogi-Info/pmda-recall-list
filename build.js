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

// GS1標準のGTINチェックデジット（モジュラス10、ウェイト3/1交互）を検証する。
// 桁数が8/12/13/14以外の場合は標準GTINではないため検証対象外とし、そのまま真とする（安全側）。
function isValidGtinCheckDigit(gtin) {
  if (![8, 12, 13, 14].includes(gtin.length)) return true;
  const digits = gtin.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const posFromRight = digits.length - 1 - i;
    sum += digits[i] * (posFromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

// GTINを数字のみに正規化した上でチェックデジットを検証する。不正な場合は null を返す
// （実在するバーコードとして印字され得ない値のため、GTIN未提供と同様に扱う）。
// invalidLog には後で個別ページへのリンクを示せるよう、回収番号・製品名も併記して記録する。
function sanitizeAndValidateGtin(str, recallNo, name, invalidLog) {
  const cleaned = sanitizeDigits(str);
  if (!cleaned) return null;
  if (!isValidGtinCheckDigit(cleaned)) {
    if (invalidLog) invalidLog.set(cleaned + "|" + recallNo, { gtin: cleaned, recallNo, name });
    return null;
  }
  return cleaned;
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

// 「A123～A130」のような英数字範囲表記を、共通の前後接頭辞・接尾辞を保ったまま展開する。
// 数値部分が数字のみでない、範囲が逆転している、範囲が異常に大きい場合は null（展開しない＝安全側）。
function expandAlnumRange(startStr, endStr, maxCount) {
  let i = 0;
  while (i < startStr.length && i < endStr.length && startStr[i] === endStr[i]) i++;
  const sRest = startStr.slice(i);
  const eRest = endStr.slice(i);
  let j = 0;
  while (j < sRest.length && j < eRest.length && sRest[sRest.length - 1 - j] === eRest[eRest.length - 1 - j]) j++;
  const sNum = sRest.slice(0, sRest.length - j);
  const eNum = eRest.slice(0, eRest.length - j);
  if (!/^[0-9]+$/.test(sNum) || !/^[0-9]+$/.test(eNum)) return null;
  const prefix = startStr.slice(0, i);
  const suffix = j > 0 ? sRest.slice(sRest.length - j) : "";
  const width = sNum.length;
  const start = parseInt(sNum, 10);
  const end = parseInt(eNum, 10);
  if (!(start <= end) || end - start + 1 > maxCount) return null;
  const out = [];
  for (let n = start; n <= end; n++) out.push(prefix + String(n).padStart(width, "0") + suffix);
  return out;
}

const LOT_LABELS = ["対象ロット", "ロット番号", "ロットNo"];
const SERIAL_LABELS = ["シリアル番号", "製造番号"];
// 上記ラベルの後に続く値の手前で自由記述を区切るための「次の見出し」一覧
const STOP_LABELS = [...LOT_LABELS, ...SERIAL_LABELS, "製品コード", "製品番号", "数量", "出荷数量", "製造数量", "出荷時期", "出荷年月日", "対象製品", "販売名", "一般的名称"];

// 自由記述中の「シリアル番号：」「製造番号：」等のラベルを目印に値を抽出する（ラベル起点なので短い値・単一値でも信頼できる）。
// ラベルが見つからない場合は resolveMissingCodes 側で旧方式（全文からの数字列挙抽出）にフォールバックする。
function extractLabeledCodes(freeText) {
  if (!freeText) return { lot: [], serial: [] };
  const normalized = toHalfWidth(freeText);
  if (/全ロット/.test(normalized)) return { lot: [], serial: [] }; // 明示的に「全ロット」＝ロット非特定

  const labelPattern = new RegExp(`(${[...LOT_LABELS, ...SERIAL_LABELS].join("|")})[^\\n:：]{0,20}[:：]`, "g");
  const stopPattern = new RegExp(`(${STOP_LABELS.join("|")})[^\\n:：]{0,20}[:：]`, "g");

  const matches = [];
  let m;
  while ((m = labelPattern.exec(normalized))) {
    matches.push({ label: m[1], start: m.index, contentStart: m.index + m[0].length });
  }
  const stops = [];
  while ((m = stopPattern.exec(normalized))) stops.push(m.index);

  const result = { lot: [], serial: [] };
  for (const { label, contentStart } of matches) {
    let segEnd = normalized.length;
    for (const s of stops) if (s > contentStart && s < segEnd) segEnd = s;
    const segment = normalized.slice(contentStart, segEnd);

    const codes = [];
    const chunks = segment.split(/[,、，\s\n･・]+/).filter(Boolean);
    for (const chunk of chunks) {
      const rangeMatch = chunk.match(/^([0-9A-Za-z]{2,20})[～~〜]([0-9A-Za-z]{2,20})$/);
      if (rangeMatch) {
        const expanded = expandAlnumRange(rangeMatch[1], rangeMatch[2], 5000);
        if (expanded) { codes.push(...expanded); continue; }
      }
      const token = chunk.replace(/^[()（）]+|[()（）]+$/g, "");
      if (/^[0-9A-Za-z]{2,20}$/.test(token)) codes.push(token);
    }
    if (codes.length === 0) continue;
    if (SERIAL_LABELS.includes(label)) result.serial.push(...codes);
    else result.lot.push(...codes);
  }
  result.lot = [...new Set(result.lot)];
  result.serial = [...new Set(result.serial)];
  return result;
}

// 旧方式：ラベルの目印が無い自由記述向けのフォールバック。全文から6〜14桁の数字列を拾い、
// 誤検出を避けるため5件以上の列挙が確認できた場合のみ採用する。
function extractEnumeratedCodesFromFreeText(freeText) {
  if (!freeText) return [];
  const normalized = toHalfWidth(freeText);
  if (/全ロット/.test(normalized)) return [];
  const tokens = normalized.match(/\b[0-9]{6,14}\b/g) || [];
  const unique = [...new Set(tokens)];
  return unique.length >= 5 ? unique : [];
}

// ロット・シリアルが両方欠落している場合に、自由記述から補完を試みる統一エントリポイント。
// 戻り値: { type: "lot"|"serial", codes: string[] } または見つからなければ null。
function resolveMissingCodes(freeText) {
  const labeled = extractLabeledCodes(freeText);
  if (labeled.serial.length > 0) return { type: "serial", codes: labeled.serial };
  if (labeled.lot.length > 0) return { type: "lot", codes: labeled.lot };
  const blind = extractEnumeratedCodesFromFreeText(freeText);
  if (blind.length > 0) return { type: "serial", codes: blind };
  return null;
}

// 詳細版CSVの「一般的名称及び販売名」列は「一般的名称：X\n販売名　：Y」形式のラベル付き記述のため、
// GTIN版の名称列（プレーンテキスト）と表記を揃えるためラベルを除去して結合する。
function cleanDetailName(raw) {
  const stripped = (raw || "").replace(/一般的名称[:：]/g, " ").replace(/販売名\s*[:：]/g, " ");
  return cleanText(stripped);
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

  // 回収番号 -> 詳細版の各列（自由記述・名称・回収開始日）
  const freeTextColIdx = detailHeader.indexOf("対象ロット、数量及び出荷時期");
  const detailNameColIdx = detailHeader.indexOf("一般的名称及び販売名");
  const detailDateColIdx = detailHeader.indexOf("回収開始日");
  const detailByRecall = new Map();
  for (const r of detailData) detailByRecall.set(r[0], r);

  const outputRows = [];
  const supplementedRecalls = new Set();
  const unresolvedRecalls = new Set();
  const gtinMissingRecalls = new Set();
  const invalidChecksumGtins = new Map();

  const gtinRecallIds = new Set(gtinData.map((r) => r[0]));

  for (const r of gtinData) {
    const [recallNo, , rawName, rawDate, gtinOuter, gtinSale, gtinPack, rawLot, rawSerial] = r;

    const name = cleanText(rawName) || NODATA;
    const dateYmd = convertEraDateToYyyymmdd(rawDate) || NODATA;

    // チェックデジット不正なGTIN（実在するバーコードとして印字され得ない値）は、
    // GTIN未提供と同様に扱う（invalidChecksumGtinsに記録の上、行からは除外）。
    const gtinValues = [
      ...new Set(
        [gtinOuter, gtinSale, gtinPack]
          .map((g) => sanitizeAndValidateGtin(g, recallNo, name, invalidChecksumGtins))
          .filter(Boolean)
      ),
    ];
    const gtinList = gtinValues.length > 0 ? gtinValues : [NODATA];

    let lot = sanitizeAlnum(rawLot);
    let serial = sanitizeAlnum(rawSerial);

    if (!lot && !serial) {
      const detailRow = detailByRecall.get(recallNo);
      const freeText = detailRow ? detailRow[freeTextColIdx] : null;
      const resolved = resolveMissingCodes(freeText);
      if (resolved) {
        supplementedRecalls.add(recallNo);
        for (const gtin of gtinList) {
          for (const code of resolved.codes) {
            outputRows.push(resolved.type === "serial" ? [name, dateYmd, gtin, NODATA, code] : [name, dateYmd, gtin, code, NODATA]);
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

  // GTIN版に一件も対応行が無い回収（ソフトウェア製品やGTIN未登録製品）を、詳細版を正として補う。
  // GTINは提供元データに存在しないため NODATA とし、自由記述からロット・シリアルの復元を試みる。
  for (const detailRow of detailData) {
    const recallNo = detailRow[0];
    if (gtinRecallIds.has(recallNo)) continue;

    gtinMissingRecalls.add(recallNo);
    const name = cleanDetailName(detailRow[detailNameColIdx]) || NODATA;
    const dateYmd = convertEraDateToYyyymmdd(detailRow[detailDateColIdx]) || NODATA;
    const freeText = detailRow[freeTextColIdx];
    const resolved = resolveMissingCodes(freeText);

    if (resolved) {
      supplementedRecalls.add(recallNo);
      for (const code of resolved.codes) {
        outputRows.push(resolved.type === "serial" ? [name, dateYmd, NODATA, NODATA, code] : [name, dateYmd, NODATA, code, NODATA]);
      }
    } else {
      unresolvedRecalls.add(recallNo);
      outputRows.push([name, dateYmd, NODATA, NODATA, NODATA]);
    }
  }

  const allRecallIds = new Set([...gtinRecallIds, ...detailData.map((r) => r[0])]);

  return {
    outputRows,
    supplementedRecalls: [...supplementedRecalls],
    unresolvedRecalls: [...unresolvedRecalls],
    gtinMissingRecalls: [...gtinMissingRecalls],
    invalidChecksumGtins: [...invalidChecksumGtins.values()],
    recallCount: allRecallIds.size,
  };
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
      gtinMissingRecalls: result.gtinMissingRecalls,
      invalidChecksumGtins: result.invalidChecksumGtins,
    });
    console.log(`[${cls.label}] 回収件数=${result.recallCount} 出力行数=${result.outputRows.length} 自由記述から補完=${result.supplementedRecalls.length}件 未解決=${result.unresolvedRecalls.length}件 GTIN未提供=${result.gtinMissingRecalls.length}件 チェックデジット不正GTIN=${result.invalidChecksumGtins.length}件`);
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
