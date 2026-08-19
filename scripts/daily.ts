import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, loadAllSources, REPORT_LOCALE } from "../lib/sources/registry";
import type { Category } from "../lib/sources/types";
import { fetchSource } from "../lib/sources/dispatch";
import {
  type ArticleInput,
  type BriefItem,
  type DailyReport,
} from "../lib/ai/pipeline";
import { getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
  enrichTrendingPapersSummaries,
  enrichXViralSummaries,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  MERGE_PER_SOURCE_CAP,
  SOURCE_DISPLAY_LIMITS,
  renderHtml,
  renderMarkdown,
  type RawByCategory,
} from "../lib/output/render";
import {
  loadHistory,
  buildRolling,
  saveHistory,
  type HistoryStore,
} from "../lib/output/history";
import { analyzeWatchlist } from "../lib/trading/runner";
import { classifyItemsWithLlm } from "../lib/ai/item-classifier";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import { generateExecutiveSummary } from "../lib/ai/executive-summary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

/**
 * Rolling 30-day article history + AI-summary cache. Loaded once in main(),
 * read by every `enrich*` helper (to skip LLM calls for already-analyzed
 * URLs), and rewritten at the end of the run.
 */
let history: HistoryStore = {};

/**
 * Reuse previously-generated AI summaries from the history so we don't pay
 * to re-analyze the same URL. Returns the subset that still needs analysis.
 */
function applyCache(items: ArticleInput[]): ArticleInput[] {
  const pending: ArticleInput[] = [];
  for (const a of items) {
    const cached = history[a.url]?.summary;
    if (cached) {
      a.summary = cached;
    } else {
      pending.push(a);
    }
  }
  return pending;
}

async function fetchAll(): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
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
  return articles;
}

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  // Only the final displayed slice — matches SOURCE_DISPLAY_LIMITS["tech:github-trending"].
  const gh = articles
    .filter((a) => a.sourceId === "github-trending")
    .slice(0, SOURCE_DISPLAY_LIMITS["tech:github-trending"] ?? 20);
  if (gh.length === 0) return;
  const pending = applyCache(gh);
  if (pending.length === 0) {
    console.log(`[daily] enriching GitHub Trending: ${gh.length} 条全部命中历史缓存，跳过 LLM`);
    return;
  }
  console.log(
    `[daily] enriching ${pending.length}/${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(pending);
  for (const a of pending) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
  );
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news");
}

async function enrichPolitics(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "politics", "world");
}

async function enrichAiNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "ai-news");
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[]): Promise<void> {
  const xPosts = articles
    .filter((a) => a.sourceId === "attentionvc-ai")
    .slice(0, SOURCE_DISPLAY_LIMITS["tech:x-viral"] ?? 5);
  if (xPosts.length === 0) return;
  const pending = applyCache(xPosts);
  if (pending.length === 0) {
    console.log(`[daily] enriching X 推文: ${xPosts.length} 条全部命中历史缓存，跳过 LLM`);
    return;
  }
  console.log(`[daily] enriching ${pending.length}/${xPosts.length} X posts with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  // Author handle is encoded in the URL (https://x.com/{handle}/status/{id})
  // — extract it to help the model identify whose claim it is.
  const summaries = await enrichXViralSummaries(
    pending.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      author: a.url.match(/x\.com\/([^/]+)\//)?.[1] ?? "",
    })),
  );
  for (const a of pending) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
  );
}

/**
 * Trending papers enrichment — preserves the fetcher's upvote-desc order
 * (huggingface-papers is in PRESERVE_FETCH_ORDER_SOURCES) and caps to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:trending-papers"]).
 */
