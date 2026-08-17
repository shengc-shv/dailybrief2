/**
 * 广东地区企业识别（统一匹配器）
 *
 * 这是「广东企业」判断的单一入口，融合了三层识别，覆盖不同信源的特征：
 *
 *   1) 城市名匹配   —— 文本里出现广东 21 个地级市中英文名（原有逻辑）。
 *      适合：正文/标题直接写了「深圳/广州/Shenzhen…」的信源。
 *   2) 注册表·公司名 —— 文本里出现注册表中的企业名或英文别名（如 "腾讯"/"Tencent"）。
 *      适合：港交所英文公告、国外 RSS 等「只写企业名、不写地点」的信源。
 *   3) 注册表·股票代码 —— 直接拿股票代码命中（如 "00700" → 腾讯，"002594" → 比亚迪）。
 *      适合：沪深北/港交所公告（爬虫能拿到代码，离线秒级，无需联网解析省份）。
 *
 * 单一事实源：lib/sources/guangdong-registry.json（企业名/别名/代码/城市）。
 * 维护方式：编辑该 JSON，或重跑 scripts/seed-guangdong-registry.mjs 重建。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, "guangdong-registry.json");

// 广东（含 21 个地级市）中英文城市名。不含过于宽泛的 "China"。
export const GUANGDONG_KEYWORDS = [
  "广东", "广州", "深圳", "东莞", "佛山", "珠海", "中山", "惠州", "江门", "汕头",
  "湛江", "肇庆", "梅州", "汕尾", "河源", "阳江", "清远", "潮州", "揭阳", "云浮",
  "Guangdong", "Shenzhen", "Guangzhou", "Dongguan", "Foshan", "Zhuhai",
  "Zhongshan", "Huizhou", "Jiangmen", "Shantou", "Zhanjiang", "Zhaoqing",
  "Meizhou", "Shanwei", "Heyuan", "Yangjiang", "Qingyuan", "Chaozhou",
  "Jieyang", "Yunfu",
];

// ---- 加载注册表，构建索引 ----
function loadRegistry() {
  const empty = { companies: [], codeIndex: new Map(), nameIndex: [] };
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.warn("[guangdong] 注册表缺失:", REGISTRY_PATH, "（仅城市名匹配可用）");
    return empty;
  }
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    const companies = Array.isArray(data.companies) ? data.companies : [];
    const codeIndex = new Map(); // 归一化代码 -> 企业
    const nameIndex = []; // { key, company }
    for (const c of companies) {
      for (const code of c.codes || []) {
        codeIndex.set(normalizeCode(code), c);
      }
      for (const n of [c.name, ...(c.aliases || [])]) {
        if (n) nameIndex.push({ key: String(n).toLowerCase(), company: c });
      }
    }
    return { companies, codeIndex, nameIndex };
  } catch (e) {
    console.warn("[guangdong] 注册表解析失败:", e.message, "（仅城市名匹配可用）");
    return empty;
  }
}

/** 归一化股票代码：去非数字 + 去前导零（"00700" 与 "0700.HK" 归为 "700"）。 */
export function normalizeCode(code) {
  const digits = String(code || "").replace(/[^0-9]/g, "");
  return digits.replace(/^0+/, "") || "0";
}

const REG = loadRegistry();

/**
 * 判断一段文本（或给定代码）是否涉及广东地区企业。
 * @param {string} text 待检测文本（标题 + 摘要 + 公司名）
 * @param {{ codes?: string[] }} [opts] 已知股票代码（爬虫可传入，做精确离线匹配）
 * @returns {boolean}
 */
export function isGuangdongEnterprise(text, opts = {}) {
  return matchGuangdong(text, opts).hit;
}

/**
 * 同 isGuangdongEnterprise，但返回命中详情（用于日志/调试）。
 * @returns {{ hit: boolean, company?: object, method?: 'code'|'name'|'city' }}
 */
export function matchGuangdong(text, opts = {}) {
  const codes = opts.codes || [];
  // 层 3：股票代码精确命中（离线）
  for (const code of codes) {
    const c = REG.codeIndex.get(normalizeCode(code));
    if (c) return { hit: true, company: c, method: "code" };
  }
  const lower = (text || "").toLowerCase();
  if (!lower) return { hit: false };
  // 层 2：注册表企业名 / 英文别名命中
  for (const { key, company } of REG.nameIndex) {
    if (lower.includes(key)) return { hit: true, company, method: "name" };
  }
  // 层 1：广东城市名命中
  for (const kw of GUANGDONG_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return { hit: true, method: "city" };
  }
  return { hit: false };
}

/** 按股票代码查注册表企业（找不到返回 undefined）。 */
export function lookupByCode(code) {
  return REG.codeIndex.get(normalizeCode(code));
}

/** 注册表企业总数（调试用）。 */
export function registrySize() {
  return REG.companies.length;
}
