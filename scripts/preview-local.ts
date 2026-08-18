import fs from "node:fs";
import path from "node:path";
import { sources } from "../lib/sources/registry";
import { groupRaw, renderHtml } from "../lib/output/render";

const DATE = "2026-08-18";

// 真实报告（含 trading 板块等），与线上一致
const report = JSON.parse(
  fs.readFileSync(path.join("2026-08-18", `${DATE}.json`), "utf8"),
);

// rolling 列表 = 近30天滚动历史缓存（daily.ts 的 buildRolling 就是 今日抓取 + history）。
// 新浪财经/央视财经是实时抓取进 rolling 的，而它们已落在 article-history.json 里，
// 所以直接以 history 作为 rolling 源即可复刻线上（国内财经因而有内容）。
const histRaw = JSON.parse(fs.readFileSync("data/article-history.json", "utf8"));
const hist = Array.isArray(histRaw) ? histRaw : Object.values(histRaw);

// 线上"今天/过去7天"时间 tab 完全依赖 a.fetchedToday 字段；历史缓存条目没有该字段，
// 会被 filterByTime 全部当"过去"过滤掉 → 财经"今天"视图显示"该源今日无内容"。
// 复刻线上：把"今天(本日报日期)看到"的条目标记为 fetchedToday=true（取 firstSeenAt/
// lastSeenAt/publishedAt 任一为当日即可），其余保持 false 进"过去7天"tab。
function isToday(x: any): boolean {
  for (const k of ["firstSeenAt", "lastSeenAt", "publishedAt"]) {
    const v = x[k];
    if (typeof v === "string" && v.startsWith(DATE)) return true;
  }
  return false;
}

type AnyArt = Record<string, any>;
const rolling: AnyArt[] = (hist as AnyArt[]).map((x) => ({
  sourceId: x.sourceId,
  source: x.source,
  title: x.title,
  url: x.url,
  excerpt: x.excerpt || "",
  publishedAt: x.publishedAt ? new Date(x.publishedAt) : new Date(),
  category: x.category,
  subcategory: x.subcategory,
  summary: x.summary || "",
  fetchedToday: isToday(x),
}));

// 合并爬虫 IPO 数据（region 分流），与 daily.ts 逻辑一致。
// 爬虫产物是"今天抓取"→ fetchedToday:true（进"当天"视图）。
const crawlerPath = "data/crawled-articles.json";
if (fs.existsSync(crawlerPath)) {
  const items = JSON.parse(fs.readFileSync(crawlerPath, "utf8"));
  const seen = new Set(rolling.map((r) => r.url));
  let added = 0;
  for (const item of items as AnyArt[]) {
    if (seen.has(item.url)) continue;
    const region = item.region === "gz" ? "gz" : "ipo";
    const finalSrcId = region === "gz" ? (item.sourceId || "").replace(/^gd-/, "gz-") : item.sourceId;
    rolling.push({
      sourceId: finalSrcId || "gd-local-scraper",
      source: item.source || "广东本地爬虫",
      title: item.title || "无标题",
      url: item.url || "",
      excerpt: item.excerpt || "",
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
      category: region,
      subcategory: undefined,
      summary: item.summary || "",
      fetchedToday: true,
    });
    added++;
  }
  console.log(`[preview] 合并爬虫数据 ${added} 条`);
}

// 合并广州商机爬虫数据（category=gz，子标签由注册表 subcatOf 路由），当天抓取 → fetchedToday:true
const gzPath = "data/crawled-gz.json";
if (fs.existsSync(gzPath)) {
  const items = JSON.parse(fs.readFileSync(gzPath, "utf8"));
  const seen = new Set(rolling.map((r) => r.url));
  let added = 0;
  for (const item of items as AnyArt[]) {
    if (seen.has(item.url)) continue;
    // category 按注册表路由（gz-gov 已迁入宏观政策·广州政策）
    const regCat = (sources as any[]).find((s) => s.id === item.sourceId)?.category;
    rolling.push({
      sourceId: item.sourceId || "gz-local",
      source: item.source || "广州商机",
      title: item.title || "无标题",
      url: item.url || "",
      excerpt: item.excerpt || "",
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
      category: regCat ?? "gz",
      subcategory: undefined,
      summary: item.summary || "",
      fetchedToday: true,
    });
    added++;
  }
  console.log(`[preview] 合并广州商机数据 ${added} 条`);
}

const raw = groupRaw(rolling as any, sources as any);
const html = renderHtml(report, raw as any, DATE);
fs.writeFileSync(path.join("2026-08-18", "preview.html"), html, "utf8");
console.log(`[preview] 已写入 2026-08-18/preview.html，rolling=${rolling.length} 条`);
