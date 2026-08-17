import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, loadAllSources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import type { ArticleInput } from "../lib/ai/pipeline";
import { groupRaw, renderHtml } from "../lib/output/render";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

// 生成一个空报告（不调用 AI）
function generateEmptyReport(articles: ArticleInput[]) {
  const techArticles = articles.filter(a => a.category === 'tech');
  const financeArticles = articles.filter(a => a.category === 'finance');
  const politicsArticles = articles.filter(a => a.category === 'politics');
  const gdIpoArticles = articles.filter(a => a.category === 'gd-ipo');

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
        articles.push({
          sourceId: srcId,
          source: item.source || '广东本地爬虫',
          title: item.title || '无标题',
          url: item.url || '',
          excerpt: item.excerpt || '',
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
          category: 'gd-ipo',
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

  console.log(`\n📊 总文章数: ${articles.length}`);

  // 统计各分类数量
  const catCount: Record<string, number> = {};
  for (const a of articles) {
    catCount[a.category] = (catCount[a.category] || 0) + 1;
  }
  console.log(`📈 分类统计:`, catCount);

  // ----- 渲染 HTML（无 AI）-----
  console.log(`\n🎨 渲染 HTML 报告 (${date})...`);
  const raw = groupRaw(articles, sources);
  
  // 生成空报告（不含 AI 摘要）
  const report = generateEmptyReport(articles);
  
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
