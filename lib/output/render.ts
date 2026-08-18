import type {
  ArticleInput,
  BriefItem,
  DailyReport,
  TradingSection,
} from "../ai/pipeline";
import type { WatchlistPick } from "../ai/trading-commentary";
import { REPORT_LOCALE,loadAllSources  } from "../sources/registry";
import { getReportTz } from "../utils";
import type { Category, SourceDef } from "../sources/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V2EX_OFF_TOPIC_RE } from "../sources/v2ex";
import type { TickerAnalysis } from "../trading/signals";
import {
  getAssetGroupLabels,
  ASSET_GROUP_ORDER,
  type AssetGroup,
} from "../trading/watchlist";
import { classifyGdIpo, type GdIssuerRegistry } from "../classify/gdIpo";

// ----- i18n -----

/**
 * Localized UI strings. `t` resolves to TEXTS_ZH or TEXTS_EN at module
 * init based on REPORT_LOCALE. All hardcoded display text routes through
 * this object so adding a third locale = adding one more table.
 */
const TEXTS_ZH = {
  siteTitle: "每日简报",
  catTech: "技术动态",
  catFinance: "财经要点",
  catPolitics: "时政观察",
  catTrading: "市场行情",
  catGdIpo: "广东地区IPO",
  catIpo: "IPO/新股",
  catCommunity: "社区讨论",
  subAiNews: "AI 媒体",
  subTrendingPapers: "热门论文",
  subXViral: "X 推文",
  subBlogWeekly: "博客周刊",
  subCnCommunity: "中文社区",
  subCnTech: "国内技术",
  subOverseasCommunity: "海外社区",
  subFinanceNews: "国际财经",
  subFinanceCn: "国内财经",
  subFinanceCommunity: "社区讨论",
  subWorld: "国际要闻",
  subOverseasNews: "海外科技",
  subOverseas: "海外",
  emptySource: "该源今日无内容。",
  emptyCategory: "该分类今日无内容。",
  emptyGroup: "该组今日无数据。",
  timeToday: "当天",
  timePast7: "过去7天",
  footer: "内容均来自原媒体，本站仅作摘要整理与回链。",
  summaryLabelNews: "中文摘要",
  summaryLabelIntro: "中文介绍",
  tradingMarketOverview: "市场总览",
  tradingTodayFocus: "今日关注",
  tradingAllAssets: "全部资产",
  tradingRiskCaveat: "风险提示",
  widgetCryptoFearGreed: "加密恐慌贪婪",
  widgetCryptoCap: "加密总市值",
  widgetBtcDom: "BTC 主导率",
  widgetVolume24h: "24h 成交量",
  widgetActiveCoins: "活跃币",
  ticker5d: "5 日",
  tickerVs52wHigh: "距 52w 高",
  tickerTrend: "趋势",
  tickerMacd: "MACD / 信号",
  signalToday: "今天",
  signalDaysAgoSuffix: "天前",
  trendBullish: "多头",
  trendBearish: "空头",
  trendNeutral: "中性",
  mdTodayOverview: "今日总览",
  mdEditorNote: "编辑短评",
  mdTodayKeywords: "今日关键词",
  mdImportance: "重要度",
  archiveLink: "← 历史归档",
};

const TEXTS_EN: typeof TEXTS_ZH = {
  siteTitle: "Daily Brief",
  catTech: "Tech",
  catFinance: "Finance",
  catPolitics: "World",
  catTrading: "Markets",
  catGdIpo: "Guangdong IPO",
  catIpo: "IPO / New Listings",
  catCommunity: "Community",
  subAiNews: "AI Media",
  subTrendingPapers: "Trending Papers",
  subXViral: "X Viral",
  subBlogWeekly: "Blog Weekly",
  subCnCommunity: "Chinese Community",
  subCnTech: "Chinese Tech",
  subOverseasCommunity: "Overseas Community",
  subFinanceNews: "Finance News",
  subFinanceCn: "Finance China",
  subFinanceCommunity: "Community",
  subWorld: "World News",
  subOverseasNews: "Overseas Tech",
  subOverseas: "Overseas",
  emptySource: "No content from this source today.",
  emptyCategory: "No content in this category today.",
  emptyGroup: "No data for this group today.",
  timeToday: "Today",
  timePast7: "Past 7d",
  footer:
    "Content sourced from original publishers; this site provides summary and backlinks only.",
  summaryLabelNews: "Summary",
  summaryLabelIntro: "Summary",
  tradingMarketOverview: "Market Overview",
  tradingTodayFocus: "Today's Focus",
  tradingAllAssets: "All Assets",
  tradingRiskCaveat: "Risk Disclaimer",
  widgetCryptoFearGreed: "Crypto Fear/Greed",
  widgetCryptoCap: "Crypto Market Cap",
  widgetBtcDom: "BTC Dominance",
  widgetVolume24h: "24h Volume",
  widgetActiveCoins: "Active coins",
  ticker5d: "5d",
  tickerVs52wHigh: "vs 52w High",
  tickerTrend: "Trend",
  tickerMacd: "MACD / Signal",
  signalToday: "today",
  signalDaysAgoSuffix: "d ago",
  trendBullish: "Bullish",
  trendBearish: "Bearish",
  trendNeutral: "Neutral",
  mdTodayOverview: "Today's Overview",
  mdEditorNote: "Editor's Note",
  mdTodayKeywords: "Keywords",
  mdImportance: "Importance",
  archiveLink: "← Archive",
};

const STR = REPORT_LOCALE === "en" ? TEXTS_EN : TEXTS_ZH;
const ASSET_GROUP_LABELS_LOCALIZED = getAssetGroupLabels(REPORT_LOCALE);

// ----- types -----

export type SourceGroup = {
  sourceId: string;
  sourceName: string;
  items: ArticleInput[];
  /**
   * When true, items come from multiple merged sources and the renderer
   * should label each article with `a.source` since the source-tab row
   * is suppressed (only one synthetic group).
   */
  merged?: boolean;
};

export type SubGroup = {
  id: string;
  name: string;
  sources: SourceGroup[];
};

export type RawByCategory = Record<Category, SubGroup[]>;

// ----- labels & ordering -----

const CATEGORY_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
  'gd-ipo': '广东地区IPO',
  ipo: STR.catIpo,
  gz: '广州商机',
};

const CATEGORY_DIGEST_LABELS: Record<Category, string> = {
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
  'gd-ipo': STR.catGdIpo,
  ipo: STR.catIpo,
  gz: '广州商机',
};

/**
 * 仅这些分类在 L2 子面板内展示"当天 / 过去7天"时间拆分。
 *  - 技术动态、财经要点：只看当天（热门），不暴露历史库存，故不渲染时间标签。
 *  - 广东地区IPO、全国IPO/新股：按信息发生时间 publishedAt 做 当天/过去7天 回溯。
 *  - 市场行情：在线生成的当日宏观数据，由独立 trading 面板渲染，不在此时间拆分体系内。
 */
const TIME_SPLIT_CATEGORIES = new Set<Category>(["gd-ipo", "ipo", "gz"]);

/**
 * L2 ordering per category. Categories not listed render flat (no L2 tabs).
 */
const SUBCATEGORY_ORDER: Partial<Record<Category, string[]>> = {
  // cn-community + overseas-community are listed last so the L1 "community"
  // panel (rendered separately via TECH_COMMUNITY_SUBS) can extract them.
  // Within the "tech" L1 panel itself, COMMUNITY_SUBS is filtered out.
  // Locale filtering at registry level decides which actually appears:
  // zh mode keeps cn-community (V2EX / LinuxDo); en mode keeps
  // overseas-community (Hacker News / r/stocks).
  tech: ["trending-papers", "x-viral", "ai-news", "cn-tech"],
  // 宏观政策：国内政策(权威) / 国内财经(媒体) / 广州政策 / 国际
  finance: ["cn-policy", "cn-finance", "gz-policy", "news"],
  'gd-ipo': ["szse", "sse", "bse", "hkex", "ipo-tutoring", "overseas"],
  // 参考区·全国IPO/新股：全部交易所+辅导（非广州辖区的广东企业也归此）
  ipo: ["sse", "szse", "bse", "hkex", "ipo-tutoring", "overseas"],
  // 广州商机：按分行零售业务线组织（财富/个贷/客群/私行/企业融资）
  gz: ["gz-wealth", "gz-credit", "gz-customer", "gz-private", "gz-ipo"],
  politics: ["world"],
};

const TECH_MAIN_SUBS = new Set(["github-trending", "trending-papers", "x-viral", "ai-news", "cn-tech"]);
const TECH_COMMUNITY_SUBS = new Set(["cn-community", "overseas-community"]);

