// PMDA 医療機器回収情報（クラスI/II/III）統合CSV生成スクリプト
//
// 実行方法: node build.js
// PMDAサイトから最新のCSVを取得し、data/recall_list_merged.csv を再生成する。
// PMDA側のURLが年度更新される場合は下記 FISCAL_YEAR_CODE を書き換えること
// （例年、年度替わり前後にPMDA側のファイル名が rcidx<新年度コード>-... に変わる）。

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "data");
const OUT_CSV = path.join(OUT_DIR, "recall_list_merged.csv");
const OUT_CUMULATIVE_CSV = path.join(OUT_DIR, "recall_list_cumulative.csv");
const OUT_HISTORY = path.join(OUT_DIR, "history.json");
const OUT_LOG = path.join(OUT_DIR, "build-log.json");
const OUT_META_JS = path.join(OUT_DIR, "meta.js");
const NODATA = "NODATA"; // 空欄セルであることを示す固定コード（値が存在しない・不明な場合）
// 「全ロット対象」等、自由記述上ロットが非特定（＝回収対象が特定ロットに限定されない）と
// 明記されている場合のロット番号欄の固定コード。NODATA（値が不明・欠落）とは意味が異なり、
// 機械的に「全ロット対象の回収である」と判別できるようにするためのマーカー。
const ALL_LOTS_MARKER = "ALLLOTS";
// CSV生成ロジックのバージョン。網羅性・正確性・完全性等の判定ロジックや出力列構成を変更した場合はここを更新する。
const BUILD_LOGIC_VERSION = "1.5";
const STATUS_COL = "状態";
const STATUS_ACTIVE = "現行";
const STATUS_REMOVED = "回収済み（PMDA提供データから削除）";

// PMDAのファイル名に含まれる年度コード（令和8年度 = "26"）。年度替わり時はここだけ書き換える。
const FISCAL_YEAR_CODE = "26";

const CLASSES = [
  {
    label: "クラスI",
    gtinZipUrl: `https://www.info.pmda.go.jp/kaisyuu/rcidx${FISCAL_YEAR_CODE}-1k2_all.zip`,
    detailZipUrl: `https://www.info.pmda.go.jp/kaisyuu/rcidx${FISCAL_YEAR_CODE}-1k_all.zip`,
  },
  {
    label: "クラスII",
    gtinZipUrl: `https://www.info.pmda.go.jp/kaisyuu/rcidx${FISCAL_YEAR_CODE}-2k2_all.zip`,
    detailZipUrl: `https://www.info.pmda.go.jp/kaisyuu/rcidx${FISCAL_YEAR_CODE}-2k_all.zip`,
  },
  {
    label: "クラスIII",
    gtinZipUrl: `https://www.info.pmda.go.jp/kaisyuu/rcidx${FISCAL_YEAR_CODE}-3k2_all.zip`,
    detailZipUrl: `https://www.info.pmda.go.jp/kaisyuu/rcidx${FISCAL_YEAR_CODE}-3k_all.zip`,
  },
];

// ---------- HTTP ----------

// 取得元として信頼する唯一のホスト。PMDA側のURL構成が変わらない限り固定する。
const TRUSTED_HOST = "www.info.pmda.go.jp";

// GitHub Actionsでの日次実行時、PMDA側の一時的な応答遅延・瞬断でジョブ全体が
// 即失敗することを避けるため、タイムアウトとリトライを設定する。
const FETCH_TIMEOUT_MS = 30000;
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 5000;

