import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import {
  generateDailyReport,
  type ArticleInput,
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
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import {
  loadHistory,
  buildRolling,
  saveHistory,
  type HistoryStore,
} from "../lib/output/history";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
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
  const gh = articles.filter((a) => a.sourceId === "github-trending");
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
    .slice(0, 20);
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
    .slice(0, 20);
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
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  // Top-N respects all enabled sources (so we don't reshape the merged
  // timeline). Enrichment only targets items NOT already in the target
  // language within that slice.
  const top = articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
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
        // 每条爬虫结果自带 sourceId（gd-szse/gd-sse/gd-bse/gd-hkex/gd-em-ipo 等），
        // 据此路由到广东地区IPO下的对应二级标签；缺失时回退到历史兜底 id。
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
      console.log(`[daily] ✅ 加载爬虫数据 ${count} 条（跳过 ${items.length - count} 条重复）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[daily] ⚠️ 加载爬虫数据失败: ${msg}`);
    }
  } else {
    console.log(`[daily] ℹ️ 爬虫数据文件不存在: ${dataPath}`);
  }
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }
  
  // Enrich GH Trending, papers, finance news, and politics with summaries.
  await enrichGhTrending(articles);
  await enrichTrendingPapers(articles);
  await enrichFinanceNews(articles);
  await enrichPolitics(articles);
  await enrichAiNews(articles);
  await enrichXViral(articles);
  
  // ===== 为 gd-ipo 数据生成中文摘要（复用历史缓存去重）=====
  const gdIpoArticles = articles.filter(a => a.category === 'gd-ipo');
  if (gdIpoArticles.length > 0) {
    const pending = applyCache(gdIpoArticles);
    if (pending.length === 0) {
      console.log(`[daily] enriching gd-ipo: ${gdIpoArticles.length} 条全部命中历史缓存，跳过 LLM`);
    } else {
      console.log(`[daily] enriching ${pending.length}/${gdIpoArticles.length} gd-ipo items with ${REPORT_LOCALE} summaries…`);
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

  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const t0 = Date.now();
  const { report } = await generateDailyReport(articles);
  if (trading) report.trading = trading;
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 回写历史缓存（含今日 AI 摘要），并构建「当天 + 过去30天」滚动列表用于渲染。
  const nowIso = new Date().toISOString();
  history = saveHistory(articles, history, nowIso);
  const rolling = buildRolling(articles, history);
  console.log(
    `[daily] 历史缓存已更新: ${Object.keys(history).length} 条（含今日 ${articles.length} 条）；渲染滚动列表 ${rolling.length} 条`,
  );

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  const raw = groupRaw(rolling, sources);
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

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});
