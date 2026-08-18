/**
 * 广州商机抓取 - 共享解析工具
 *
 * 政府网站列表页结构基本一致（<li> 或 <ul> 内 <a href=".../content/post_xxx.html" title="标题">），
 * 这里用「宽容扫描」：匹配所有 content/post_*.html 链接，标题取 title 属性（权威）或标签文本，
 * 日期从链接前 400 字符上下文里找 YYYY-MM-DD，找不到就留空（上游 fallback）。
 */

/** 剥离 HTML 标签 + 空白 */
function strip(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把日期字符串归一成 ISO（日期级 -> UTC 零点，避免时区偏移） */
function dateToIso(s) {
  const m = String(s || '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00.000Z`;
}

/**
 * 解析政府列表页 HTML
 * @param {string} html
 * @param {{minLen?: number, lookback?: number, maxItems?: number}} opts
 * @returns {Array<{title:string,url:string,excerpt:string,publishedAt?:string}>}
 */
export function parseGovList(html, opts = {}) {
  const { minLen = 8, lookback = 400, maxItems = 60 } = opts;
  const articles = [];
  // 匹配 <a> 整标签：捕获 attrs（含 href/title）+ 内部文本。title 取开标签属性（权威，避免"有效"等状态文本混入）
  const aRe = /<a([^>]+)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = aRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const href = (attrs.match(/href=["']([^"']*)["']/) || [])[1];
    if (!href || !/post_\d+\.html/.test(href)) continue;
    const titleAttr = (attrs.match(/title=["']([^"']*)["']/) || [])[1];
    const text = strip(inner);
    const title = titleAttr || text;
    if (!title || title.length < minLen || title.length > 200) continue;

    // 从链接前 lookback 字符里找最近日期
    const ctx = html.slice(Math.max(0, m.index - lookback), m.index + 120);
    const dates = ctx.match(/20\d\d[-/]\d{1,2}[-/]\d{1,2}/g);
    const publishedAt = dates ? dateToIso(dates[dates.length - 1]) : undefined;

    articles.push({
      title,
      url: href,
      excerpt: '',
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (articles.length >= maxItems) break;
  }
  return articles;
}

/** 把相对链接拼成绝对 URL */
export function absUrl(href, base) {
  if (!href) return href;
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}