async function fetchBuffer(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchBufferOnce(url);
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_MAX_ATTEMPTS) {
        console.warn(`取得失敗（${attempt}/${FETCH_MAX_ATTEMPTS}回目、${FETCH_RETRY_DELAY_MS / 1000}秒後に再試行）: ${url} - ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

async function fetchBufferOnce(url) {
  const requestedUrl = new URL(url);
  if (requestedUrl.protocol !== "https:") {
    throw new Error(`安全でない通信方式です（https以外）: ${url}`);
  }
  if (requestedUrl.hostname !== TRUSTED_HOST) {
    throw new Error(`信頼できないホストへのリクエストです: ${requestedUrl.hostname}`);
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  // リダイレクトを経由して信頼できないホスト・非HTTPSへ飛ばされていないか確認する
  // （fetchはデフォルトでリダイレクトに追従するため、最終到達先を別途検証する）。
  const finalUrl = new URL(res.url || url);
  if (finalUrl.protocol !== "https:") {
    throw new Error(`リダイレクト先が安全でない通信方式です（https以外）: ${finalUrl.href}`);
  }
  if (finalUrl.hostname !== TRUSTED_HOST) {
    throw new Error(`信頼できないホストへリダイレクトされました: ${finalUrl.hostname}（元URL: ${url}）`);
  }

  if (!res.ok) throw new Error(`HTTPエラー ${res.status}: ${url}`);

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  // 取得内容がZIPファイル（ローカルファイルヘッダ "PK\x03\x04"）であることを確認する。
  // PMDA側の障害・WAFブロック等でHTMLエラーページ等が返された場合はここで検知する。
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error(`期待されるZIP形式ではありません（PMDA側のエラーページ等が返された可能性があります）: ${url}`);
  }

  return buf;
}

// ---------- 最小限のZIP展開（単一ファイル・deflate想定） ----------

// 展開後サイズの上限（ZIP爆弾/メモリ枯渇対策）。
// 実際のPMDA提供CSVは展開後でも数十MB程度のため、十分な余裕を持って上限を設定する。
const MAX_UNCOMPRESSED_SIZE = 200 * 1024 * 1024; // 200MB

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
  const uncompSize = buf.readUInt32LE(cdOffset + 24);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
  const fileName = buf.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLen);

  // ZIP64形式（4GB超のファイル等で、サイズ・オフセットが0xFFFFFFFFのセンチネル値となり、
  // 実際の値はZIP64拡張フィールド側に格納される）には未対応。本パーサは最小限のZIP実装の
  // ため、将来PMDA側のZIP生成ツールがZIP64形式に変わった場合に備え、誤った小さい値として
  // 誤動作するのではなく、原因が即座に分かるよう明示的にエラーとする。
  if (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
    throw new Error("ZIP64形式には未対応です（PMDA側のZIP生成方式が変更された可能性があります）");
  }

  // 展開前に、ZIP自体のサイズに対して展開後サイズが不自然に大きくないかを確認する
  // （いわゆるZIP爆弾：小さな圧縮ファイルから巨大な展開結果を生成する攻撃への対策）。
  if (uncompSize > MAX_UNCOMPRESSED_SIZE) {
    throw new Error(`展開後サイズが上限を超えています（${uncompSize}バイト > 上限${MAX_UNCOMPRESSED_SIZE}バイト）。ZIP爆弾の可能性があるため中断しました。`);
  }

  const LFH_SIG = 0x04034b50;
  if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIG) throw new Error("ZIP形式が不正です（ローカルヘッダが見つかりません）");
  const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
  const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  const compData = buf.subarray(dataStart, dataStart + compSize);

  let content;
  if (compMethod === 0) content = compData; // 無圧縮
  else if (compMethod === 8) content = zlib.inflateRawSync(compData, { maxOutputLength: MAX_UNCOMPRESSED_SIZE }); // deflate
  else throw new Error(`未対応の圧縮方式です: ${compMethod}`);

  return { fileName, content };
}

// ---------- CSVパース（引用符内改行対応） ----------

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ""); // 先頭のBOM（byte order mark）を除去
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

// ロット番号・シリアル番号の正規化。
// 全角→半角変換とPMDA側のExcel対策用アポストロフィ・前後空白の除去のみを行い、
// ハイフン等（GS1-128のAI(10)/(21)等で識別子の一部として印字され得る記号）は
// 保持する（実データでも "22-12-041" 等、記号込みで識別子を構成する例が確認されている）。
function sanitizeLotSerial(str) {
  return toHalfWidth(str || "").replace(/^'+/, "").trim();
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

// 「掲載年月日」列は "'2026/09/07 16:39:16" のような西暦スラッシュ表記（時刻や
// 「情報提供の開始」等の付随文言が付くこともある）。先頭の年月日部分のみを抽出しyyyymmddに変換する。
function convertSlashDateToYyyymmdd(raw) {
  if (!raw) return null;
  const normalized = toHalfWidth(raw);
  const m = normalized.match(/([0-9]{4})\/([0-9]{1,2})\/([0-9]{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}${mo.padStart(2, "0")}${d.padStart(2, "0")}`;
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

// 「全ロット対象」等、ロットが非特定であることを示す表現。実データ調査では「全ロット」以外の
// 表現は確認されていないが（2026年11月時点）、将来PMDA側の記述が変わった場合に備え、
// 意味が明確で誤検出リスクの低い表現のみを追加している（「全数」「全量」等、数量一般を
// 指す語は無関係な文脈でも頻出するため意図的に含めていない）。
const ALL_LOTS_PATTERNS = [/全ロット/, /すべてのロット/, /全てのロット/, /全製造番号/];
function matchesAllLotsPattern(normalizedText) {
  return ALL_LOTS_PATTERNS.some((re) => re.test(normalizedText));
}

// 自由記述中の「シリアル番号：」「製造番号：」等のラベルを目印に値を抽出する（ラベル起点なので短い値・単一値でも信頼できる）。
// ラベルの直後が「：」で区切られている、最も一般的な書式に対応する（厳格版）。
// ここで何も見つからない場合は extractLabeledCodesLoose（区切り文字の異なる書式向け）、
// さらに見つからない場合は resolveMissingCodes 側で旧方式（全文からの数字列挙抽出）にフォールバックする。
function extractLabeledCodesStrict(freeText) {
  if (!freeText) return { lot: [], serial: [] };
  const normalized = toHalfWidth(freeText);
  if (matchesAllLotsPattern(normalized)) return { lot: [], serial: [] }; // 明示的に「全ロット」等＝ロット非特定

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
      // ロット・シリアル番号には "22-12-041" のようにハイフンを含む識別子もあるため、
      // GTIN版CSVのロット・シリアル列（sanitizeLotSerial）と同じ基準でハイフンも許容する。
      const rangeMatch = chunk.match(/^([0-9A-Za-z-]{2,20})[～~〜]([0-9A-Za-z-]{2,20})$/);
      if (rangeMatch) {
        const expanded = expandAlnumRange(rangeMatch[1], rangeMatch[2], 5000);
        if (expanded) { codes.push(...expanded); continue; }
      }
      const token = chunk.replace(/^[()（）]+|[()（）]+$/g, "");
      if (/^[0-9A-Za-z-]{2,20}$/.test(token)) codes.push(token);
    }
    if (codes.length === 0) continue;
    if (SERIAL_LABELS.includes(label)) result.serial.push(...codes);
    else result.lot.push(...codes);
  }
  result.lot = [...new Set(result.lot)];
  result.serial = [...new Set(result.serial)];
  return result;
}

