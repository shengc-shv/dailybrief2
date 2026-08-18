import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

/**
 * 国内财经（cn-finance）实时抓取器。
 *
 * 背景：新华社（xinhua-finance）与人民网（people-finance）的 RSS 均已停更——
 * 新华网 `news_finance.xml` 卡在 2022-12，人民网 `finance.xml` 卡在 2025-06，
 * 老的 `rss.xinhuanet.com` 子域直接 502。新华网/新华财经(cnfin.com)主站是
 * Vue SPA，列表走混淆的 axios 接口，无法静态抓取。因此国内财经改用两个仍
 * 服务端渲染、可稳定解析的权威媒体首页：
 *   - 新浪财经滚动新闻（finance.sina.com.cn/roll）—— 市场/公司动态，实时
 *   - 央视财经首页（finance.cctv.com）—— 政策/宏观，实时
 *
 * 两者都返回服务端渲染 HTML，用 curl 抓取后正则提取标题+链接+日期，无需 JS。
 */

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/** 新浪财经滚动新闻：<li><a href="...norm_detail?url=ENCODED">标题</a> */
export async function fetchSinaFinance(
  sourceId: string,
  limit = 25,
): Promise<RawArticle[]> {
  const html = await curlFetch(
    "https://finance.sina.com.cn/roll/index.shtml",
    HEADERS,
  );
  const re = /<li><a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1];
    const title = clean(m[2]);
    if (!href.includes("norm_detail") || !href.includes("url=")) continue;
    const enc = /url=([^&]+)/.exec(href);
    if (!enc) continue;
    let url: string;
    try {
      url = decodeURIComponent(enc[1]);
    } catch {
      continue;
    }
    if (!/20\d{2}-\d{2}-\d{2}/.test(url)) continue; // 只保留带日期的真实文章
    const d = /(\d{4})-(\d{2})-(\d{2})/.exec(url);
    const publishedAt = d
      ? new Date(`${d[1]}-${d[2]}-${d[3]}T08:00:00+08:00`)
      : undefined;
    out.push({ sourceId, title, url, category: "finance", publishedAt });
  }
  return out;
}

/** 央视财经首页：<a href="https://finance.cctv.com/YYYY/MM/DD/....shtml">标题</a> */
export async function fetchCctvFinance(
  sourceId: string,
  limit = 25,
): Promise<RawArticle[]> {
  const html = await curlFetch("https://finance.cctv.com/", HEADERS);
  const re =
    /<a[^>]+href="(https?:\/\/finance\.cctv\.com\/[^\"]+\.shtml)"[^>]*>([^<]{4,60})<\/a>/g;
  const seen = new Set<string>();
  const out: RawArticle[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const url = m[1];
    const title = clean(m[2]);
    if (seen.has(url)) continue;
    if (/VIDE[A-Za-z0-9]/.test(url)) continue; // 视频专题，非新闻
    if (/index\.shtml|node_|\/2012\/|\/2013\//.test(url)) continue; // 导航/旧栏
    seen.add(url);
    const d = /(\d{4})\/(\d{2})\/(\d{2})/.exec(url);
    const publishedAt = d
      ? new Date(`${d[1]}-${d[2]}-${d[3]}T08:00:00+08:00`)
      : undefined;
    out.push({ sourceId, title, url, category: "finance", publishedAt });
  }
  return out;
}