async function enrichTrendingPapers(articles: ArticleInput[]): Promise<void> {
  const papers = articles
    .filter((a) => a.sourceId === "huggingface-papers")
    .slice(0, SOURCE_DISPLAY_LIMITS["tech:trending-papers"] ?? 5);
  if (papers.length === 0) return;
  const pending = applyCache(papers);
  if (pending.length === 0) {
    console.log(`[daily] enriching 热门论文: ${papers.length} 条全部命中历史缓存，跳过 LLM`);
    return;
  }
  console.log(
    `[daily] enriching ${pending.length}/${papers.length} trending papers with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichTrendingPapersSummaries(
    pending.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt })),
  );
  for (const a of pending) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
  );
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics",
  subcategory: string,
): Promise<void> {
  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  const perCap = MERGE_PER_SOURCE_CAP[`${category}:${subcategory}`];
  // Mirror render.ts groupRaw EXACTLY: cap each source to perCap (so one
  // fresh source can't flood the whole merged timeline), concat, then take
  // the top-N by date. This keeps AI enrichment scoped to the FINAL displayed
  // items only — no LLM spend on items the reader will never see.
  const perSourceItems: ArticleInput[] = [];
  for (const s of subSources) {
    const srcItems = articles
      .filter((a) => a.sourceId === s.id)
      .filter((a) => category !== "politics" || !isSportsArticle(a.title))
      .sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      );
    perSourceItems.push(...(perCap ? srcItems.slice(0, perCap) : srcItems));
  }
  const top = perSourceItems
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  const toEnrich = top.filter((a) => !sameLocaleIds.has(a.sourceId));
  const pending = applyCache(toEnrich);
  if (pending.length === 0) {
    console.log(
      `[daily] enriching ${category}:${subcategory}: ${toEnrich.length} 条全部命中历史缓存，跳过 LLM`,
    );
    return;
  }
  console.log(
    `[daily] enriching ${pending.length}/${toEnrich.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(pending);
  for (const a of pending) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
  );
}

/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;
  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Cheap, AI-free DailyReport builder used once the per-item summaries are
 * attached (and the market/trading section, if any, is ready).
 *
 * This REPLACES the old `generateDailyReport` cross-category LLM digest:
 * we no longer spend a large Sonnet call re-synthesizing items that were
 * already summarized one-by-one. The digest now just mirrors the FINAL
 * displayed sets (grouped by category) using each article's own summary /
 * excerpt, so the markdown export stays useful at zero extra token cost.
 * (The HTML site never rendered the digest anyway.)
 */
function buildReportFromRaw(raw: RawByCategory): DailyReport {
  const flatten = (cat: Category): ArticleInput[] =>
    (raw[cat] ?? []).flatMap((sg) => sg.sources.flatMap((s) => s.items));
  const toBrief = (a: ArticleInput): BriefItem => ({
    title: a.title,
    url: a.url,
    source: a.source,
    summary: a.summary || a.excerpt || "",
    importance: 1,
  });
  return {
    hero_headline: "",
    daily_overview: "",
    tech_briefs: flatten("tech").slice(0, 5).map(toBrief),
    finance_briefs: flatten("finance").slice(0, 5).map(toBrief),
    politics_briefs: flatten("politics").slice(0, 3).map(toBrief),
    gd_ipo_briefs: [...flatten("gd-ipo"), ...flatten("ipo")].slice(0, 20).map(toBrief),
    editor_note: "",
    keywords: [],
  };
}

async function main() {
  // Fail fast on misconfigured backend before we spend 30s fetching
  // 500+ articles only to discover the LLM has no credentials.
  validateBackendCredentials();

  // 加载滚动 30 天历史（含已解读的 AI 摘要缓存），供富集去重 + 过去30天 tab 使用。
  history = loadHistory();
  console.log(`[daily] 已加载历史缓存: ${Object.keys(history).length} 条（来自 data/article-history.json）`);

  const date = todayKey();
  console.log(`[daily] ${date} — fetching sources…\n`);
  const articles = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}`);

  const dataPath = path.resolve(process.cwd(), 'data/crawled-articles.json');
  if (fs.existsSync(dataPath)) {
    try {
      const raw = fs.readFileSync(dataPath, 'utf8');
      const items = JSON.parse(raw);
      let count = 0;
      for (const item of items) {
        // 跳过已存在的（按 URL 去重）
        const exists = articles.some(a => a.url === item.url);
        if (exists) continue;
        // 每条爬虫结果自带 sourceId（gd-szse/gd-sse/gd-bse/gd-hkex/gd-em-ipo 等）。
        // 按 region 三分：gz(招行广州分行辖区=市区/南沙/湛江/清远) → 广州商机·广州IPO相关，
        // gd(广东非广州) / nation(全国) / 无标记 → 参考区 全国IPO/新股。
        const srcId = item.sourceId || 'gd-local-scraper';
        const region = item.region === 'gz' ? 'gz' : 'ipo';
        // 广州辖区条目的 sourceId 改 gz- 前缀（gd-sse→gz-sse），供注册表 subcatOf 路由到「广州IPO相关」
        const finalSrcId = region === 'gz' ? srcId.replace(/^gd-/, 'gz-') : srcId;
        articles.push({
          sourceId: finalSrcId,
          source: item.source || '广东本地爬虫',
          title: item.title || '无标题',
          url: item.url || '',
          excerpt: item.excerpt || '',
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
          category: region,
          summary: item.summary || '',
        });
        count++;
      }
      console.log(`[daily] ✅ 加载爬虫数据 ${count} 条（跳过 ${items.length - count} 条重复）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[daily] ⚠️ 加载爬虫数据失败: ${msg}`);
    }
  } else {
    console.log(`[daily] ℹ️ 爬虫数据文件不存在: ${dataPath}`);
  }

  // 广州商机爬虫数据（统计局/市政府/南沙）。独立文件，由 scripts/crawlers/run-gz.mjs 产出。
  // 注意：走「今日抓取」数组 → buildRolling 自动打 fetchedToday=true（当天）；
  // 次日经 saveHistory 进入历史缓存后 fetchedToday 自动为 false（过去7天）。当天/历史严格区分。
  const gzPath = path.resolve(process.cwd(), 'data/crawled-gz.json');
  if (fs.existsSync(gzPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(gzPath, 'utf8'));
      let count = 0;
      for (const item of raw) {
        const exists = articles.some(a => a.url === item.url);
        if (exists) continue;
        // category 按注册表路由（gz-gov 已迁入宏观政策·广州政策，其余归广州商机）
        const regCat = loadAllSources().find(s => s.id === item.sourceId)?.category;
        articles.push({
          sourceId: item.sourceId || 'gz-local',
          source: item.source || '广州商机',
          title: item.title || '无标题',
          url: item.url || '',
          excerpt: item.excerpt || '',
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
          category: regCat ?? 'gz',
          summary: item.summary || '',
        });
        count++;
      }
      console.log(`[daily] ✅ 加载广州商机数据 ${count} 条（跳过 ${raw.length - count} 条重复）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[daily] ⚠️ 加载广州商机数据失败: ${msg}`);
    }
  } else {
    console.log(`[daily] ℹ️ 广州商机数据文件不存在: ${gzPath}`);
  }
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }
  
  // Enrich tech / politics subgroups with summaries (tech/politics 不参与银行相关分类，
  // 走各自专属摘要 prompt)。finance 不再单独 enrich——其摘要+分类统一由下方
  // classifyItemsWithLlm 一次批量调用完成（中文/英文源全覆盖，省一次重复调用）。
  await enrichGhTrending(articles);
  await enrichTrendingPapers(articles);
  await enrichPolitics(articles);
  await enrichAiNews(articles);
  await enrichXViral(articles);
  
  // ===== 为 gd-ipo / 全国ipo 数据生成中文摘要（复用历史缓存去重）=====
  const gdIpoArticles = articles.filter(a => a.category === 'gd-ipo' || a.category === 'ipo');
  if (gdIpoArticles.length > 0) {
    const pending = applyCache(gdIpoArticles);
    if (pending.length === 0) {
      console.log(`[daily] enriching gd-ipo+ipo: ${gdIpoArticles.length} 条全部命中历史缓存，跳过 LLM`);
    } else {
      console.log(`[daily] enriching ${pending.length}/${gdIpoArticles.length} gd-ipo+ipo items with ${REPORT_LOCALE} summaries…`);
      const t0 = Date.now();
      const summaries = await enrichFinanceNewsSummaries(pending);
      for (const a of pending) {
        const s = summaries.get(a.url);
        if (s) a.summary = s;
      }
      console.log(
        `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${pending.length}`,
      );
    }
  }
  // Trading signals: Yahoo fetch + indicators + commentary. Non-fatal —
  // if it errors, we still ship the news digest.
  let trading: TradingSection | null = null;
  try {
    trading = await runTrading();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] trading section failed: ${msg}`);
  }

  // 条目级 LLM 分类：对**所有类别**的「全新条目」（历史库未命中）做 AI 分析，
  // 由 AI 决定进入哪个子标签(subcategory) + 写银行视角摘要(summary) + 银行相关性(relevant)。
  // 这是用户设计核心：所有信息都经 AI 打标，不依赖源配置的硬编码子类。
  // - gz/finance：AI 判银行相关性(relevant) + 业务线子标签(gz-*/cn-* 等)。
  // - tech/ipo/gd-ipo/politics 等参考区：relevant 固定 true（不按银行相关性过滤），
  //   AI 仅决定 subcategory（各自标签体系，见 item-classifier 的 RULES）。
  // - gd-ipo 渲染路由最终由三道闸区域分类器(classifyGdIpo)裁定，此处 AI 标注仅作初步。
  // 摘要：gz/finance 无独立 enrich，由本分类器输出 summary；tech/ipo/gd-ipo 已有各自 enrich
  // 摘要，循环中仅在条目确实无摘要时(!a.summary)用分类器摘要兜底，避免覆盖。
  // 历史命中(已分析过)一律跳过，绝不复选。
  // 失败（如 LLM 余额不足）→ 自动跳过，降级到启发式/注册表分类，绝不影响主流程。
  const classifyPending = articles.filter((a) => !history[a.url]);
  if (classifyPending.length > 0) {
    console.log(`[daily] classifying ${classifyPending.length} new items (LLM per-item tag)…`);
    try {
      const cls = await classifyItemsWithLlm(
        classifyPending.map((a) => ({ url: a.url, title: a.title, source: a.source, category: a.category })),
      );
      let tagged = 0;
      for (const a of classifyPending) {
        const r = cls.get(a.url);
        if (r) {
          a.subcategory = r.subcategory || a.subcategory;
          a.relevant = r.relevant;
          if (r.summary && r.summary.length > 10 && !a.summary) a.summary = r.summary;
          tagged++;
        }
      }
      console.log(`[daily] item classification done: ${tagged}/${classifyPending.length} tagged`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[daily] item classification skipped (${msg}) — falling back to heuristic/registry`);
    }
  }

  // 回写历史缓存（含今日 AI 摘要），并构建「当天 + 过去30天」滚动列表用于渲染。
  const nowIso = new Date().toISOString();
  history = saveHistory(articles, history, nowIso);
  const rolling = buildRolling(articles, history);
  console.log(
    `[daily] 历史缓存已更新: ${Object.keys(history).length} 条（含今日 ${articles.length} 条）；渲染滚动列表 ${rolling.length} 条`,
  );

  // 组装最终报告：仅用「最终展示数据」的摘要（不调用 AI）。
  // 旧逻辑会再发一次大 LLM 请求做跨分类摘要（generateDailyReport），现已移除以省钱。
  const raw = groupRaw(rolling, sources);
  const report = buildReportFromRaw(raw);
  if (trading) report.trading = trading;

  // ===== 执行摘要 / 商机提示（每天一次 LLM 调用；失败不崩、页面不渲染该板块）=====
  try {
    const flat = (cat: Category) =>
      (raw[cat] ?? [])
        .flatMap((sg) => sg.sources.flatMap((s) => s.items))
        .slice(0, 12)
        .map((a) => ({ title: a.title, summary: a.summary, subcategory: a.subcategory }));
    const execSummary = await generateExecutiveSummary({
      date,
      finance: flat("finance"),
      gz: flat("gz"),
      marketOverview: trading?.market_overview,
    });
    if (execSummary) {
      report.executive_summary = execSummary;
      console.log(
        `[daily] 执行摘要已生成: 必读 ${execSummary.must_read.length} 条 / 商机提示 ${execSummary.insights.length} 条`,
      );
    } else {
      console.warn("[daily] 执行摘要生成失败（LLM 不可用或解析失败），跳过该板块");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] 执行摘要生成异常（${msg}），跳过该板块`);
  }

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with the rolling article list (today + past-30d) + LLM-attached
  // summary, so scripts/render.ts can rebuild HTML/MD for UI iteration
  // without re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles: rolling }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[daily] FAILED:`, e);
    process.exit(1);
  });