const SUBCATEGORY_LABELS: Record<string, string> = {
  "github-trending": "GitHub Trending",
  "trending-papers": STR.subTrendingPapers,
  "cn-community": STR.subCnCommunity,
  "overseas-community": STR.subOverseasCommunity,
  "ai-news": STR.subAiNews,
  "cn-tech": STR.subCnTech,
  "x-viral": STR.subXViral,
  "blog-weekly": STR.subBlogWeekly,
  news: STR.subFinanceNews,
  "cn-finance": STR.subFinanceCn,
  "cn-policy": "国内政策",
  "gz-policy": "广州政策",
  world: STR.subWorld,
  // 广东地区IPO 的 6 个二级标签（地域→市场 分发；预备上市统一进 IPO辅导）
  szse: "深交所",
  sse: "上交所",
  bse: "北交所",
  hkex: "港交所",
  "ipo-tutoring": "IPO辅导",
  overseas: "境外",
  // 广州商机 子维度（按分行零售业务线）
  "gz-wealth": "财富业务",
  "gz-credit": "个人信贷",
  "gz-customer": "零售客群",
  "gz-private": "私行业务",
  "gz-ipo": "企业融资",
};

/**
 * Per-source item caps in the raw display, keyed by "category:subcategory".
 * Each source inside the subcategory shows up to N items. Missing keys = no cap.
 *
 * Default 20 across all L3-tabbed subcategories keeps each tab a single
 * comfortable scroll instead of 25-30 items. Merged subgroups (blog-weekly,
 * finance:news, politics:world) ignore this — they use MERGED_SUBGROUP_LIMITS.
 */
export const SOURCE_DISPLAY_LIMITS: Record<string, number> = {
  "tech:github-trending": 20,
  "tech:cn-community": 10,
  // 热门论文 / X 推文：单源子标签，每源≤5（保留抓取端热度/点赞排序，不切合并流）
  "tech:x-viral": 5,
  "tech:trending-papers": 5,
};

/**
 * Sources whose fetcher returns items already sorted by an engagement/heat
 * algorithm we want to preserve. groupRaw skips its default date-desc sort
 * for these so the final render reflects the source's own ranking.
 */
const PRESERVE_FETCH_ORDER_SOURCES = new Set([
  "attentionvc-ai",
  "huggingface-papers",
]);

function displayLimitFor(
  category: Category,
  subId: string | undefined,
): number | undefined {
  if (!subId) return undefined;
  return SOURCE_DISPLAY_LIMITS[`${category}:${subId}`];
}

/**
 * Take the first `n` items of `list`, but always put today's freshly-fetched
 * items first (preserving relative order inside each group). The renderer
 * only shows `fetchedToday` items under "当天", so slicing a mixed rolling
 * list naively lets older history entries crowd out today's items — e.g.
 * trending papers whose history copy sorts before today's fetch, leaving
 * the sub-tab empty.
 */
function takeFirstToday(list: ArticleInput[], n: number): ArticleInput[] {
  if (list.length <= n) return list;
  const today: ArticleInput[] = [];
  const past: ArticleInput[] = [];
  for (const a of list) (a.fetchedToday === true ? today : past).push(a);
  return today.concat(past).slice(0, n);
}

/**
 * Cheap local heuristic for cross-source story dedup (no LLM cost):
 * normalize a title to lowercase alphanumeric tokens, then compare either
 * by exact normalized equality or by token Jaccard similarity.
 */