// ラベルの直後が「：」ではなく「ロットNo.(C1)」のような句点＋括弧書き、または
// 「製造番号\nSBM100...〜SBM200...」のような改行区切りになっている書式向けのフォールバック。
// extractLabeledCodesStrict で何も見つからなかった場合のみ呼ばれるため、
// 既に正しく抽出できている既存の挙動には影響しない（追加検出のみ）。
function extractLabeledCodesLoose(freeText) {
  const result = { lot: [], serial: [] };
  if (!freeText) return result;
  const normalized = toHalfWidth(freeText);
  if (matchesAllLotsPattern(normalized)) return result;

  const allLabels = [...LOT_LABELS, ...SERIAL_LABELS];
  const labelPattern = new RegExp(`(${allLabels.join("|")})`, "g");
  const stopLabelPattern = new RegExp(`^(${STOP_LABELS.join("|")})`);

  let m;
  while ((m = labelPattern.exec(normalized))) {
    const label = m[1];
    const after = normalized.slice(m.index + m[0].length, m.index + m[0].length + 80);

    // パターンA:「ラベル.(値)」「ラベル(値)」のように句点・括弧で値を囲む書式
    const parenMatch = after.match(/^[.．]?\s*[(（]([^)）]{1,40})[)）]/);
    // パターンB: ラベル直後が改行で、次の行に値がある書式（次行が別の見出し語で始まる場合は除外）
    const lineMatch = after.match(/^[ \t]*\r?\n[ \t]*([^\n]{1,60})/);

    let segment = null;
    if (parenMatch) segment = parenMatch[1];
    else if (lineMatch && !stopLabelPattern.test(lineMatch[1])) segment = lineMatch[1];
    if (!segment) continue;

    const codes = [];
    const chunks = segment.split(/[,、，\s　\n･・]+/).filter(Boolean);
    for (const chunk of chunks) {
      const rangeMatch = chunk.match(/^([0-9A-Za-z-]{2,20})[～~〜]([0-9A-Za-z-]{2,20})$/);
      if (rangeMatch) {
        const expanded = expandAlnumRange(rangeMatch[1], rangeMatch[2], 5000);
        if (expanded) { codes.push(...expanded); continue; }
      }
      const token = chunk.replace(/^[()（）]+|[()（）]+$/g, "");
      if (/^[0-9A-Za-z-]{2,20}$/.test(token)) codes.push(token);
    }
    if (codes.length === 0) continue;
    if (SERIAL_LABELS.includes(label)) result.serial.push(...codes);
    else result.lot.push(...codes);
  }
  result.lot = [...new Set(result.lot)];
  result.serial = [...new Set(result.serial)];
  return result;
}

function extractLabeledCodes(freeText) {
  const strict = extractLabeledCodesStrict(freeText);
  if (strict.lot.length > 0 || strict.serial.length > 0) return strict;
  return extractLabeledCodesLoose(freeText);
}

// 旧方式：ラベルの目印が無い自由記述向けのフォールバック。全文から6〜14桁の数字列を拾い、
// 誤検出を避けるため5件以上の列挙が確認できた場合のみ採用する。
function extractEnumeratedCodesFromFreeText(freeText) {
  if (!freeText) return [];
  const normalized = toHalfWidth(freeText);
  if (matchesAllLotsPattern(normalized)) return [];
  // \b（単語境界）は半角英数字・アンダースコアとそれ以外の境界にしかマッチしないため、
  // "Lot12345678" のように数字の直前が半角英字の場合に抽出漏れが起こる。
  // 否定先読み・否定後読みで「前後が半角英数字でない」ことを直接確認する。
  // ハイフンも境界除外文字に含め、"20260101-123456" のような連結番号が
  // 意図せず2つの数字列に分断・誤抽出されることを防ぐ（安全側）。
  const tokens = normalized.match(/(?<![0-9A-Za-z-])[0-9]{6,14}(?![0-9A-Za-z-])/g) || [];
  const unique = [...new Set(tokens)];
  return unique.length >= 5 ? unique : [];
}

// プログラム医療機器（ソフトウェア）の個体管理ID・バージョンの抽出（ID/バージョン列用）。
// プログラム医療機器であっても個体ごとにGTIN・ロット・シリアルが付与されている製品も
// 多数存在するため「ロット・シリアルの概念がない」と断定はできない。一方で、実データ上、
// 個体管理IDが「のID：」等（LOT_LABELS/SERIAL_LABELSには含まれない見出し語）に続く形で
// 記載されている製品や、バージョン番号単位でのみ出荷数量が管理されている製品が確認されている。
// これらはGTIN付きバーコードと直接対応する識別体系ではないため、ロット番号・シリアル番号とは
// 別の専用列（ID/バージョン）に出力する。
const PROGRAM_ID_STOP_PATTERN = /(出荷数量|出荷時期及び数量|アプリケーション公開時期|製造数量|出荷時期)[^\n:：]{0,20}[:：]/g;

