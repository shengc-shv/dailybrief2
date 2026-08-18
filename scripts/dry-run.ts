import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, loadAllSources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import type { ArticleInput } from "../lib/ai/pipeline";
import { groupRaw, renderHtml } from "../lib/output/render";
import { loadHistory, buildRolling, saveHistory } from "../lib/output/history";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

// 生成一个空报告（不调用 AI）
function generateEmptyReport(articles: ArticleInput[]) {
  const techArticles = articles.filter(a => a.category === 'tech');
  const financeArticles = articles.filter(a => a.category === 'finance');
  const politicsArticles = articles.filter(a => a.category === 'politics');
  const gdIpoArticles = articles.filter(a => a.category === 'gd-ipo' || a.category === 'ipo');

  return {
    hero_headline: "",
    daily_overview: "",
    tech_briefs: techArticles.slice(0, 5).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source,
      summary: a.summary || a.excerpt || "",
      importance: 1,
    })),
    finance_briefs: financeArticles.slice(0, 5).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source,
      summary: a.summary || a.excerpt || "",
      importance: 1,
    })),
    politics_briefs: politicsArticles.slice(0, 3).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source,
      summary: a.summary || a.excerpt || "",
      importance: 1,
    })),
    gd_ipo_briefs: gdIpoArticles.slice(0, 20).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source,
      summary: a.summary || a.excerpt || "",
      importance: 1,
    })),
    editor_note: "",
    keywords: [],
  };
}

async function main() {
  console.log("🚀 Dry-run 模式（无 AI）开始...\n");

  const date = todayKey();
  const articles: ArticleInput[] = [];

  // ----- 加载本地爬虫数据（广东IPO）-----
  const dataPath = path.resolve(process.cwd(), 'data/crawled-articles.json');
  if (fs.existsSync(dataPath)) {
    try {
      const raw = fs.readFileSync(dataPath, 'utf8');
      const items = JSON.parse(raw);
      let count = 0;
      for (const item of items) {
        const exists = articles.some(a => a.url === item.url);
        if (exists) continue;
        const srcId = item.sourceId || 'gd-local-scraper';
        // 与 daily.ts 一致：region=nation 进「全国IPO/新股」，其余进「广东地区IPO」
        const category = item.region === 'nation' ? 'ipo' : 'gd-ipo';
        articles.push({
          sourceId: srcId,
          source: item.source || '广东本地爬虫',
          title: item.title || '无标题',
          url: item.url || '',
          excerpt: item.excerpt || '',
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
          category,
          summary: item.summary || '',
        });
        count++;
      }
      console.log(`  ✅ 加载爬虫数据 ${count} 条（跳过 ${items.length - count} 条重复）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ 加载爬虫数据失败: ${msg}`);
    }
  } else {
    console.log(`  ℹ️ 爬虫数据文件不存在: ${dataPath}`);
  }

  // ----- 加载广州商机爬虫数据（统计局/市政府/南沙）-----
  // 走「今日抓取」数组：buildRolling 自动打 fetchedToday=true（当天）；
  // 历史回写后次日 fetchedToday=false（过去7天），当天/历史严格区分。
  const gzPath = path.resolve(process.cwd(), 'data/crawled-gz.json');
  if (fs.existsSync(gzPath)) {
    try {
      const items = JSON.parse(fs.readFileSync(gzPath, 'utf8'));
      let count = 0;
      for (const item of items) {
        const exists = articles.some(a => a.url === item.url);
        if (exists) continue;
        articles.push({
          sourceId: item.sourceId || 'gz-local',
          source: item.source || '广州商机',
          title: item.title || '无标题',
          url: item.url || '',
          excerpt: item.excerpt || '',
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
          category: 'gz',
          summary: item.summary || '',
        });
        count++;
      }
      console.log(`  ✅ 加载广州商机数据 ${count} 条（跳过 ${items.length - count} 条重复）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ 加载广州商机数据失败: ${msg}`);
    }
  } else {
    console.log(`  ℹ️ 广州商机数据文件不存在: ${gzPath}`);
  }

  // 抓取所有 enabled 数据源
  const enabled = sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
  }

  // 合并滚动 7 天历史（窗口按信息发生时间 publishedAt 计）：今日抓取 + 历史缓存（按 fetchedToday 打标），
  // 使渲染同时拥有「当天」与「过去7天」两个时间标签。
  const history = loadHistory();
  const nowIso = new Date().toISOString();
  const rolling = buildRolling(articles, history);
  // dry-run 无 AI：仅更新 lastSeenAt / 保留历史摘要，不覆盖已有摘要。
  saveHistory(articles, history, nowIso);
  console.log(`\n📊 总文章数(今日): ${articles.length} ｜ 滚动列表(含过去7天): ${rolling.length} ｜ 历史缓存: ${Object.keys(history).length} 条`);

  // 统计各分类数量
  const catCount: Record<string, number> = {};
  for (const a of articles) {
    catCount[a.category] = (catCount[a.category] || 0) + 1;
  }
  console.log(`📈 分类统计:`, catCount);

  // ----- 渲染 HTML（无 AI）-----
  console.log(`\n🎨 渲染 HTML 报告 (${date})...`);
  const raw = groupRaw(rolling, sources);
  
  // 生成空报告（不含 AI 摘要）
  const report = generateEmptyReport(rolling);
  
  const html = renderHtml(report, raw, date);

  // 写入文件
  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  fs.writeFileSync(`${base}.html`, html, "utf8");
  console.log(`✅ 报告已生成: ${base}.html`);

  console.log(`\n📝 前 10 条文章:`);
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title?.slice(0, 50)}`);
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