function normalizeTitleForDedup(t: string): string {
  return (t ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Collapse same-story items inside a merged subgroup. The kept item (first
 * in list order) records the other sources in `alsoFrom` so the renderer can
 * show "多家来源：…". Thresholds are conservative to avoid merging distinct
 * stories that merely share keywords.
 */
function mergeSimilarStories(items: ArticleInput[]): ArticleInput[] {
  const groups: { rep: ArticleInput }[] = [];
  for (const a of items) {
    const norm = normalizeTitleForDedup(a.title);
    const tokens = norm.split(" ").filter(Boolean);
    const target = groups.find((g) => {
      const gNorm = normalizeTitleForDedup(g.rep.title);
      if (gNorm === norm) return true;
      if (tokens.length < 3) return false; // too short to risk a merge
      return tokenJaccard(tokens, gNorm.split(" ").filter(Boolean)) >= 0.75;
    });
    if (!target) {
      groups.push({ rep: a });
      continue;
    }
    if (a.source && a.source !== target.rep.source) {
      target.rep.alsoFrom = target.rep.alsoFrom ?? [];
      if (!target.rep.alsoFrom.includes(a.source)) target.rep.alsoFrom.push(a.source);
    }
  }
  return groups.map((g) => g.rep);
}

/**
 * Subcategories that should collapse their sources into a single flat
 * time-sorted list (no L3 source tabs), keyed by "category:subcategory".
 * Value = number of items kept after merging. Each rendered article
 * will display its `source` label inline since the per-source tab row
 * is suppressed.
 *
 * Used when:
 *  - sources are heterogeneous but each publishes few items (blog-weekly)
 *  - the user explicitly wants a curated time-sorted feed rather than
 *    per-source browsing (finance:news, only authoritative sources)
 *
 * Exported so daily.ts can read the cap to keep enrichment in sync.
 */
export const MERGED_SUBGROUP_LIMITS: Record<string, number> = {
  // 技术动态 / 财经要点 合并流：每数据源≤5、子标签整体≤10
  // （省钱 + 避免单一源霸屏）。典型子标签：AI媒体 / 国内技术 / 国际财经。
  "tech:ai-news": 10,
  "tech:cn-tech": 10,
  "finance:news": 10,
  // 国内财经：上限 20，按接入的信息源平摊（见 groupRaw 的 cn-finance 逻辑）
  "finance:cn-finance": 20,
  // 时政不在本次范围，保留原整体上限
  "politics:world": 15,
};

/**
 * 合并流中单源最多贡献的条数。避免某一源条目过多、按时间降序时把同子标签下
 * 其他源整屏挤出（例如国内财经若某源日期较新、10 条上限会被它独占）。
 * 技术动态 / 财经要点 合并子标签统一为 5（典型：AI媒体 / 国内技术 / 国际财经）。
 * 国内财经（cn-finance）不在此表——它按「子标签上限 / 接入源数量」平摊（20/源数）。
 * 缺省不限制（undefined）即沿用旧行为。
 */
export const MERGE_PER_SOURCE_CAP: Record<string, number> = {
  "tech:ai-news": 5,
  "tech:cn-tech": 5,
  "finance:news": 5,
};

/**
 * Politics sources (especially Al Jazeera / BBC / The Diplomat) regularly
 * mix in World Cup / Olympic / football coverage. Filter at the title level
 * so the merged "国际要闻" stream stays politics-only.
 *
 * Pattern is intentionally specific — avoid generic words like "team" or
 * "match" that overlap with diplomacy headlines.
 */
const POLITICS_SPORTS_RE =
  /\b(World\s*Cup|Olympics?|UEFA|FIFA|NBA|NFL|NHL|MLB|ATP|WTA|Premier\s*League|Bundesliga|La\s*Liga|Serie\s*A|Champions\s*League|Eurovision|Wimbledon|Grand\s*Slam|F1|Formula\s*1|Ronaldo|Messi|Mbappe|Beckham|Lukaku|Mitoma|sportsman|footballer|squad)\b|世界杯|奥运|残奥|冬奥|欧冠|英超|西甲|意甲|德甲|网球|足球|篮球|高尔夫|棒球|板球|橄榄球/i;

export function isSportsArticle(title: string): boolean {
  return POLITICS_SPORTS_RE.test(title);
}

// 广东发行人注册表（结构化地域信号，优先于关键词兜底）
let _gdIssuersCache: GdIssuerRegistry | undefined | null = null;
function loadGdIssuers(): GdIssuerRegistry | undefined {
  if (_gdIssuersCache !== null) return _gdIssuersCache ?? undefined;
  try {
    const raw = readFileSync(
      join(process.cwd(), "data", "gd-issuers.json"),
      "utf8",
    );
    _gdIssuersCache = JSON.parse(raw) as GdIssuerRegistry;
  } catch {
    _gdIssuersCache = undefined;
  }
  return _gdIssuersCache ?? undefined;
}

function mergedLimitFor(
  category: Category,
  subId: string,
): number | undefined {
  return MERGED_SUBGROUP_LIMITS[`${category}:${subId}`];
}

// ----- grouping -----

export function groupRaw(
  articles: ArticleInput[],
  registry: SourceDef[],
): RawByCategory {
   const subcatOf = new Map<string, string | undefined>();
  for (const s of registry) subcatOf.set(s.id, s.subcategory);
  // Keep articles from *every* registered source id — including disabled ones
  // like gd-local-scraper. When scripts/render.ts re-renders against a stale
  // sidecar, that file still holds the disabled source's fetched data; we must
  // not silently drop it. (We deliberately do NOT filter by `enabled !== false`.)
  const knownSourceIds = new Set(loadAllSources().map((s) => s.id));

  // console.log('[groupRaw] enabledIds 包含的 sourceId 列表:', Array.from(enabledIds));
  // console.log('[groupRaw] gd-local-scraper 是否在 enabledIds 中:', enabledIds.has('gd-local-scraper'));

  type Bucket = { sourceName: string; items: ArticleInput[] };
  const buckets: Record<Category, Map<string, Bucket>> = {
    tech: new Map(),
    finance: new Map(),
    politics: new Map(),
    'gd-ipo': new Map(),
    ipo: new Map(),
    gz: new Map(),
  };

  // 广东地区IPO：文章级三道闸分类后，按 classifier 决定的子标签归桶
  // （一个源如巨潮可能同时含深/沪/京，不能再靠 sourceId 定 sub）。
  const gdSubs = new Map<string, Bucket>();
  // 全国IPO/新股：crawler 已按 region 分流好（非广东沪深 + 媒体源），
  // 直接按 registry 的 subcategory 归桶（sse/szse/ipo-media），不再过三道闸。
  const ipoSubs = new Map<string, Bucket>();
  // 广东公司但非IPO类（财报/分红/解禁等）→ 转财经要点「news」合并流
  const financeExtra: ArticleInput[] = [];
  const gdIssuers = loadGdIssuers();

  // console.log('[groupRaw] buckets keys:', Object.keys(buckets));
  // console.log('[groupRaw] buckets[gd-ipo] size:', buckets['gd-ipo']?.size);
  // Pre-seed empty buckets for every enabled source so per-source-tabbed
  // subcategories (e.g. cn-community) still render a tab for sources that
  // returned 0 items today. Without this, a transient LinuxDo Cloudflare
  // block would silently collapse the L3 tab nav, making users wonder
  // whether the other forum even exists.
  for (const s of registry) {
    if (s.enabled === false) continue;
    if (!buckets[s.category].has(s.id)) {
      buckets[s.category].set(s.id, { sourceName: s.name, items: [] });
    }
  }

  for (const a of articles) {
    if (!knownSourceIds.has(a.sourceId)) continue;
    if (a.category === "politics" && isSportsArticle(a.title)) continue;
    if (
      (a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") &&
      V2EX_OFF_TOPIC_RE.test(a.title)
    )
      continue;
    // 广东地区IPO：先过三道闸分类器，再决定归哪个子标签 / 是否转财经 / 丢弃
    if (a.category === "gd-ipo") {
      const res = classifyGdIpo(
        {
          title: a.title,
          excerpt: a.excerpt,
          url: a.url,
          sourceId: a.sourceId,
          source: a.source,
          publishedAt: a.publishedAt,
          stockCode: (a as ArticleInput & { stockCode?: string }).stockCode,
          registeredProvince: (a as ArticleInput & { registeredProvince?: string })
            .registeredProvince,
        },
        { gdIssuers },
      );
      if (res.action === "drop") continue;
      if (res.action === "finance") {
        financeExtra.push(a);
        continue;
      }
      let b = gdSubs.get(res.sub);
      if (!b) {
        b = { sourceName: SUBCATEGORY_LABELS[res.sub] ?? res.sub, items: [] };
        gdSubs.set(res.sub, b);
      }
      b.items.push(a);
      continue;
    }
    // 全国IPO/新股：按 sourceId → registry subcategory 归桶（sse/szse/bse 交易所权威源）
    if (a.category === "ipo") {
      const sub = subcatOf.get(a.sourceId) ?? "sse";
      let b = ipoSubs.get(sub);
      if (!b) {
        b = { sourceName: SUBCATEGORY_LABELS[sub] ?? sub, items: [] };
        ipoSubs.set(sub, b);
      }
      b.items.push(a);
      continue;
    }
    const map = buckets[a.category];
    let b = map.get(a.sourceId);
    if (!b) {
      b = { sourceName: a.source, items: [] };
      map.set(a.sourceId, b);
    }
    
    b.items.push(a);
    // console.log('[groupRaw] buckets[gd-ipo] size after filling:', buckets['gd-ipo']?.size);
  }

  for (const cat of Object.keys(buckets) as Category[]) {
    for (const [id, b] of buckets[cat].entries()) {
      if (PRESERVE_FETCH_ORDER_SOURCES.has(id)) continue;
      b.items.sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      );
    }
  }

  // 广东公司但非IPO类（财报/分红/解禁等）→ 并入财经要点「国内财经」合并流
  if (financeExtra.length > 0) {
    const sid = "_gd_finance";
    subcatOf.set(sid, "cn-finance");
    const b =
      buckets["finance"].get(sid) ??
      ({ sourceName: "广东公司公告", items: [] } as Bucket);
    b.items.push(...financeExtra);
    buckets["finance"].set(sid, b);
  }

  // 按 SUBCATEGORY_ORDER 构建子标签，始终渲染全部二级标签（空则占位）。
  // gd-ipo 用三道闸分类结果 gdSubs；全国 ipo 用 subcatOf 归桶结果 ipoSubs。
  function buildOrderedSubs(subMap: Map<string, Bucket>, cat: Category): SubGroup[] {
    const order = SUBCATEGORY_ORDER[cat] ?? [];
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const b = subMap.get(subId);
      if (!b || b.items.length === 0) {
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [],
        });
        continue;
      }
      b.items.sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      );
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: [
          {
            sourceId: "_merged",
            sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
            items: b.items,
            merged: true,
          },
        ],
      });
    }
    return subs;
  }

  function toSourceGroup(
    sourceId: string,
    b: Bucket,
    limit: number | undefined,
  ): SourceGroup {
    return {
      sourceId,
      sourceName: b.sourceName,
      items: limit ? takeFirstToday(b.items, limit) : b.items,
    };
  }

  function sortByRegistry(list: SourceGroup[]): SourceGroup[] {
    return [...list].sort((a, b) => {
      const ia = registry.findIndex((s) => s.id === a.sourceId);
      const ib = registry.findIndex((s) => s.id === b.sourceId);
      return ia - ib;
    });
  }

 const out: RawByCategory = {
  tech: [],
  finance: [],
  politics: [],
  'gd-ipo': [],
  ipo: [],
  gz: [],
  };
  
  for (const cat of Object.keys(buckets) as Category[]) {
    // 广东地区IPO / 全国IPO 已由各自分流逻辑（三道闸 / subcatOf）文章级分发，单独构建
    if (cat === "gd-ipo") {
      out["gd-ipo"] = buildOrderedSubs(gdSubs, "gd-ipo");
      continue;
    }
    if (cat === "ipo") {
      out["ipo"] = buildOrderedSubs(ipoSubs, "ipo");
      continue;
    }
    const order = SUBCATEGORY_ORDER[cat];
    if (!order) {
      // Flat: one synthetic subgroup with every source.
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        sources.push(toSourceGroup(id, b, undefined));
      }
      out[cat] = sources.length
        ? [{ id: "all", name: CATEGORY_LABELS[cat], sources: sortByRegistry(sources) }]
        : [];
      continue;
    }
    // Subcategory split: bucket each source under its registered subcategory.
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const mergeLimit = mergedLimitFor(cat, subId);
      if (mergeLimit !== undefined) {
        // Merge: flatten all sources under this subcategory into a single
        // time-sorted SourceGroup. Articles keep their `source` field so
        // the renderer can label them.
        const flat: ArticleInput[] = [];
        // Per-source cap: fixed for most merged subgroups; 国内财经 shares
        // its subcategory limit evenly across the enabled sources.
        let perCap = MERGE_PER_SOURCE_CAP[`${cat}:${subId}`];
        if (perCap === undefined && subId === "cn-finance") {
          const n = registry.filter(
            (s) =>
              s.category === cat &&
              s.subcategory === subId &&
              s.enabled !== false,
          ).length;
          if (n > 0) perCap = Math.ceil((mergeLimit ?? 20) / n);
        }
        for (const [id, b] of buckets[cat].entries()) {
          if (subcatOf.get(id) === subId) {
            flat.push(...(perCap ? takeFirstToday(b.items, perCap) : b.items));
          }
        }
        if (flat.length === 0) {
          if (cat === "finance") {
            subs.push({
              id: subId,
              name: SUBCATEGORY_LABELS[subId] ?? subId,
              sources: [],
            });
          }
          continue;
        }
        flat.sort(
          (a, b) =>
            (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
        );
        const top = takeFirstToday(flat, mergeLimit);
        if (top.length === 0) continue;
        // Cross-source story dedup: several sources may cover the same story.
        // Collapse near-identical titles into one item and record the other
        // sources on `alsoFrom` (cheap local heuristic — zero LLM calls).
        const deduped = mergeSimilarStories(top);
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [
            {
              sourceId: "_merged",
              sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
              items: deduped,
              merged: true,
            },
          ],
        });
        continue;
      }

      const limit = displayLimitFor(cat, subId);
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        if (subcatOf.get(id) === subId) sources.push(toSourceGroup(id, b, limit));
      }
      // 广东地区IPO / 财经要点 / 广州商机 的二级标签始终渲染，即使当天为空也保留
      // 标签 + “暂无内容”占位，保证结构稳定可见（不折叠成单子标签）。
      if (sources.length === 0) {
        if (cat === 'gd-ipo' || cat === 'finance' || cat === 'gz') {
          subs.push({ id: subId, name: SUBCATEGORY_LABELS[subId] ?? subId, sources: [] });
          continue;
        }
        continue;
      }
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: sortByRegistry(sources),
      });
    }
    out[cat] = subs;
  }
  // Safety net: if gd-ipo has data but the subcategory split above produced
  // an empty panel (e.g. a future source whose subcategory isn't in
  // SUBCATEGORY_ORDER), force a flat render so the data is never lost.
  if (buckets['gd-ipo'] && buckets['gd-ipo'].size > 0 && (out['gd-ipo'] || []).length === 0) {
    const flatSources: SourceGroup[] = [];
    for (const [id, b] of buckets['gd-ipo'].entries()) {
      flatSources.push(toSourceGroup(id, b, undefined));
    }
    if (flatSources.length > 0) {
      out['gd-ipo'] = [{
        id: 'all',
        name: CATEGORY_LABELS['gd-ipo'],
        sources: sortByRegistry(flatSources),
      }];
    }
  }
  return out;
}