function extractProgramIds(freeText) {
  if (!freeText) return [];
  const normalized = toHalfWidth(freeText);
  const m = normalized.match(/ID[:：]/);
  if (!m) return [];
  const afterIdx = m.index + m[0].length;
  let segEnd = normalized.length;
  PROGRAM_ID_STOP_PATTERN.lastIndex = 0;
  let sm;
  while ((sm = PROGRAM_ID_STOP_PATTERN.exec(normalized))) {
    if (sm.index > afterIdx) { segEnd = sm.index; break; }
  }
  const segment = normalized.slice(afterIdx, segEnd);
  const tokens = segment.split(/[,、，\s　\n･・]+/).filter(Boolean);
  const ids = tokens.filter((t) => /^[0-9A-Za-z]{4,20}$/.test(t));
  return [...new Set(ids)];
}

function extractProgramVersions(freeText) {
  if (!freeText) return [];
  const normalized = toHalfWidth(freeText);
  const matches = normalized.match(/バージョン\s*[0-9]+(?:\.[0-9]+)*/g) || [];
  return [...new Set(matches.map((s) => s.replace(/\s+/g, "")))];
}

// ロット・シリアルが両方欠落し自由記述からも復元できない場合の最終フォールバック。
// 個体管理ID（信頼度：高、個体ごとに異なる値のため）を優先し、無ければバージョン番号
// （信頼度：中、複数個体が同一バージョンを共有するため個体識別力は低い）を採用する。
function resolveProgramIdOrVersion(freeText) {
  const ids = extractProgramIds(freeText);
  if (ids.length > 0) return { type: "id", codes: ids };
  const versions = extractProgramVersions(freeText);
  if (versions.length > 0) return { type: "version", codes: versions };
  return null;
}

// ロット・シリアルが両方欠落している場合に、自由記述から補完を試みる統一エントリポイント。
// 戻り値: { type: "lot"|"serial", codes: string[], confident: boolean } または見つからなければ null。
//
// confident=true は「シリアル番号：」「対象ロット：」等のラベルから機械的に判別できたケース。
// confident=false は旧方式（全文からの数字列挙）でのフォールバックで、ロット/シリアルいずれの
// 値かを元テキストから判別する手がかりが無いため、便宜上シリアル番号側に割り当てているに過ぎない
// （＝この区分は推定であり、断定ではない）。
function resolveMissingCodes(freeText) {
  const labeled = extractLabeledCodes(freeText);
  if (labeled.serial.length > 0) return { type: "serial", codes: labeled.serial, confident: true };
  if (labeled.lot.length > 0) return { type: "lot", codes: labeled.lot, confident: true };
  const blind = extractEnumeratedCodesFromFreeText(freeText);
  if (blind.length > 0) return { type: "serial", codes: blind, confident: false };
  return null;
}

// 復元できなかった回収のうち，自由記述に「対象ロット：全ロット」等の明記があり、
// ロット非特定であることがPMDA側で既に確定しているため「要確認」として提示する
// 意味が無いケースを判別する。一覧からは除外するが、CSV側の行（ALL_LOTS_MARKER）は
// これまで通り出力する。
function isAllLotsNonSpecific(freeText) {
  if (!freeText) return false;
  return matchesAllLotsPattern(toHalfWidth(freeText));
}

// resolveMissingCodes の結果から [ロット番号, シリアル番号] の組を組み立てる。
// ラベルから確実に判別できた場合（confident=true）は該当する列だけを埋めた1パターンのみ。
// 判別できず推定に頼った場合（confident=false）は、ロット番号として埋めた行とシリアル番号
// として埋めた行の両方を出力する。どちらの列を照合するバーコードシステムでも実データと
// 一致できるよう、断定せず両論併記する（GTIN元梱/販売/個装を全て展開するのと同じ考え方）。
function buildLotSerialPairs(resolved) {
  if (resolved.confident) {
    return resolved.codes.map((code) => (resolved.type === "serial" ? [NODATA, code] : [code, NODATA]));
  }
  const pairs = [];
  for (const code of resolved.codes) {
    pairs.push([code, NODATA]);
    pairs.push([NODATA, code]);
  }
  return pairs;
}

// 詳細版CSVの「一般的名称及び販売名」列は「一般的名称：X\n販売名　：Y」形式のラベル付き記述のため、
// GTIN版の名称列（プレーンテキスト）と表記を揃えるためラベルを除去して結合する。
function cleanDetailName(raw) {
  const stripped = (raw || "").replace(/一般的名称[:：]/g, " ").replace(/販売名\s*[:：]/g, " ");
  return cleanText(stripped);
}

