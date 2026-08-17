/**
 * 一次性初始化：对 data/article-history.json 中的全部原始条目逐条做 AI 分析，
 * 产出 {title, url, source, summary, importance}（项目 BriefItem 结构），
 * 写入 data/ai-briefs.json（扁平数组，即「存量清单」初始化文件）。
 *
 * 设计要点（贴合用户要求，保持简单）：
 *  - 主键 = url。ai-briefs.json 里已有该 url 的条目就跳过，绝不重复分析。
 *  - 分析结果的 summary 同时写回 article-history.json 对应条目，使 daily.ts
 *    的 applyCache 原生复用（无需改 daily.ts/history.ts 任何逻辑）。
 *  - 断点续跑：被中断后重跑只补缺失条目。
 *  - 复用项目自身的 runLlm（LLM_BACKEND 决定后端：claude-cli / anthropic / openai ...）。
 *
 * 用法：
 *   npx tsx scripts/analyze-init.ts            # 默认 claude-cli 后端
 *   LLM_BACKEND=anthropic ANTHROPIC_API_KEY=sk-... npx tsx scripts/analyze-init.ts
 */
import "./_env";

import fs from "node:fs";
import path from "node:path";

import { runLlm } from "../lib/ai/llm";
import { REPORT_LOCALE } from "../lib/sources/registry";
import { loadHistory } from "../lib/output/history";

const ROOT = process.cwd();
const HISTORY_PATH = path.join(ROOT, "data/article-history.json");
const BRIEFS_PATH = path.join(ROOT, "data/ai-briefs.json");

const BATCH = 15;
const LOCALE = REPORT_LOCALE === "en" ? "en" : "zh";

// ---- 加载已有 briefs（用于断点续跑 + 最终导出）----
function loadBriefs(): Array<Record<string, unknown>> {
  try {
    if (fs.existsSync(BRIEFS_PATH)) {
      const arr = JSON.parse(fs.readFileSync(BRIEFS_PATH, "utf8"));
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    // 损坏则从头开始
  }
  return [];
}

function saveBriefs(briefs: Array<Record<string, unknown>>): void {
  fs.writeFileSync(BRIEFS_PATH, JSON.stringify(briefs, null, 2), "utf8");
}

const SYSTEM_PROMPT_ZH = `你是一名中文编辑，为每日简报批量生成「摘要 + 重要度」。

输入：每条候选有 url、title、source（来源媒体名）、category（tech/finance/politics/gd-ipo）、excerpt（可能为空）。

任务：为每条候选生成：
  - summary：50-120 字中文事实摘要。英文原文→翻译要点；中文原文→凝练。必须保留关键数字（涨跌幅/金额/利率）、机构/公司/人名、地区。中性事实陈述，不标题党，不编造。信息不足则宁可短。
  - importance：1-10 整数，越高越重要。重磅发布/重大政策/大额融资/核心地缘=8-10；行业普通动态=3-5；边缘噪声=1-2。

输出严格 JSON 对象，不要 markdown、不要代码围栏：
{
  "items": [
    { "url": "<原 url 原样复制>", "summary": "<中文摘要>", "importance": <int 1-10> },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 " —— 否则 JSON 解析失败。`;

const SYSTEM_PROMPT_EN = `You are an editor producing batched "summary + importance" for a daily brief.

Input: each candidate has url, title, source (publisher), category (tech/finance/politics/gd-ipo), excerpt (may be empty).

Task: for each candidate produce:
  - summary: 50-120 word factual English summary. Translate key points if non-English; condense if English. Preserve key numbers, orgs, people, regions. Neutral, no hype, no fabrication.
  - importance: integer 1-10, higher = more significant.

Output STRICTLY a JSON object, no markdown:
{ "items": [ { "url": "<exact url>", "summary": "<...>", "importance": <int> }, ... ] }

Quote rule: inside summary use single quotes or curly quotes, never raw double quotes.`;

const USER_HEADER =
  LOCALE === "en"
    ? (n: number) => `Output language: ENGLISH ONLY. Candidate items (${n}):`
    : (n: number) => `输出语言：仅中文。候选条目（共 ${n} 条）：`;

const USER_FOOTER =
  LOCALE === "en"
    ? `Output {"items":[{"url":...,"summary":...,"importance":...}]} — url must be copied exactly.`
    : `请输出 {"items":[{"url":...,"summary":...,"importance":...}]}，url 必须精确回填。`;

async function analyzeBatch(
  batch: Array<{ url: string; title: string; source: string; category: string; excerpt: string }>,
): Promise<Array<{ url: string; summary: string; importance: number }>> {
  const payload = batch.map((b) => ({
    url: b.url,
    title: b.title,
    source: b.source,
    category: b.category,
    excerpt: (b.excerpt ?? "").slice(0, 300),
  }));
  const userPrompt = [
    USER_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    USER_FOOTER,
  ].join("\n");

  const { text } = await runLlm({
    systemPrompt: LOCALE === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH,
    userPrompt,
  });
  // 简单提取 JSON
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const cleaned = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  const parsed = JSON.parse(cleaned);
  const items = parsed.items ?? [];
  return items
    .filter((it: any) => it && it.url && it.summary)
    .map((it: any) => ({
      url: String(it.url),
      summary: String(it.summary).trim(),
      importance: Math.max(1, Math.min(10, Math.round(Number(it.importance) || 1))),
    }));
}

async function main() {
  const history = loadHistory();
  const allEntries = Object.values(history).filter((e) => e.url);

  const briefs = loadBriefs();
  const done = new Set(briefs.map((b) => b.url as string));

  // 候选：history 里有、但 briefs 里还没有的条目
  const candidates = allEntries.filter((e) => !done.has(e.url));
  console.log(
    `[analyze-init] history 总条目 ${allEntries.length} ｜ 已分析 ${done.size} ｜ 待分析 ${candidates.length}`,
  );
  if (candidates.length === 0) {
    console.log("[analyze-init] 全部已分析，无需补充。");
    return;
  }

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    try {
      const results = await analyzeBatch(slice);
      for (const r of results) {
        const entry = history[r.url];
        if (entry) entry.summary = r.summary; // 写回 history，供 daily.ts applyCache 复用
        briefs.push({
          title: entry?.title ?? r.url,
          url: r.url,
          source: entry?.source ?? "",
          summary: r.summary,
          importance: r.importance,
        });
        done.add(r.url);
        ok++;
      }
      // 每批落盘（断点续跑）
      saveBriefs(briefs);
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
      console.log(
        `[analyze-init] 批次 ${Math.floor(i / BATCH) + 1}/${
          Math.ceil(candidates.length / BATCH)
        }：本批命中 ${results.length}/${slice.length} ｜ 累计 ${ok}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail++;
      console.warn(`[analyze-init] 批次失败（跳过，可续跑）：${msg}`);
      // 失败不写入，保留已有进度
    }
  }

  saveBriefs(briefs);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
  console.log(
    `[analyze-init] 完成：成功 ${ok} ｜ 失败批次 ${fail} ｜ ai-briefs.json 当前 ${briefs.length} 条`,
  );
}

main().catch((e) => {
  console.error("[analyze-init] FAILED:", e);
  process.exit(1);
});
