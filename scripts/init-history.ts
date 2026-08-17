/**
 * 一次性初始化：把 data/article-history.json 里尚未 AI 分析的条目
 * 用项目自带的 enrich*Summaries() 函数逐条分析，把 summary 写回历史文件。
 *
 * - 风格与 daily.ts 完全一致（复用 lib/ai/enrich.ts 的同一套 prompt / 函数）。
 * - 去重主键与项目一致：url。daily.yml 跑 npm daily 时 applyCache 命中即跳过 LLM。
 * - 可断点续跑：每次只处理缺 summary 的条目，每处理完一个分片就回写文件。
 *
 * 运行：tsx scripts/init-history.ts   （需本地 claude CLI，无需 API key）
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
  enrichTrendingPapersSummaries,
  enrichXViralSummaries,
} from "../lib/ai/enrich";

const HISTORY_PATH = path.resolve(process.cwd(), "data/article-history.json");
const CHUNK = 25;

type Store = Record<string, Record<string, unknown>>;

function load(): Store {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
}
function save(store: Store) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(store, null, 2), "utf8");
}
function xAuthor(url: string): string {
  return url.match(/x\.com\/([^/]+)\//)?.[1] ?? "";
}
function routeOf(srcId: string): "gh" | "x" | "papers" | "finance" {
  if (srcId === "github-trending") return "gh";
  if (srcId === "huggingface-papers") return "papers";
  if (srcId === "attentionvc-ai") return "x";
  return "finance";
}

async function main() {
  const store = load();
  const urls = Object.keys(store);
  console.log(`[init] 历史总条目: ${urls.length}`);

  const groups: Record<string, Array<Record<string, unknown>>> = {
    gh: [],
    x: [],
    papers: [],
    finance: [],
  };
  for (const url of urls) {
    const e = store[url];
    if (e.summary) continue;
    const input: Record<string, unknown> = {
      url: e.url ?? url,
      title: e.title ?? "",
      excerpt: e.excerpt ?? "",
      source: e.source ?? "",
    };
    if (routeOf(String(e.sourceId)) === "x") {
      input.author = xAuthor(String(e.url ?? url));
    }
    groups[routeOf(String(e.sourceId))].push(input);
  }
  const pendingTotal = Object.values(groups).reduce((n, g) => n + g.length, 0);
  console.log(
    `[init] 待分析(无 summary): ${pendingTotal} -> gh:${groups.gh.length} x:${groups.x.length} papers:${groups.papers.length} finance:${groups.finance.length}`,
  );

  let done = 0;
  for (const [route, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      let map: Map<string, string>;
      if (route === "gh") map = await enrichGithubTrendingSummaries(slice as any);
      else if (route === "x") map = await enrichXViralSummaries(slice as any);
      else if (route === "papers") map = await enrichTrendingPapersSummaries(slice as any);
      else map = await enrichFinanceNewsSummaries(slice as any);

      for (const [u, s] of map) {
        if (store[u]) {
          store[u].summary = s;
          done++;
        }
      }
      save(store);
      const chunkNo = Math.floor(i / CHUNK) + 1;
      console.log(
        `[init] ${route} 分片#${chunkNo} 返回 ${map.size} 条，累计写回 ${done}/${pendingTotal}`,
      );
    }
  }
  console.log(`[init] 完成。本次新增分析 ${done} 条（其余条目此前已有 summary）。`);
}

main().catch((e) => {
  console.error("[init] FAILED:", e);
  process.exit(1);
});