// 詳細版CSVの「一般的名称及び販売名」列を「一般的名称」と「販売名」に分割する
// （Webページで両方を併記できるようにするため）。
function splitGeneralAndBrandName(raw) {
  if (!raw) return { generalName: "", brandName: "" };
  const generalMatch = raw.match(/一般的名称[:：]([\s\S]*?)(?=販売名\s*[:：]|$)/);
  const brandMatch = raw.match(/販売名\s*[:：]([\s\S]*)$/);
  return {
    generalName: cleanText(generalMatch ? generalMatch[1] : ""),
    brandName: cleanText(brandMatch ? brandMatch[1] : ""),
  };
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
  const detailPostDateColIdx = detailHeader.indexOf("掲載年月日");
  const detailByRecall = new Map();
  for (const r of detailData) detailByRecall.set(r[0], r);

  const taggedRows = []; // { recallNo, row } を一時的に保持し、後で履歴用に回収番号単位へ集約する
  const invalidChecksumGtins = new Map();
  const ambiguousTypeRecalls = new Set();
  // ロット・シリアルが両方欠落していた回収を、復元結果のステータス付きで一元管理する。
  // status: "supplemented"(自由記述から復元) / "unresolved"(復元不可・要確認) /
  //         "excluded"(全ロット対応・ソフトウェア等、本来的に空欄が正しいため要確認から除外)
  const bothBlankRecalls = new Map();
  const gtinMissingRecalls = new Map();

  const gtinRecallIds = new Set(gtinData.map((r) => r[0]));

  // 回収番号単位で「その回収に属する全行のロット・シリアルが空欄」かどうかを判定する。
  // 1件の回収に複数行（複数GTIN等）がある場合、一部の行だけが空欄のケースを
  // 「ロット・シリアル両方欠落の回収」として誤って集計しないよう、行単位ではなく
  // 回収番号単位で判定する。
  const recallAllBlank = new Map();
  for (const r of gtinData) {
    const recallNo = r[0];
    const rowBlank = !sanitizeLotSerial(r[7]) && !sanitizeLotSerial(r[8]);
    if (!recallAllBlank.has(recallNo)) recallAllBlank.set(recallNo, true);
    if (!rowBlank) recallAllBlank.set(recallNo, false);
  }

  // status: "supplemented"（ロット/シリアル、またはプログラム医療機器のID/バージョンで復元）/
  //         "unresolved"（復元不可・要確認）/ "excluded"（全ロット対応。本来的に空欄が正しいため要確認から除外）
  // reason: "program_id" / "program_version" の場合、ロット・シリアルではなくID/バージョン列で
  //         補完されたことを示す（補完成功だが内容が異なるため、サイト上で区別して表示する）。
  function recordBothBlank(recallNo, detailRow, freeText, resolved, isAllLots, programInfo) {
    const { generalName, brandName } = splitGeneralAndBrandName(detailRow ? detailRow[detailNameColIdx] : "");
    let status;
    let reason;
    if (resolved) {
      status = "supplemented";
      if (!resolved.confident) ambiguousTypeRecalls.add(recallNo);
    } else if (isAllLots) {
      status = "excluded";
      reason = "all_lots"; // 全ロット対象（ロット番号欄はALL_LOTS_MARKERで機械判別可能）
    } else if (programInfo) {
      // プログラム医療機器の個体管理ID・バージョンで復元できた場合は「対象外」ではなく
      // 「補完成功」とする（ID/バージョン列に実際の値が入っているため）。
      status = "supplemented";
      reason = programInfo.type === "id" ? "program_id" : "program_version";
    } else {
      status = "unresolved";
    }
    bothBlankRecalls.set(recallNo, { recallNo, generalName, brandName, status, reason });
  }

  // ロット・シリアル両方欠落の回収は、自由記述の解析結果を回収番号単位でキャッシュする
  // （1つの回収に複数GTIN等で複数行ある場合、同じ自由記述を行ごとに毎回パースし直す
  // 無駄な再計算を避けるため）。
  const resolvedCacheByRecall = new Map();
  function getResolvedForRecall(recallNo) {
    if (resolvedCacheByRecall.has(recallNo)) return resolvedCacheByRecall.get(recallNo);
    const detailRow = detailByRecall.get(recallNo);
    const freeText = detailRow ? detailRow[freeTextColIdx] : null;
    const resolved = resolveMissingCodes(freeText);
    const isAllLots = !resolved && isAllLotsNonSpecific(freeText);
    const programInfo = !resolved && !isAllLots ? resolveProgramIdOrVersion(freeText) : null;
    recordBothBlank(recallNo, detailRow, freeText, resolved, isAllLots, programInfo);
    const info = { resolved, isAllLots, programInfo };
    resolvedCacheByRecall.set(recallNo, info);
    return info;
  }

  for (const r of gtinData) {
    const [recallNo, rawPostDate, rawName, rawDate, gtinOuter, gtinSale, gtinPack, rawLot, rawSerial] = r;

    const name = cleanText(rawName) || NODATA;
    const dateYmd = convertEraDateToYyyymmdd(rawDate) || NODATA;
    const postDateYmd = convertSlashDateToYyyymmdd(rawPostDate) || NODATA;

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

    let lot = sanitizeLotSerial(rawLot);
    let serial = sanitizeLotSerial(rawSerial);

    if (!lot && !serial && recallAllBlank.get(recallNo)) {
      const { resolved, isAllLots, programInfo } = getResolvedForRecall(recallNo);
      if (resolved) {
        const pairs = buildLotSerialPairs(resolved);
        for (const gtin of gtinList) {
          for (const [lotVal, serialVal] of pairs) {
            taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, gtin, lotVal, serialVal, NODATA] });
          }
        }
        continue;
      }
      if (isAllLots) {
        // 「全ロット対象」等、ロットが非特定であることが自由記述上明記されている場合は、
        // 単なる欠落（NODATA）と区別できるよう、ロット番号欄に専用マーカーを出力する。
        for (const gtin of gtinList) {
          taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, gtin, ALL_LOTS_MARKER, NODATA, NODATA] });
        }
        continue;
      }
      if (programInfo) {
        // プログラム医療機器の個体管理ID・バージョンをID/バージョン列に出力する。
        for (const gtin of gtinList) {
          for (const code of programInfo.codes) {
            taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, gtin, NODATA, NODATA, code] });
          }
        }
        continue;
      }
    }

    const lotOut = lot || NODATA;
    const serialOut = serial || NODATA;
    for (const gtin of gtinList) {
      taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, gtin, lotOut, serialOut, NODATA] });
    }
  }

  // GTIN版に一件も対応行が無い回収（GTIN内訳が未提出の製品、ソフトウェア医療機器等）を、詳細版を正として補う。
  // PMDA提供データ側にGTIN情報が無いため NODATA とし、自由記述からロット・シリアルの復元を試みる。
  for (const detailRow of detailData) {
    const recallNo = detailRow[0];
    if (gtinRecallIds.has(recallNo)) continue;

    const { generalName, brandName } = splitGeneralAndBrandName(detailRow[detailNameColIdx]);
    gtinMissingRecalls.set(recallNo, { recallNo, generalName, brandName });

    const name = cleanDetailName(detailRow[detailNameColIdx]) || NODATA;
    const dateYmd = convertEraDateToYyyymmdd(detailRow[detailDateColIdx]) || NODATA;
    const postDateYmd = convertSlashDateToYyyymmdd(detailRow[detailPostDateColIdx]) || NODATA;
    const freeText = detailRow[freeTextColIdx];
    const resolved = resolveMissingCodes(freeText);
    const isAllLots = !resolved && isAllLotsNonSpecific(freeText);
    const programInfo = !resolved && !isAllLots ? resolveProgramIdOrVersion(freeText) : null;
    recordBothBlank(recallNo, detailRow, freeText, resolved, isAllLots, programInfo);

    if (resolved) {
      for (const [lotVal, serialVal] of buildLotSerialPairs(resolved)) {
        taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, NODATA, lotVal, serialVal, NODATA] });
      }
    } else if (isAllLots) {
      // 「全ロット対象」等、ロットが非特定であることが自由記述上明記されている場合は、
      // 単なる欠落（NODATA）と区別できるよう、ロット番号欄に専用マーカーを出力する。
      taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, NODATA, ALL_LOTS_MARKER, NODATA, NODATA] });
    } else if (programInfo) {
      // プログラム医療機器の個体管理ID・バージョンをID/バージョン列に出力する。
      for (const code of programInfo.codes) {
        taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, NODATA, NODATA, NODATA, code] });
      }
    } else {
      taggedRows.push({ recallNo, row: [recallNo, name, postDateYmd, dateYmd, NODATA, NODATA, NODATA, NODATA] });
    }
  }

  // 出力CSV側は最終的にmain()側で全クラス横断の重複除去を行うが、
  // history.json（回収番号単位の行一覧）・累積CSVの「回収済み」側はrecallRowsMapを
  // そのまま使うため、ここでもクラス内の重複行（同一回収番号・同一内容の行）を
  // 除去しておく。除去しないと、重複行を含む回収がPMDA側で削除された際、
  // 累積CSVの「回収済み」側だけ重複した行数が残ってしまう。
  const seenTaggedRows = new Set();
  const dedupedTaggedRows = taggedRows.filter(({ recallNo, row }) => {
    const key = recallNo + "\x01" + row.join("\x01");
    if (seenTaggedRows.has(key)) return false;
    seenTaggedRows.add(key);
    return true;
  });

  // 回収番号単位の行一覧（履歴保存・累積CSV用）を構築する
  const recallRowsMap = new Map();
  for (const { recallNo, row } of dedupedTaggedRows) {
    if (!recallRowsMap.has(recallNo)) {
      const detailRow = detailByRecall.get(recallNo);
      const { generalName, brandName } = splitGeneralAndBrandName(detailRow ? detailRow[detailNameColIdx] : "");
      recallRowsMap.set(recallNo, { recallNo, class: cls.label, generalName, brandName, rows: [] });
    }
    recallRowsMap.get(recallNo).rows.push(row);
  }

  const outputRows = dedupedTaggedRows.map((t) => t.row);
  const allRecallIds = new Set([...gtinRecallIds, ...detailData.map((r) => r[0])]);

  const supplemented = [...bothBlankRecalls.values()].filter((x) => x.status === "supplemented");
  const unresolved = [...bothBlankRecalls.values()].filter((x) => x.status === "unresolved");
  const excluded = [...bothBlankRecalls.values()].filter((x) => x.status === "excluded");

  return {
    outputRows,
    rawRowCount: taggedRows.length, // クラス内重複除去前の行数（duplicatesRemoved集計用）
    recallRowsMap,
    supplementedRecalls: supplemented,
    unresolvedRecalls: unresolved,
    excludedUnresolvedRecalls: excluded,
    gtinMissingRecalls: [...gtinMissingRecalls.values()],
    invalidChecksumGtins: [...invalidChecksumGtins.values()],
    ambiguousTypeRecalls: [...ambiguousTypeRecalls],
    recallCount: allRecallIds.size,
  };
}

