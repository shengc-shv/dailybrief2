import { fetchAttentionVc } from "./attentionvc";
import { fetchCctvFinance, fetchSinaFinance } from "./domestic-finance";
import { fetchGovCnPolicy } from "./national-policy";
import { fetchSinaMoney, fetch21jingjiFinance } from "./wealth-credit";
import { fetchGithubTrending } from "./github-trending";
import { fetchHackerNews } from "./hackernews";
import { fetchHuggingfacePapers } from "./huggingface-papers";
import { fetchLinuxDo } from "./linuxdo";
import { fetchRss } from "./rss";
import { fetchV2ex } from "./v2ex";
import type { RawArticle, SourceDef } from "./types";

/**
 * 节约 AI 成本（用户 2026-08-18）：除商机类来源外，每个资讯源每轮最多取 10 条。
 * 抓得少 → enrich/分类的 LLM 调用少。
 * 商机类来源（广州本地 gz-stats/gz-gov/gz-nansha 及广州辖区 IPO）由爬虫
 * scripts/crawlers/run-gz.mjs 产出、不走 dispatch，无需在此限制；
 * 若未来有商机类源进入 dispatch，在 BUSINESS_SOURCES 白名单中放行。
 */
const BUSINESS_SOURCES = new Set([
  "gz-stats",
  "gz-gov",
  "gz-nansha",
  "gz-sse",
  "gz-szse",
  "gz-bse",
  "gz-hkex",
  "gz-em-ipo",
]);
const PER_SOURCE_FETCH_CAP = 10;

export async function fetchSource(source: SourceDef): Promise<RawArticle[]> {
  let items: RawArticle[];
  if (source.id === "hackernews") items = await fetchHackerNews(source.id);
  else if (source.id === "github-trending") items = await fetchGithubTrending(source.id);
  else if (source.id === "v2ex-hot") items = await fetchV2ex(source.id);
  else if (source.id === "linuxdo") items = await fetchLinuxDo(source.id);
  else if (source.id === "attentionvc-ai") items = await fetchAttentionVc(source.id);
  else if (source.id === "huggingface-papers") items = await fetchHuggingfacePapers(source.id, source.keywords);
  else if (source.id === "sina-finance") items = await fetchSinaFinance(source.id);
  else if (source.id === "cctv-finance") items = await fetchCctvFinance(source.id);
  else if (source.id === "govcn-policy") items = await fetchGovCnPolicy(source.id);
  else if (source.id === "sina-money") items = await fetchSinaMoney(source.id);
  else if (source.id === "21jingji-finance") items = await fetch21jingjiFinance(source.id);
  else
    items = await fetchRss(source.id, source.url, source.category, {
      useCurl: source.useCurl,
    });
  return BUSINESS_SOURCES.has(source.id) ? items : items.slice(0, PER_SOURCE_FETCH_CAP);
}
