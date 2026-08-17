/**
 * 一次性预览渲染：完全使用本地已预加载的数据（data/article-history.json 中
 * 已写入的 AI 摘要）生成报告页面，**不调用任何 AI、不联网抓取**。
 *
 * 用途：把"预加载清单"的效果直接渲染成项目同款 HTML，供预览与发布。
 * 渲染逻辑复用项目的 render.ts（renderHtml / renderMarkdown），保证样式与
 * 正式 daily 流程一致。
 */
import fs from "node:fs";
import path from "node:path";

import { sources, loadAllSources } from "../lib/sources/registry";
import { loadHistory } from "../lib/output/history";
import { groupRaw, renderHtml, renderMarkdown } from "../lib/output/render";
import { todayKey } from "../lib/utils";
import type { ArticleInput, BriefItem, DailyReport } from "../lib/ai/pipeline";

const OUTPUT_DIR = "daily_reports";

function main() {
  const date = todayKey();
  const history = loadHistory();
  const today = date; // "2026-08-17"

  // 1) 由本地历史构建文章列表；当天/过去30天 按 lastSeenAt 是否属于今天区分。
  const articles: ArticleInput[] = [];
  let withSummary = 0;
  for (const e of Object.values(history)) {
    const fetchedToday = !!e.lastSeenAt && e.lastSeenAt.startsWith(today);
    if (e.summary) withSummary++;
    articles.push({
      sourceId: e.sourceId,
      title: e.title,
      url: e.url,
      excerpt: e.excerpt,
      publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
      category: e.category,
      summary: e.summary,
      source: e.source,
      fetchedToday,
    });
  }
  console.log(
    `📊 本地历史 ${Object.keys(history).length} 条 ｜ 其中含 AI 摘要 ${withSummary} 条 ｜ 渲染文章 ${articles.length} 条`,
  );

  // 2) 复用项目分组逻辑（含 当天/过去30天 时间拆分、L2/L3 标签）。
  const raw = groupRaw(articles, loadAllSources());

  // 3) 由预加载摘要构建 digest（按分类聚合，按 importance 排序取 top-N）。
  //    注：renderHtml 仅用 report.trading，digest 主要供 renderMarkdown 展示。
  const briefsByCat: Record<string, BriefItem[]> = {
    tech: [],
    finance: [],
    politics: [],
    "gd-ipo": [],
  };
  for (const e of Object.values(history)) {
    if (!e.summary) continue;
    const cat = e.category;
    if (!briefsByCat[cat]) continue;
    briefsByCat[cat].push({
      title: e.title,
      url: e.url,
      source: e.source,
      summary: e.summary,
      importance: (e as Record<string, unknown>).importance as number | undefined ?? 6,
    });
  }
  const CAP: Record<string, number> = { tech: 18, finance: 18, politics: 10, "gd-ipo": 25 };
  const report: DailyReport = {
    hero_headline: "",
    daily_overview: "",
    tech_briefs: briefsByCat.tech.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, CAP.tech),
    finance_briefs: briefsByCat.finance.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, CAP.finance),
    politics_briefs: briefsByCat.politics.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, CAP.politics),
    gd_ipo_briefs: briefsByCat["gd-ipo"].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, CAP["gd-ipo"]),
    editor_note: "",
    keywords: [],
  };

  // 4) 渲染 HTML（项目同款）。
  const html = renderHtml(report, raw, date);
  const md = renderMarkdown(report, date);

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  fs.writeFileSync(path.join(dateDir, `${date}.html`), html, "utf8");
  fs.writeFileSync(path.join(dateDir, `${date}.md`), md, "utf8");
  console.log(`✅ 报告已生成: ${path.join(dateDir, date)}.html`);
  console.log(`✅ Markdown 摘要已生成: ${path.join(dateDir, date)}.md`);
}

main();