// CSVインジェクション（Excel等での数式注入）対策。
// セルの先頭が =, +, -, @ や タブ/改行等だと、Excelで開いた際に数式として
// 評価されてしまう場合があるため、先頭にシングルクォートを付与して無害化する
// （PMDA自身の公開CSVでも同様の手法で日付列等をテキスト強制している）。
const FORMULA_TRIGGER_CHARS = /^[=+\-@\t\r]/;
function sanitizeCsvCell(v) {
  const s = String(v);
  return FORMULA_TRIGGER_CHARS.test(s) ? "'" + s : s;
}
function toCsvField(v) {
  return `"${sanitizeCsvCell(v).replace(/"/g, '""')}"`;
}

function writeCsv(filePath, header, rows) {
  const lines = [header.map(toCsvField).join(",")];
  for (const row of rows) lines.push(row.map(toCsvField).join(","));
  fs.writeFileSync(filePath, "\uFEFF" + lines.join("\r\n") + "\r\n", "utf8"); // 先頭にBOMを付与（Excelでの文字コード誤認識対策）
}

// 前回実行時点のスナップショット（history.json）を読み込む。初回実行時は存在しない。
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(OUT_HISTORY, "utf8"));
  } catch {
    return { lastSnapshot: { generatedAt: null, recalls: {} }, removedArchive: {} };
  }
}

