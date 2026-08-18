import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

/**
 * 中国政府网（gov.cn）· 国务院政策文件 —— 国家级宏观政策权威源
 *
 * 背景：用户要求补国家级权威源（央行/金监总局/统计局官网均为 JS/模板渲染，
 * 静态不可抓）。中国政府网「最新政策」列表（/zhengce/）为服务端渲染：
 *   <li><a href=".../zhengce/content/202608/content_7078320.htm">标题</a><span>2026-08-17</span></li>
 * 标题 + 链接 + 日期齐全，可稳定解析。
 *
 * 央行/金监总局/统计局 的权威动态由新浪财经/央视财经（媒体解读）在同子标签覆盖。
 */

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function parseDate(s: string): Date | undefined {
  const m = String(s || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return undefined;
  // 日期级：UTC 零点（北京时间 08:00 显示，与国内财经一致）
  return new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00.000Z`);
}

export async function fetchGovCnPolicy(
  sourceId: string,
  limit = 25,
): Promise<RawArticle[]> {
  const html = await curlFetch("https://www.gov.cn/zhengce/", HEADERS);
  // 匹配 li 条目：<a href="...content_xxx.htm">标题</a> <span>2026-08-17</span>
  const re =
    /<li>\s*<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>\s*<span>\s*([^<]+?)\s*<\/span>/g;
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1];
    const title = clean(m[2]);
    const dateStr = m[3];
    if (!/content_\d+\.htm/.test(href) || title.length < 8) continue;
    const url = href.startsWith("http") ? href : `https://www.gov.cn${href.replace(/^\.\//, "/")}`;
    const publishedAt = parseDate(dateStr);
    out.push({
      sourceId,
      title,
      url,
      excerpt: `【国务院政策】${title}`,
      ...(publishedAt ? { publishedAt } : {}),
      category: "finance",
    });
  }
  return out;
}
