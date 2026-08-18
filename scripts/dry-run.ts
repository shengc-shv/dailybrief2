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
        // 与 daily.ts 一致：region=gz(招行广州分行辖区) → 广州商机·广州IPO相关；gd(非广州)/nation/无 → 参考区 全国IPO
        const category = item.region === 'gz' ? 'gz' : 'ipo';
        const finalSrcId = category === 'gz' ? srcId.replace(/^gd-/, 'gz-') : srcId;
        articles.push({
          sourceId: finalSrcId,
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
        // category 按注册表路由（gz-gov 已迁入宏观政策·广州政策）
        const regCat = loadAllSources().find(s => s.id === item.sourceId)?.category;
        articles.push({
          sourceId: item.sourceId || 'gz-local',
          source: item.source || '广州商机',
          title: item.title || '无标题',
          url: item.url || '',
          excerpt: item.excerpt || '',
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
          category: regCat ?? 'gz',
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

  // 抓取所有 enabled 数据源（OFFLINE=true 时跳过：纯历史渲染，不访问网络）
  const isOffline = process.env.OFFLINE === 'true';
  if (!isOffline) {
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
  } else {
    console.log(`  ℹ️ OFFLINE 模式：跳过全部网络抓取，仅用本地数据文件 + 历史缓存渲染`);
  }

  // 合并滚动 7 天历史（窗口按信息发生时间 publishedAt 计）：今日抓取 + 历史缓存（按 fetchedToday 打标），
  // 使渲染同时拥有「当天」与「过去7天」两个时间标签。
  const history = loadHistory();
  const nowIso = new Date().toISOString();
  const rolling = buildRolling(articles, history);
  if (isOffline) {
    // 纯历史渲染无今日抓取：把历史缓存中「今天 lastSeenAt」的条目标记为当天（fetchedToday=true），
    // 复刻线上「当天」视图（与 preview-local 的 isToday 逻辑一致）；其余保持历史。
    const today = todayKey();
    let marked = 0;
    for (const a of rolling) {
      if (a.fetchedToday !== true) {
        const e = history[a.url];
        if (e && typeof e.lastSeenAt === 'string' && e.lastSeenAt.startsWith(today)) {
          a.fetchedToday = true;
          marked++;
        }
      }
    }
    console.log(`  ℹ️ OFFLINE：历史缓存中「当天(lastSeenAt=${today})」标记 ${marked} 条`);
  }
  // 非 OFFLINE：dry-run 无 AI，仅更新 lastSeenAt / 保留历史摘要，不覆盖已有摘要。
  // OFFLINE 为纯渲染验证：只读历史缓存，绝不写回（避免空 articles 触发 prune 裁剪历史）。
  if (!isOffline) {
    saveHistory(articles, history, nowIso);
  } else {
    console.log(`  ℹ️ OFFLINE：跳过 saveHistory（不修改历史缓存）`);
  }
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