// 前回取得時点に対して回収件数が急減していないかを確認する。
// PMDA側の一時的な配信不備（空ファイル・一部クラスのみ欠落等）を、
// 正常な更新として誤って公開してしまうことを防ぐための異常検知。
const ANOMALY_MIN_PREV_COUNT = 5; // これ未満の件数だった場合は変動率が不安定なため判定対象外
const ANOMALY_DROP_RATIO = 0.5; // 前回の何割を下回ったら異常とみなすか

function checkForAnomalousDrop(label, prevCount, newCount) {
  if (prevCount < ANOMALY_MIN_PREV_COUNT) return;
  if (newCount < prevCount * ANOMALY_DROP_RATIO) {
    throw new Error(
      `[異常検知] ${label} の回収件数が前回から急減しました（前回${prevCount}件 → 今回${newCount}件）。` +
      `PMDA側の配信不備の可能性があるため、公開データの更新を中断しました。`
    );
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 異常検知・回収済み検出のため、前回スナップショットを先に読み込んでおく。
  const history = loadHistory();
  const prevRecalls = history.lastSnapshot.recalls || {};
  const prevCountByClass = new Map();
  for (const info of Object.values(prevRecalls)) {
    prevCountByClass.set(info.class, (prevCountByClass.get(info.class) || 0) + 1);
  }

  const allRows = [];
  const summary = [];
  const allRecallRowsMap = new Map(); // 回収番号 -> {recallNo, class, generalName, brandName, rows}
  let rawRowCountTotal = 0; // 各クラスの重複除去前の行数の合計（duplicatesRemoved集計用）

  for (const cls of CLASSES) {
    const result = await processClass(cls);
    checkForAnomalousDrop(cls.label, prevCountByClass.get(cls.label) || 0, result.recallCount);
    allRows.push(...result.outputRows);
    rawRowCountTotal += result.rawRowCount;
    for (const [recallNo, info] of result.recallRowsMap) allRecallRowsMap.set(recallNo, info);
    summary.push({
      class: cls.label,
      recallCount: result.recallCount,
      rowCount: result.outputRows.length,
      supplementedRecalls: result.supplementedRecalls,
      unresolvedRecalls: result.unresolvedRecalls,
      gtinMissingRecalls: result.gtinMissingRecalls,
      invalidChecksumGtins: result.invalidChecksumGtins,
      ambiguousTypeRecalls: result.ambiguousTypeRecalls,
      excludedUnresolvedRecalls: result.excludedUnresolvedRecalls,
    });
    console.log(`[${cls.label}] 回収件数=${result.recallCount} 出力行数=${result.outputRows.length} 自由記述から補完=${result.supplementedRecalls.length}件 未解決=${result.unresolvedRecalls.length}件（除外${result.excludedUnresolvedRecalls.length}件） GTIN未提供=${result.gtinMissingRecalls.length}件 チェックデジット不正GTIN=${result.invalidChecksumGtins.length}件 ロット/シリアル区分推定=${result.ambiguousTypeRecalls.length}件`);
  }

  // 重複行（同一の name/date/GTIN/lot/serial）を除去
  const seen = new Set();
  const dedupedRows = [];
  for (const row of allRows) {
    const key = row.join("\x01") /* 区切り文字に制御文字(SOH)を使い、列の連結による衝突を避ける */;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRows.push(row);
    }
  }

  const header = ["回収番号", "一般的名称及び販売名", "掲載年月日", "回収開始日", "GTIN", "ロット番号", "シリアル番号", "ID/バージョン"];
  writeCsv(OUT_CSV, header, dedupedRows);

  // ---------- 履歴管理：PMDA提供データから消えた（＝回収済みと推定される）回収の検出 ----------
  // history / prevRecalls は異常検知のため main() 冒頭で読み込み済みのものを使う。
  const nowIso = new Date().toISOString();
  if (!history.trackingStartedAt) history.trackingStartedAt = nowIso;

  const currentIds = new Set(allRecallRowsMap.keys());
  const prevIds = Object.keys(prevRecalls);

  let newlyRemovedCount = 0;
  for (const recallNo of prevIds) {
    if (!currentIds.has(recallNo) && !history.removedArchive[recallNo]) {
      history.removedArchive[recallNo] = { ...prevRecalls[recallNo], removedAt: nowIso };
      newlyRemovedCount++;
    }
  }
  // PMDAのデータに再度現れた場合（再掲載等）は、現行データを優先し archive から外す
  for (const recallNo of currentIds) {
    if (history.removedArchive[recallNo]) delete history.removedArchive[recallNo];
  }

  // history.json はGit管理下で毎日コミットされ、クラスIIだけでも数万行規模のデータを
  // 保持するため、年単位で運用するとリポジトリの肥大化につながる。影響を抑えるため、
  // ①recallNoで常に同じ順序に揃えて出力し、PMDA側の返却順の揺れによる無駄な差分を防ぐ、
  // ②内容（recalls）が前回と実質的に変化していない日はgeneratedAtも更新しない（＝ファイル
  //   が1バイトも変わらない）ことで、ワークフロー側の「差分が無ければコミットしない」判定が
  //   正しく働き、無意味な日次コミットが積み重ならないようにする。
  const sortedRecalls = Object.fromEntries(
    [...allRecallRowsMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
  const sortedPrevRecalls = Object.fromEntries(
    Object.entries(prevRecalls).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
  const recallsUnchanged = JSON.stringify(sortedRecalls) === JSON.stringify(sortedPrevRecalls);

  history.lastSnapshot = {
    generatedAt: recallsUnchanged ? history.lastSnapshot.generatedAt : nowIso,
    recalls: sortedRecalls,
  };
  history.removedArchive = Object.fromEntries(
    Object.entries(history.removedArchive).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
  // 整形して保存する（圧縮1行JSONだとgitの行単位マージが効かず、無関係な変更でも
  // 毎回コンフリクトになるため。回収番号単位でキーを分けておけば大抵は自動マージできる）。
  fs.writeFileSync(OUT_HISTORY, JSON.stringify(history, null, 1), "utf8");

  const removedArchiveList = Object.entries(history.removedArchive).map(([recallNo, v]) => ({
    recallNo,
    class: v.class,
    generalName: v.generalName,
    brandName: v.brandName,
    removedAt: v.removedAt,
    rowCount: v.rows.length,
    note: v.note,
  }));

  // ---------- 累積CSV：現行データ＋回収済み（PMDA提供データから削除済み）データ ----------
  const cumulativeHeader = [...header, STATUS_COL];
  const cumulativeRows = [
    ...dedupedRows.map((row) => [...row, STATUS_ACTIVE]),
    ...Object.values(history.removedArchive).flatMap((v) => v.rows.map((row) => [...row, STATUS_REMOVED])),
  ];
  writeCsv(OUT_CUMULATIVE_CSV, cumulativeHeader, cumulativeRows);

  const log = {
    buildLogicVersion: BUILD_LOGIC_VERSION,
    generatedAt: nowIso,
    totalRows: dedupedRows.length,
    // クラス内重複除去（processClass内）＋クラス横断重複除去（本関数内）の合計。
    // rawRowCountTotalは各クラスの重複除去前の行数の合計。
    duplicatesRemoved: rawRowCountTotal - dedupedRows.length,
    nodataMarker: NODATA,
    cumulativeTotalRows: cumulativeRows.length,
    removedArchiveCount: removedArchiveList.length,
    removedArchiveNewThisRun: newlyRemovedCount,
    trackingStartedAt: history.trackingStartedAt,
    removedArchive: removedArchiveList,
    classes: summary,
  };
  fs.writeFileSync(OUT_LOG, JSON.stringify(log, null, 2), "utf8");

  // index.html が file:// でも読み込めるよう、script タグ経由でメタ情報を渡す。
  // meta.jsは<script src="...">で読み込む別ファイルのため、現状"</script>"による
  // インラインスクリプト分断は発生しないが、将来の実装変更（インライン化・innerHTML化）
  // に備えた防御的対策として、"<"をUnicodeエスケープしておく。
  const metaJsBody = "window.PMDA_META = " + JSON.stringify(log, null, 2).replace(/</g, "\\u003c") + ";\n";
  fs.writeFileSync(OUT_META_JS, metaJsBody, "utf8");

  console.log(`\n完了: ${dedupedRows.length}行 -> ${OUT_CSV}`);
  console.log(`累積版: ${cumulativeRows.length}行（回収済み${removedArchiveList.length}件分を含む、うち今回新たに検出${newlyRemovedCount}件） -> ${OUT_CUMULATIVE_CSV}`);
  console.log(`ビルドログ -> ${OUT_LOG}`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