// ----- HTML helpers -----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(d: Date | undefined): string {
  if (!d) return "";
  try {
    // zh: "05/20 16:00"  · en: "May 20, 4:00 PM" → keep 24h en-GB style "20/05 16:00"
    const localeTag = REPORT_LOCALE === "en" ? "en-GB" : "zh-CN";
    return d.toLocaleString(localeTag, {
      timeZone: getReportTz(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

// ----- raw article renderers -----

function renderArticleHtml(a: ArticleInput, showSource = false): string {
  const title = escapeHtml(a.title);
  const url = escapeHtml(a.url);
  const excerpt = a.excerpt ? escapeHtml(a.excerpt) : "";
  // Backwards-compat: old sidecar JSON files may carry `cnSummary` instead.
  const summaryText = a.summary ?? (a as unknown as { cnSummary?: string }).cnSummary;
  const summary = summaryText ? escapeHtml(summaryText) : "";
  const meta = a.meta ? escapeHtml(a.meta) : "";
  const time = formatDate(a.publishedAt);
  const sourceLabel = showSource && a.source ? escapeHtml(a.source) : "";
  const alsoFrom = (a.alsoFrom ?? []).filter(Boolean);
  const alsoLine =
    alsoFrom.length > 0
      ? `${escapeHtml("多家来源")}：${alsoFrom.map(escapeHtml).join("、")}`
      : "";
  const metaLine = [sourceLabel, time, alsoLine].filter(Boolean).join(" · ");
  // News-style summary label for finance/politics, project-intro style for GH/tech.
  const newsy = a.category === "finance" || a.category === "politics";
  const summaryLabel = newsy ? STR.summaryLabelNews : STR.summaryLabelIntro;
  return `<article class="article">
  <h3 class="article-title"><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h3>
  ${meta ? `<p class="article-stats">${meta}</p>` : ""}
  ${metaLine ? `<p class="article-meta">${metaLine}</p>` : ""}
  ${excerpt ? `<p class="article-excerpt">${excerpt}</p>` : ""}
  ${summary ? `<p class="article-summary"><span class="summary-label">${summaryLabel}</span> ${summary}</p>` : ""}
</article>`;
}

function renderSourceContent(
  category: Category,
  subId: string,
  source: SourceGroup,
  isActive: boolean,
): string {
  const showSource = source.merged === true;
  return `<div class="source-content${isActive ? " active" : ""}" data-source-content="${escapeHtml(source.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">
    ${source.items.length === 0 ? `<p class="empty">${STR.emptySource}</p>` : source.items.map((a) => renderArticleHtml(a, showSource)).join("\n")}
  </div>`;
}

function renderSourceTabs(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  // Single-source L2s (X 推文 / GitHub Trending) skip the L3 row — the L2 tab
  // label already identifies the dataset. L3 only earns its row when there
  // are ≥2 sources to switch between (e.g. 社区讨论 V2EX vs LinuxDo).
  if (sources.length < 2) return "";
  return `<nav class="source-tabs">${sources
    .map(
      (s, i) =>
        `<button class="source-tab${i === 0 ? " active" : ""}" data-source="${escapeHtml(s.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">${escapeHtml(s.sourceName)}<span class="count">${s.items.length}</span></button>`,
    )
    .join("")}</nav>`;
}

/**
 * Keep only the articles of each source that match the time window.
 * `todayOnly=true` → fetched in the current run (`fetchedToday`);
 * `todayOnly=false` → carried from the rolling 7-day history.
 */
function filterByTime(sources: SourceGroup[], todayOnly: boolean): SourceGroup[] {
  return sources.map((s) => ({
    ...s,
    items: s.items.filter((a) =>
      todayOnly ? a.fetchedToday === true : a.fetchedToday !== true,
    ),
  }));
}

let _tzFmt: Intl.DateTimeFormat | undefined;
/** Report-timezone date string "YYYY-MM-DD" for a Date. */
function tzDateStr(d: Date): string {
  if (!_tzFmt) {
    _tzFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: getReportTz(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return _tzFmt.format(d);
}

/**
 * 广东地区IPO / 全国IPO / 广州商机 的「当天 / 过去7天」按信息发生时间 publishedAt（发文/公告日期）拆分，
 * 而不是按抓取时间 fetchedToday —— 否则今天抓到的 8 月 12 日公告（或 5 月的月度数据）会被错放进
 * 「当天」。规则：
 *  - 有 publishedAt：发文=今天 → 当天；今天之前（7天内及更早，均在滚动窗口内）→ 过去7天；
 *  - 无 publishedAt：回退 fetchedToday（今天抓到 → 当天；历史缓存 → 过去7天），避免丢失。
 */
function splitGdIpoByPublishedAt(
  sources: SourceGroup[],
  dateStr: string,
): { today: SourceGroup[]; past: SourceGroup[] } {
  const pastStartMs = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)) - 7,
  );
  const pastStartStr = tzDateStr(new Date(pastStartMs));
  const today: SourceGroup[] = [];
  const past: SourceGroup[] = [];
  for (const s of sources) {
    const t: ArticleInput[] = [];
    const p: ArticleInput[] = [];
    for (const a of s.items) {
      const ds = a.publishedAt ? tzDateStr(a.publishedAt) : undefined;
      if (ds === dateStr) t.push(a);
      else if (ds && ds < dateStr) p.push(a);
      else if (!ds && a.fetchedToday === true) t.push(a);
      else p.push(a);
    }
    if (t.length) today.push({ ...s, items: t });
    if (p.length) past.push({ ...s, items: p });
  }
  return { today, past };
}

function countItems(sources: SourceGroup[]): number {
  return sources.reduce((n, s) => n + s.items.length, 0);
}

/** Sum only the "当天" (fetchedToday) items across subgroups — used for the
 *  top-level tab badge of categories that don't expose a 过去7天 backlog. */
function countItemsToday(subs: SubGroup[]): number {
  return subs.reduce((n, sg) => n + countItems(filterByTime(sg.sources, true)), 0);
}

function renderSourcesBlock(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  if (sources.length === 0) {
    return `<p class="empty">${STR.emptySource}</p>`;
  }
  return `${renderSourceTabs(category, subId, sources)}
  <div class="source-contents">
    ${sources.map((s, i) => renderSourceContent(category, subId, s, i === 0)).join("\n")}
  </div>`;
}

function renderSubContent(category: Category, sub: SubGroup, isActive: boolean, date: string): string {
  const usesTimeSplit = TIME_SPLIT_CATEGORIES.has(category);
  const activeCls = isActive ? " active" : "";
  const subAttr = `data-sub-content="${escapeHtml(sub.id)}" data-cat="${category}"`;

  // 空 sub 占位结构：
  //  - 需要时间拆分的（gd-ipo）保留"当天 / 过去7天"两个空面板，结构稳定可见；
  //  - 其他分类（技术动态 / 财经要点）直接显示"今日无内容"。
  if (sub.sources.length === 0) {
    if (!usesTimeSplit) {
      return `<div class="sub-content${activeCls}" ${subAttr}><p class="empty">${STR.emptySource}</p></div>`;
    }
    return `<div class="sub-content${activeCls}" ${subAttr}>
    <nav class="time-tabs">
      <button class="time-tab active" data-time="today" data-cat="${category}" data-sub="${escapeHtml(sub.id)}">${STR.timeToday}<span class="count">0</span></button>
      <button class="time-tab" data-time="past" data-cat="${category}" data-sub="${escapeHtml(sub.id)}">${STR.timePast7}<span class="count">0</span></button>
    </nav>
    <div class="time-contents">
      <div class="time-content active" data-time-content="today" data-cat="${category}" data-sub="${escapeHtml(sub.id)}"><p class="empty">${STR.emptySource}</p></div>
      <div class="time-content" data-time-content="past" data-cat="${category}" data-sub="${escapeHtml(sub.id)}"><p class="empty">${STR.emptySource}</p></div>
    </div>
  </div>`;
  }

  // 不需要时间拆分的分类（技术动态 / 财经要点）：只渲染当天抓取的条目，
  // 不出现"过去7天"标签。
  if (!usesTimeSplit) {
    const todaySrc = filterByTime(sub.sources, true);
    return `<div class="sub-content${activeCls}" ${subAttr}>
      ${renderSourcesBlock(category, sub.id, todaySrc)}
    </div>`;
  }

  // 需要时间拆分（广东地区IPO）：当天 vs 过去7天（按公告时间 publishedAt）。
  const { today: todaySrc, past: pastSrc } = splitGdIpoByPublishedAt(
    sub.sources,
    date,
  );
  const todayCount = countItems(todaySrc);
  const pastCount = countItems(pastSrc);
  return `<div class="sub-content${activeCls}" ${subAttr}>
    <nav class="time-tabs">
      <button class="time-tab active" data-time="today" data-cat="${category}" data-sub="${escapeHtml(sub.id)}">${STR.timeToday}<span class="count">${todayCount}</span></button>
      <button class="time-tab" data-time="past" data-cat="${category}" data-sub="${escapeHtml(sub.id)}">${STR.timePast7}<span class="count">${pastCount}</span></button>
    </nav>
    <div class="time-contents">
      <div class="time-content active" data-time-content="today" data-cat="${category}" data-sub="${escapeHtml(sub.id)}">
        ${renderSourcesBlock(category, sub.id, todaySrc)}
      </div>
      <div class="time-content" data-time-content="past" data-cat="${category}" data-sub="${escapeHtml(sub.id)}">
        ${renderSourcesBlock(category, sub.id, pastSrc)}
      </div>
    </div>
  </div>`;
}

function renderRawCategoryPanel(
  category: Category,
  subs: SubGroup[],
  date: string,
): string {
  if (subs.length === 0) {
    return `<p class="empty">${STR.emptyCategory}</p>`;
  }
  if (subs.length === 1) {
    return renderSubContent(category, subs[0], true, date);
  }
  const subTabs = subs
    .map((s, i) => {
      const count = s.sources.reduce((n, src) => n + src.items.length, 0);
      return `<button class="sub-tab${i === 0 ? " active" : ""}" data-sub="${escapeHtml(s.id)}" data-cat="${category}">${escapeHtml(s.name)}<span class="count">${count}</span></button>`;
    })
    .join("");
  const panels = subs
    .map((s, i) => renderSubContent(category, s, i === 0, date))
    .join("\n");
  return `<nav class="sub-tabs">${subTabs}</nav>\n<div class="sub-contents">${panels}</div>`;
}

// ----- top-level renderer -----

export function renderHtml(
  report: DailyReport,
  raw: RawByCategory,
  date: string,
): string {
  const trading = report.trading;

  // "tech" L1 panel shows the main subs; the community sub-sources
  // (V2EX / LinuxDo) are not in this fork's default source config, so they
  // are filtered out and the tech panel renders only the configured subs.
  const techMainSubs = raw.tech.filter((s) => TECH_MAIN_SUBS.has(s.id));

  const sumItems = (subs: SubGroup[]) =>
    subs.reduce(
      (n, sg) => n + sg.sources.reduce((m, s) => m + s.items.length, 0),
      0,
    );
  const counts = {
    tech: countItemsToday(techMainSubs),
    finance: countItemsToday(raw.finance),
    'gd-ipo': sumItems(raw['gd-ipo'] || []),
    ipo: sumItems(raw['ipo'] || []),
    gz: sumItems(raw['gz'] || []),
     politics: sumItems(raw.politics),
  };

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${STR.siteTitle} · ${date}</title>
<style>
  :root {
    --bg: #f6f5f3;
    --bg-elevated: #ffffff;
    --fg: #1a1a1f;
    --fg-soft: #4a4a52;
    --muted: #797986;
    --rule: #e7e5e1;
    --card: #ffffff;
    --card-alt: #f1efec;
    --link: #2f4cdd;
    --accent: #1a1a1f;
    --accent-fg: #ffffff;
    --rank-high-bg: #fde8e8;
    --rank-high-fg: #c01c1c;
    --rank-mid-bg: #fdf0d9;
    --rank-mid-fg: #9a5b09;
    --rank-low-bg: #e6e9fd;
    --rank-low-fg: #3b36a8;
    --c-tech: #4f46e5;
    --c-trading: #0d9488;
    --c-finance: #d97706;
    --c-gdipo: #e11d48;
    --c-ipo: #7c3aed;
    --c-gz: #059669;
    --hero-grad-from: #f6f5f3;
    --hero-grad-to: #efedea;
    --r-sm: 0.5rem;
    --r-md: 0.75rem;
    --r-lg: 1rem;
    --shadow-sm: 0 1px 2px rgba(20, 20, 30, 0.05), 0 1px 3px rgba(20, 20, 30, 0.06);
    --shadow-md: 0 6px 16px rgba(20, 20, 30, 0.09);
    --shadow-lg: 0 14px 32px rgba(20, 20, 30, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d11;
      --bg-elevated: #15191f;
      --fg: #f3f4f6;
      --fg-soft: #c2c6cf;
      --muted: #8b909c;
      --rule: #262b33;
      --card: #15191f;
      --card-alt: #1b2027;
      --link: #8aa0ff;
      --accent: #f3f4f6;
      --accent-fg: #0b0d11;
      --rank-high-bg: rgba(239, 68, 68, 0.16);
      --rank-high-fg: #fca5a5;
      --rank-mid-bg: rgba(245, 158, 11, 0.16);
      --rank-mid-fg: #fcd34d;
      --rank-low-bg: rgba(99, 102, 241, 0.16);
      --rank-low-fg: #a5b4fc;
      --c-tech: #818cf8;
      --c-trading: #2dd4bf;
      --c-finance: #fbbf24;
      --c-gdipo: #fb7185;
      --c-ipo: #a78bfa;
      --c-gz: #34d399;
      --hero-grad-from: #15191f;
      --hero-grad-to: #0b0d11;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-md: 0 6px 16px rgba(0, 0, 0, 0.5);
      --shadow-lg: 0 14px 32px rgba(0, 0, 0, 0.55);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  ::selection { background: rgba(79, 70, 229, 0.22); }
  main { max-width: 1040px; margin: 0 auto; padding: 2.75rem 1.5rem 4rem; }

  /* ===== header / masthead ===== */
  header.report-header {
    margin-bottom: 0.5rem;
    padding-bottom: 1.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .eyebrow {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    color: var(--muted);
    font-weight: 500;
  }
  h1.report-title {
    font-family: Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", serif;
    font-size: 2.6rem;
    font-weight: 700;
    margin: 0.5rem 0 0.2rem;
    letter-spacing: -0.01em;
    line-height: 1.08;
  }
  .archive-link {
    display: inline-block;
    margin-top: 0.9rem;
    font-size: 0.85rem;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dashed var(--rule);
    padding-bottom: 1px;
    transition: color 0.15s, border-color 0.15s;
  }
  .archive-link:hover { color: var(--accent); border-bottom-style: solid; }

  /* per-category accent wiring */
  .panel[data-panel="tech"] { --cat: var(--c-tech); }
  .panel[data-panel="trading"] { --cat: var(--c-trading); }
  .panel[data-panel="finance"] { --cat: var(--c-finance); }
  .panel[data-panel="gd-ipo"] { --cat: var(--c-gdipo); }
  .panel[data-panel="ipo"] { --cat: var(--c-ipo); }
  .panel[data-panel="gz"] { --cat: var(--c-gz); }
  .tab[data-tab="tech"] { --cat: var(--c-tech); }
  .tab[data-tab="trading"] { --cat: var(--c-trading); }
  .tab[data-tab="finance"] { --cat: var(--c-finance); }
  .tab[data-tab="gd-ipo"] { --cat: var(--c-gdipo); }
  .tab[data-tab="ipo"] { --cat: var(--c-ipo); }
  .tab[data-tab="gz"] { --cat: var(--c-gz); }

  .hero-card {
    margin-top: 1.4rem;
    background: linear-gradient(135deg, var(--hero-grad-from) 0%, var(--hero-grad-to) 100%);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--c-tech);
    padding: 1.1rem 1.5rem;
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  .hero-eyebrow {
    font-size: 0.7rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  .hero-headline {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0.4rem 0 0;
    line-height: 1.5;
    color: var(--fg);
  }
  .overview-card {
    margin: 0.8rem 0 0;
    padding: 0.8rem 1.2rem;
    background: var(--card-alt);
    border-radius: var(--r-md);
    border-left: 3px solid var(--muted);
  }
  .overview-card .eyebrow { display: block; margin-bottom: 0.3rem; }
  .overview-text {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.7;
    color: var(--fg-soft);
  }

  /* ===== sticky primary tabs ===== */
  .tabs {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 0.15rem;
    margin: 0 0 1rem;
    padding: 0.7rem 0 0;
    border-bottom: 1px solid var(--rule);
    flex-wrap: wrap;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: saturate(180%) blur(10px);
    -webkit-backdrop-filter: saturate(180%) blur(10px);
  }
  .tab {
    background: none;
    border: none;
    padding: 0.65rem 1.05rem 0.85rem;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--muted);
    cursor: pointer;
    border-bottom: 2.5px solid transparent;
    margin-bottom: -1px;
    font-family: inherit;
    transition: color 0.15s;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
  }
  .tab:hover { color: var(--fg); }
  .tab.active {
    color: var(--cat, var(--accent));
    border-bottom-color: var(--cat, var(--accent));
    font-weight: 600;
  }
  .tab .count {
    font-size: 0.72rem;
    color: var(--muted);
    margin-left: 0.4rem;
    font-weight: 400;
  }
  /* 科创动态（T3 降权）：tab 弱化折叠——小号、浅色、末尾竖线分隔 */
  .tab.tab-fold {
    font-size: 0.82rem;
    color: var(--muted);
    opacity: 0.72;
    margin-left: 0.25rem;
    border-left: 1px solid var(--rule);
    padding-left: 1.1rem;
    border-radius: 0;
  }
  .tab.tab-fold.active { opacity: 1; }
  .panel { display: none; }
  .panel.active { display: block; animation: fade 0.25s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* ===== digest (AI 简报) — compact ===== */
  .digest-category { margin-bottom: 1.2rem; }
  .category-header {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    margin: 0 0 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .category-title {
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--fg);
    margin: 0;
    letter-spacing: 0.05em;
  }
  .category-count {
    font-size: 0.7rem;
    color: var(--muted);
    background: var(--card-alt);
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
  }
  .brief-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
  @media (min-width: 720px) {
    .brief-list { grid-template-columns: 1fr 1fr; }
  }
  .brief {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.8rem 1rem;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .brief:hover {
    border-color: var(--muted);
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }
  .brief-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.35rem;
  }
  .brief-source {
    font-size: 0.72rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .brief-rank {
    font-size: 0.7rem;
    padding: 0.12rem 0.5rem;
    border-radius: 999px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .brief-rank.high { background: var(--rank-high-bg); color: var(--rank-high-fg); }
  .brief-rank.mid  { background: var(--rank-mid-bg);  color: var(--rank-mid-fg); }
  .brief-rank.low  { background: var(--rank-low-bg);  color: var(--rank-low-fg); }
  .brief-title {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 0 0 0.3rem;
    line-height: 1.4;
  }
  .brief-title a { color: var(--fg); text-decoration: none; }
  .brief-title a:hover { color: var(--link); text-decoration: underline; }
  .brief-summary {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.86rem;
    line-height: 1.6;
  }

  .editor-card {
    background: var(--card-alt);
    border-left: 3px solid var(--muted);
    border-radius: var(--r-md);
    padding: 1.1rem 1.4rem;
    margin: 1.6rem 0 1.3rem;
    box-shadow: var(--shadow-sm);
  }
  .editor-card .eyebrow { display: block; margin-bottom: 0.45rem; }
  .editor-text {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.75;
    color: var(--fg);
  }
  .keywords { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0 0 1.6rem; }
  .keyword {
    background: var(--card);
    border: 1px solid var(--rule);
    color: var(--fg-soft);
    padding: 0.28rem 0.75rem;
    border-radius: 999px;
    font-size: 0.8rem;
    transition: border-color 0.15s, color 0.15s;
  }
  .keyword:hover { border-color: var(--muted); color: var(--fg); }

  /* ===== L2 sub-tabs ===== */
  .sub-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 1.1rem 0;
  }
  .sub-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.5rem 1.05rem;
    border-radius: var(--r-sm);
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .sub-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .sub-tab.active {
    background: var(--cat, var(--accent));
    color: #fff;
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .sub-tab .count {
    font-size: 0.7rem;
    opacity: 0.75;
    margin-left: 0.4rem;
    font-weight: 400;
  }
  .sub-content { display: none; }
  .sub-content.active { display: block; animation: fade 0.2s ease; }

  /* ===== time split (当天 / 过去7天) ===== */
  .time-tabs {
    display: flex;
    gap: 0.4rem;
    margin: 0 0 1rem;
  }
  .time-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.34rem 0.9rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .time-tab:hover { border-color: var(--muted); color: var(--fg); }
  .time-tab.active {
    background: var(--cat, var(--fg));
    color: #fff;
    border-color: transparent;
  }
  .time-tab .count {
    font-size: 0.68rem;
    opacity: 0.8;
    margin-left: 0.35rem;
  }
  .time-content { display: none; }
  .time-content.active { display: block; }

  /* ===== L3 source-tabs ===== */
  .source-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 1rem 0 1.3rem;
    padding-bottom: 0.8rem;
    border-bottom: 1px solid var(--rule);
  }
  .source-tab {
    background: none;
    border: 1px solid var(--rule);
    padding: 0.36rem 0.9rem;
    border-radius: 999px;
    font-size: 0.83rem;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .source-tab:hover { border-color: var(--muted); color: var(--fg); }
  .source-tab.active {
    background: var(--cat, var(--fg));
    color: #fff;
    border-color: transparent;
  }
  .source-tab .count {
    font-size: 0.7rem;
    opacity: 0.8;
    margin-left: 0.3rem;
  }
  .source-content { display: none; }
  .source-content.active { display: block; }

  /* ===== article cards in raw panels ===== */
  .article {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 1rem 1.15rem;
    margin-bottom: 0.7rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  }
  .article:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
    border-color: var(--muted);
  }
  .article:first-child { padding-top: 1rem; }
  .article:last-child { border-bottom: 1px solid var(--rule); }
  .article-title {
    font-size: 1.02rem;
    margin: 0 0 0.35rem;
    font-weight: 600;
    line-height: 1.45;
  }
  .article-title a { color: var(--fg); text-decoration: none; }
  .article-title a:hover { color: var(--link); text-decoration: underline; }
  .article-meta { color: var(--muted); font-size: 0.76rem; margin: 0 0 0.4rem; }
  .article-stats {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0 0 0.45rem;
    font-feature-settings: "tnum";
  }
  .article-excerpt {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.9rem;
    line-height: 1.62;
  }
  .article-summary {
    margin: 0.6rem 0 0;
    padding: 0.65rem 0.9rem;
    background: var(--card-alt);
    border-left: 3px solid var(--cat, var(--link));
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
    font-size: 0.9rem;
    line-height: 1.62;
    color: var(--fg);
  }
  .summary-label {
    display: inline-block;
    font-size: 0.68rem;
    color: var(--link);
    margin-right: 0.4rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .empty {
    color: var(--muted);
    text-align: center;
    padding: 2.2rem 0;
    font-size: 0.9rem;
    background: var(--card);
    border: 1px dashed var(--rule);
    border-radius: var(--r-md);
  }

  /* ===== trading panel ===== */
  .crypto-widgets {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.6rem;
    margin: 0.4rem 0 1.3rem;
  }
  @media (min-width: 720px) {
    .crypto-widgets { grid-template-columns: repeat(4, 1fr); }
  }
  .crypto-widget {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.8rem 0.9rem;
    text-align: center;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .crypto-widget:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
  .widget-label {
    font-size: 0.7rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 0.3rem;
  }
  .widget-value {
    font-size: 1.5rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    line-height: 1.1;
  }
  .widget-sub {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.25rem;
  }
  .widget-sub.positive { color: #16a34a; }
  .widget-sub.negative { color: #dc2626; }
  @media (prefers-color-scheme: dark) {
    .widget-sub.positive { color: #4ade80; }
    .widget-sub.negative { color: #fca5a5; }
  }
  .crypto-widget.fg-fear-extreme { border-left: 4px solid #b91c1c; }
  .crypto-widget.fg-fear-extreme .widget-value { color: #b91c1c; }
  .crypto-widget.fg-fear { border-left: 4px solid #d97706; }
  .crypto-widget.fg-fear .widget-value { color: #d97706; }
  .crypto-widget.fg-neutral { border-left: 4px solid var(--muted); }
  .crypto-widget.fg-greed { border-left: 4px solid #65a30d; }
  .crypto-widget.fg-greed .widget-value { color: #65a30d; }
  .crypto-widget.fg-greed-extreme { border-left: 4px solid #16a34a; }
  .crypto-widget.fg-greed-extreme .widget-value { color: #16a34a; }
  @media (prefers-color-scheme: dark) {
    .crypto-widget.fg-fear-extreme .widget-value,
    .crypto-widget.fg-fear .widget-value { color: #fca5a5; }
    .crypto-widget.fg-greed .widget-value,
    .crypto-widget.fg-greed-extreme .widget-value { color: #4ade80; }
  }

  .trading-overview-card {
    margin: 0 0 1.6rem;
    padding: 1.1rem 1.4rem;
    background: var(--card);
    border-radius: var(--r-md);
    border-left: 4px solid var(--c-trading);
    box-shadow: var(--shadow-sm);
  }
  .trading-overview-card .eyebrow { display: block; margin-bottom: 0.45rem; }
  .trading-overview-text { font-size: 0.92rem; line-height: 1.75; color: var(--fg-soft); margin: 0; }

  .trading-section-title {
    font-size: 0.98rem;
    font-weight: 600;
    margin: 1.6rem 0 0.9rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    color: var(--fg);
    letter-spacing: 0.05em;
  }

  .trading-picks {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.65rem;
  }
  @media (min-width: 720px) {
    .trading-picks { grid-template-columns: 1fr 1fr; }
  }
  .trading-pick {
    background: var(--card);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--muted);
    border-radius: var(--r-md);
    padding: 0.85rem 1.1rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .trading-pick:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
  .trading-pick.stance-bull { border-left-color: #16a34a; }
  .trading-pick.stance-bear { border-left-color: #dc2626; }
  .trading-pick.stance-neutral { border-left-color: var(--muted); }
  .pick-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.5rem;
  }
  .pick-symbol-block {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pick-symbol { font-weight: 700; font-size: 1rem; color: var(--fg); }
  .pick-name { color: var(--muted); font-size: 0.82rem; }
  .pick-stance {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.65rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .pick-stance-bull { background: rgba(22,163,74,0.12); color: #16a34a; }
  .pick-stance-bear { background: rgba(220,38,38,0.12); color: #dc2626; }
  .pick-stance-neutral { background: var(--card-alt); color: var(--muted); }
  .pick-rationale { margin: 0; font-size: 0.88rem; line-height: 1.65; color: var(--fg-soft); }

  .trading-group-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin: 0.7rem 0 1.3rem;
  }
  .trading-group-tab {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.5rem 1rem;
    border-radius: var(--r-sm);
    font-size: 0.88rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .trading-group-tab:hover { border-color: var(--muted); color: var(--fg); transform: translateY(-1px); }
  .trading-group-tab.active {
    background: var(--c-trading);
    color: #fff;
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .trading-group-tab .count {
    font-size: 0.7rem;
    opacity: 0.8;
    margin-left: 0.4rem;
    font-weight: 400;
  }
  .trading-group-content { display: none; }
  .trading-group-content.active { display: block; animation: fade 0.2s ease; }

  .ticker-card {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: 0.9rem 1.15rem;
    margin-bottom: 0.7rem;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  }
  .ticker-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--muted); }
  .ticker-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.7rem;
  }
  .ticker-id { min-width: 0; }
  .ticker-symbol { margin: 0; font-size: 1.02rem; font-weight: 700; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
  .ticker-name { margin: 0.15rem 0 0; font-size: 0.82rem; color: var(--muted); }
  .ticker-price-block { text-align: right; flex-shrink: 0; }
  .ticker-price { display: block; font-size: 1.08rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ticker-pct { display: inline-block; font-size: 0.84rem; font-weight: 500; margin-top: 0.15rem; font-variant-numeric: tabular-nums; }
  .ticker-pct.positive, .positive { color: #16a34a; }
  .ticker-pct.negative, .negative { color: #dc2626; }

  .ticker-indicators {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.4rem 0.9rem;
    margin: 0;
    font-size: 0.82rem;
    color: var(--fg-soft);
  }
  @media (min-width: 720px) {
    .ticker-indicators { grid-template-columns: repeat(3, 1fr); }
  }
  .ticker-indicators > div { display: flex; gap: 0.4rem; align-items: baseline; min-width: 0; }
  .ticker-indicators dt { color: var(--muted); font-size: 0.74rem; margin: 0; white-space: nowrap; }
  .ticker-indicators dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 500; color: var(--fg); }
  .trend-bullish { color: #16a34a; }
  .trend-bearish { color: #dc2626; }
  .trend-neutral { color: var(--muted); }
  .rsi-overbought { color: #d97706; }
  .rsi-oversold { color: #2563eb; }

  .ticker-signals {
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--rule);
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .signal-pill {
    font-size: 0.72rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-weight: 500;
  }
  .signal-pill.tone-bull { background: rgba(22,163,74,0.13); color: #166534; }
  .signal-pill.tone-bear { background: rgba(220,38,38,0.13); color: #991b1b; }
  .signal-pill.tone-caution { background: rgba(217,119,6,0.15); color: #92400e; }
  @media (prefers-color-scheme: dark) {
    .signal-pill.tone-bull { color: #4ade80; }
    .signal-pill.tone-bear { color: #fca5a5; }
    .signal-pill.tone-caution { color: #fcd34d; }
    .trend-bullish, .positive, .ticker-pct.positive { color: #4ade80; }
    .trend-bearish, .negative, .ticker-pct.negative { color: #fca5a5; }
    .rsi-overbought { color: #fcd34d; }
    .rsi-oversold { color: #93c5fd; }
    .trading-pick.stance-bull { border-left-color: #4ade80; }
    .trading-pick.stance-bear { border-left-color: #fca5a5; }
    .pick-stance-bull { background: rgba(74,222,128,0.15); color: #4ade80; }
    .pick-stance-bear { background: rgba(252,165,165,0.15); color: #fca5a5; }
  }
  .signal-age { opacity: 0.7; font-weight: 400; }

  .trading-risk {
    margin: 1.6rem 0 0;
    padding: 0.95rem 1.3rem;
    background: var(--card);
    border-radius: var(--r-md);
    border-left: 4px solid #d97706;
    box-shadow: var(--shadow-sm);
  }
  .trading-risk .eyebrow { display: block; margin-bottom: 0.4rem; }
  .trading-risk p { margin: 0; font-size: 0.82rem; line-height: 1.65; color: var(--fg-soft); }

  footer {
    margin-top: 2.75rem;
    border-top: 1px solid var(--rule);
    padding-top: 1.2rem;
    color: var(--muted);
    font-size: 0.82rem;
  }
  </style>
</head>
<body>
<main>
  <header class="report-header">
    <span class="eyebrow">${STR.siteTitle}</span>
    <h1 class="report-title">${date}</h1>
    ${process.env.WEB_MODE === "true" ? `<a class="archive-link" href="../archive.html">${STR.archiveLink}</a>` : ""}
  </header>

  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="finance">${CATEGORY_LABELS.finance}<span class="count">${counts.finance}</span></button>
    ${trading ? `<button class="tab" data-tab="trading">${STR.catTrading}<span class="count">${trading.tickers.length}</span></button>` : ""}
    <button class="tab" data-tab="gz">${CATEGORY_LABELS['gz']}<span class="count">${counts['gz']}</span></button>
    <button class="tab tab-fold" data-tab="ipo">${CATEGORY_LABELS['ipo']}<span class="count">${counts['ipo']}</span></button>
    <button class="tab tab-fold" data-tab="tech">${CATEGORY_LABELS.tech}<span class="count">${counts.tech}</span></button>
  </nav>

  <section class="panel active" data-panel="finance">
    ${renderRawCategoryPanel("finance", raw.finance, date)}
  </section>
  ${trading ? `<section class="panel" data-panel="trading">${renderTradingPanel(trading)}</section>` : ""}
  <section class="panel" data-panel="gz">
    ${renderRawCategoryPanel("gz", raw["gz"] || [], date)}
  </section>
  <section class="panel" data-panel="ipo">
    ${renderRawCategoryPanel("ipo", raw["ipo"] || [], date)}
  </section>
  <section class="panel" data-panel="tech">
    ${renderRawCategoryPanel("tech", techMainSubs, date)}
  </section>
  
  

  <footer>
    ${STR.footer}
  </footer>
</main>
<script>
  document.querySelectorAll('.tabs > .tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.dataset.tab;
      document.querySelectorAll('.tabs > .tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('active', p.dataset.panel === target);
      });
    });
  });
  // Scope sub-tab / source-tab toggles to the parent .panel so two L1 panels
  // can share the same data-cat (e.g. tech main + community both data-cat=tech)
  // without stomping on each other's active state.
  document.querySelectorAll('.sub-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.panel');
      if (!panel) return;
      var sub = btn.dataset.sub;
      panel.querySelectorAll('.sub-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      panel.querySelectorAll('.sub-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.subContent === sub);
      });
    });
  });
  // Time split (当天 / 过去7天) — scoped to the parent .sub-content so it
  // doesn't interfere with sibling L2 tabs sharing the same data-cat.
  document.querySelectorAll('.time-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var subContent = btn.closest('.sub-content');
      if (!subContent) return;
      var time = btn.dataset.time;
      subContent.querySelectorAll('.time-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      subContent.querySelectorAll('.time-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.timeContent === time);
      });
    });
  });
  document.querySelectorAll('.source-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var subContent = btn.closest('.sub-content');
      if (!subContent) return;
      var src = btn.dataset.source;
      subContent.querySelectorAll('.source-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      subContent.querySelectorAll('.source-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.sourceContent === src);
      });
    });
  });
  // Trading panel: asset-group sub-tabs (US/crypto/china/commodity)
  document.querySelectorAll('.trading-group-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var grp = btn.dataset.group;
      document.querySelectorAll('.trading-group-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.trading-group-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.group === grp);
      });
    });
  });
</script>
</body>
</html>`;
}

// ----- trading panel -----

const SIGNAL_TONE: Record<string, "bull" | "bear" | "caution"> = {
  "golden-cross": "bull",
  "macd-bull-cross": "bull",
  "above-sma50-sma200": "bull",
  "near-52w-high": "bull",
  "death-cross": "bear",
  "macd-bear-cross": "bear",
  "below-sma50-sma200": "bear",
  "near-52w-low": "bear",
  "rsi-overbought": "caution",
  "rsi-oversold": "caution",
};

const TREND_LABEL: Record<TickerAnalysis["trend"], string> = {
  bullish: STR.trendBullish,
  bearish: STR.trendBearish,
  neutral: STR.trendNeutral,
};

function stanceClass(stance: string): "bull" | "bear" | "neutral" {
  // Supports both legacy ("看多"/"看空") and current ("偏上行"/"偏下行")
  // stance values. The current values were chosen to avoid Sonnet's
  // "no investment advice" guardrail; rendering keeps both readable.
  if (/多|涨|上行|bull/i.test(stance)) return "bull";
  if (/空|跌|下行|bear/i.test(stance)) return "bear";
  return "neutral";
}

function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Use thousand separators only for prices >= 1000
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(dp);
}

function fmtPct(n: number, dp = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(dp)}%`;
}

function renderPickCard(p: WatchlistPick): string {
  const cls = stanceClass(p.stance);
  const symbol = escapeHtml(p.symbol);
  const name = escapeHtml(p.display_name ?? p.symbol);
  const stance = escapeHtml(p.stance);
  const rationale = escapeHtml(p.rationale ?? "");
  return `<article class="trading-pick stance-${cls}">
    <header class="pick-head">
      <div class="pick-symbol-block">
        <span class="pick-symbol">${symbol}</span>
        <span class="pick-name">${name}</span>
      </div>
      <span class="pick-stance pick-stance-${cls}">${stance}</span>
    </header>
    <p class="pick-rationale">${rationale}</p>
  </article>`;
}

function renderTickerCard(t: TickerAnalysis): string {
  const trendCls = t.trend;
  const priceCls = t.pct1Day >= 0 ? "positive" : "negative";
  const pct5Cls = t.pct5Day >= 0 ? "positive" : "negative";
  const signals = t.signals
    .map((s) => {
      const tone = SIGNAL_TONE[s.type] ?? "caution";
      const ageSuffix =
        s.daysAgo !== undefined
          ? ` <span class="signal-age">(${s.daysAgo === 0 ? STR.signalToday : `${s.daysAgo} ${STR.signalDaysAgoSuffix}`})</span>`
          : "";
      return `<span class="signal-pill tone-${tone}">${escapeHtml(s.label)}${ageSuffix}</span>`;
    })
    .join("");
  const currencyPrefix = t.currency === "USD" ? "$" : t.currency === "HKD" ? "HK$" : t.currency === "CNY" ? "¥" : "";
  return `<article class="ticker-card">
    <header class="ticker-head">
      <div class="ticker-id">
        <h3 class="ticker-symbol">${escapeHtml(t.symbol)}</h3>
        <p class="ticker-name">${escapeHtml(t.displayName)}</p>
      </div>
      <div class="ticker-price-block">
        <span class="ticker-price">${currencyPrefix}${fmtNum(t.currentPrice)}</span>
        <span class="ticker-pct ${priceCls}">${fmtPct(t.pct1Day)}</span>
      </div>
    </header>
    <dl class="ticker-indicators">
      <div><dt>${STR.ticker5d}</dt><dd class="${pct5Cls}">${fmtPct(t.pct5Day)}</dd></div>
      <div><dt>${STR.tickerVs52wHigh}</dt><dd>${fmtPct(t.pct52WeekHigh, 1)}</dd></div>
      <div><dt>RSI(14)</dt><dd class="rsi-${t.rsiState}">${fmtNum(t.rsi14, 1)}</dd></div>
      <div><dt>${STR.tickerTrend}</dt><dd class="trend-${trendCls}">${TREND_LABEL[t.trend]}</dd></div>
      <div><dt>SMA 20 / 50 / 200</dt><dd>${fmtNum(t.sma20)} / ${fmtNum(t.sma50)} / ${fmtNum(t.sma200)}</dd></div>
      <div><dt>${STR.tickerMacd}</dt><dd>${fmtNum(t.macd, 3)} / ${fmtNum(t.macdSignal, 3)}</dd></div>
    </dl>
    ${signals ? `<div class="ticker-signals">${signals}</div>` : ""}
  </article>`;
}

function fearGreedTone(value: number): "fear-extreme" | "fear" | "neutral" | "greed" | "greed-extreme" {
  if (value <= 24) return "fear-extreme";
  if (value <= 44) return "fear";
  if (value <= 55) return "neutral";
  if (value <= 74) return "greed";
  return "greed-extreme";
}

function fmtBigUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)} T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)} M`;
  return `$${n.toFixed(0)}`;
}

function renderCryptoWidgets(t: TradingSection): string {
  const fg = t.crypto_fear_greed;
  const cg = t.crypto_global;
  if (!fg && !cg) return "";
  const items: string[] = [];
  if (fg) {
    const tone = fearGreedTone(fg.value);
    items.push(`<div class="crypto-widget fg-${tone}">
      <div class="widget-label">${STR.widgetCryptoFearGreed}</div>
      <div class="widget-value">${fg.value}</div>
      <div class="widget-sub">${escapeHtml(fg.classificationCn)}</div>
    </div>`);
  }
  if (cg) {
    const tone = cg.marketCapChangePct24h >= 0 ? "positive" : "negative";
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetCryptoCap}</div>
      <div class="widget-value">${fmtBigUsd(cg.totalMarketCapUsd)}</div>
      <div class="widget-sub ${tone}">${fmtPct(cg.marketCapChangePct24h)} / 24h</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetBtcDom}</div>
      <div class="widget-value">${cg.btcDominance.toFixed(1)}%</div>
      <div class="widget-sub">ETH ${cg.ethDominance.toFixed(1)}%</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetVolume24h}</div>
      <div class="widget-value">${fmtBigUsd(cg.total24hVolumeUsd)}</div>
      <div class="widget-sub">${STR.widgetActiveCoins} ${cg.activeCryptocurrencies.toLocaleString()}</div>
    </div>`);
  }
  return `<div class="crypto-widgets">${items.join("")}</div>`;
}

function renderTradingPanel(trading: TradingSection): string {
  const tickers = trading.tickers;
  const groupCounts: Record<AssetGroup, number> = {
    "us-equity": 0,
    crypto: 0,
    "china-equity": 0,
    "commodity-fx": 0,
    macro: 0,
  };
  for (const t of tickers) groupCounts[t.group as AssetGroup] = (groupCounts[t.group as AssetGroup] ?? 0) + 1;

  const groupTabs = ASSET_GROUP_ORDER.map(
    (g, i) =>
      `<button class="trading-group-tab${i === 0 ? " active" : ""}" data-group="${g}">${escapeHtml(ASSET_GROUP_LABELS_LOCALIZED[g])}<span class="count">${groupCounts[g] ?? 0}</span></button>`,
  ).join("");

  const groupPanels = ASSET_GROUP_ORDER.map((g, i) => {
    const groupTickers = tickers.filter((t) => t.group === g);
    // Crypto sub-tab carries an extra header widget panel (F&G + global stats)
    const cryptoWidgets =
      g === "crypto" ? renderCryptoWidgets(trading) : "";
    return `<div class="trading-group-content${i === 0 ? " active" : ""}" data-group="${g}">
      ${cryptoWidgets}
      ${groupTickers.length === 0 ? `<p class="empty">${STR.emptyGroup}</p>` : groupTickers.map(renderTickerCard).join("")}
    </div>`;
  }).join("");

  const overview = escapeHtml(trading.market_overview ?? "");
  const risk = escapeHtml(trading.risk_caveat ?? "");

  return `<section class="trading-overview-card">
    <span class="eyebrow">${STR.tradingMarketOverview}</span>
    <p class="overview-text trading-overview-text">${overview}</p>
  </section>

  ${
    trading.watchlist.length > 0
      ? `<section class="trading-watchlist">
    <h2 class="category-title trading-section-title">${STR.tradingTodayFocus}</h2>
    <div class="trading-picks">
      ${trading.watchlist.map(renderPickCard).join("\n")}
    </div>
  </section>`
      : ""
  }

  <section class="trading-tickers">
    <h2 class="category-title trading-section-title">${STR.tradingAllAssets}</h2>
    <nav class="trading-group-tabs">${groupTabs}</nav>
    <div class="trading-group-contents">${groupPanels}</div>
  </section>

  ${
    risk
      ? `<section class="trading-risk">
    <span class="eyebrow">${STR.tradingRiskCaveat}</span>
    <p>${risk}</p>
  </section>`
      : ""
  }`;
}

// ----- markdown -----

function renderBriefMarkdown(b: BriefItem): string {
  const importance = Number.isFinite(b.importance) ? b.importance : 0;
  return `### [${b.title}](${b.url})\n${b.source} · ${STR.mdImportance} ${importance}/10\n\n${b.summary}\n`;
}

function renderSectionMarkdown(title: string, briefs: BriefItem[]): string {
  if (briefs.length === 0) return "";
  return `## ${title}\n\n${briefs.map(renderBriefMarkdown).join("\n")}\n`;
}

export function renderMarkdown(report: DailyReport, date: string): string {
  const blocks: string[] = [];
  blocks.push(`# ${STR.siteTitle} · ${date}\n`);
  if (report.hero_headline) blocks.push(`> ${report.hero_headline}\n`);
  if (report.daily_overview) {
    blocks.push(`## ${STR.mdTodayOverview}\n\n${report.daily_overview}\n`);
  }
  blocks.push(
    renderSectionMarkdown(CATEGORY_DIGEST_LABELS.tech, report.tech_briefs),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS.finance,
      report.finance_briefs,
    ),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS.politics,
      report.politics_briefs,
    ),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS['gd-ipo'],
      report.gd_ipo_briefs,
    ),
  );
  if (report.editor_note) {
    blocks.push(`## ${STR.mdEditorNote}\n\n${report.editor_note}\n`);
  }
  if (report.keywords.length > 0) {
    blocks.push(
      `## ${STR.mdTodayKeywords}\n\n${report.keywords.map((k) => `\`#${k}\``).join(" ")}\n`,
    );
  }
  return blocks.filter(Boolean).join("\n");
}
