import "./_env";
import fs from "node:fs";
import { runLlm } from "../lib/ai/llm";
import { extractJson } from "../lib/ai/json-util";
import { loadAllSources } from "../lib/sources/registry";
import { fetchGovCnPolicy } from "../lib/sources/national-policy";
import { fetchSinaMoney, fetch21jingjiFinance } from "../lib/sources/wealth-credit";

/**
 * 广州商机 / 宏观政策 数据逐条 AI 分析
 *
 * 背景：源级粗分（注册表 subcategory）粒度太粗——广州市政府的「历史建筑/门前三包」
 * 通告、南沙的「照明电费补贴」等城市治理内容对银行领导无价值，却混进「广州政策/私行」。
 * 本脚本对已抓取条目逐条调用 LLM：
 *   - relevant：是否对银行零售业务 / 分行决策有参考价值（无关内容标记 false 供渲染过滤）
 *   - subcategory：归哪个业务线子标签（条目级，覆盖注册表源级映射）
 *   - summary：银行视角的一句话摘要
 * 结果写入 data/gz-analysis.json，并 merge 进 data/article-history.json（历史库）。
 *
 * 用法：tsx scripts/analyze-gz.ts [--write-history]
 */

const BATCH = 40;
// 注意：claude-cli 的 --append-system-prompt 走 argv+shell，多行/特殊字符会被 shell 拆解；
// 详细规则必须放 userPrompt（走 stdin，安全），systemPrompt 只留单行。
const SYSTEM_PROMPT =
  "你是招商银行广州分行零售决策简报编辑。逐条判断相关性、归类业务线子标签、写银行视角摘要，严格按用户要求输出 JSON。";

/**
 * 启发式分类（--heuristic，零成本，AI 余额不足时的降级方案）：
 * 按标题关键词逐条判断 relevant + subcategory。规则优先级：无关 > 具体业务 > 政策/宏观。
 */
const HEURISTIC_RULES: Array<{ re: RegExp; relevant?: boolean; sub?: string }> = [
  // 1) 与银行业务无关的城市治理/行政事务（先判，命中即过滤）
  // 注意：'民政' 会误匹配 '人民政府'（子串），必须用 '民政局' 等精确词
  { re: /历史建筑|门前三包|禁燃|黑烟|柴油货车|限行|交通管制|禁停|环境保护|生态|绿化|消防|防汛|水务|河道|畜牧|兽医|文物|非遗|民政局|街道办|居委会|司法厅|决定书|注销|律师|执业|行政许可|招聘|竞投|摆卖|摊位|路灯|景观照明|电费补贴|排污|噪声|拆迁补偿|工伤|社保待遇|教师资格|招生|赛事|演出|博物馆|公园|厕所|殡葬|诊所备案|欠薪|养犬|渔港|见义勇为|储备土地|低保|入学|气瓶/, relevant: false },
  // 2) 企业融资（广州辖区 IPO/上市/辅导）
  { re: /IPO|上市|辅导备案|发行|招股|股份公司.*注册/, sub: "gz-ipo" },
  // 3) 财富管理
  { re: /理财|基金|保险|黄金|财富|资产配置|私人银行|代销|AUM|信托/, sub: "gz-wealth" },
  // 4) 个人信贷
  { re: /信贷|贷款|房贷|消费贷|经营贷|按揭|公积金|利率|首付|融资担保/, sub: "gz-credit" },
  // 5) 零售客群
  { re: /社零|消费|零售|居民|收入|人口|就业|物价|CPI|民生|储蓄|存款|支付|商圈|市场运行/, sub: "gz-customer" },
  // 6) 私行业务（高端产业/企业主）
  { re: /家族|股权|企业主|专精特新|半导体|集成电路|生物医药|高端制造|人工智能|芯片|知识产权|补贴|兑现|产业扶持|招商引资|独角兽/, sub: "gz-private" },
  // 7) 国家级宏观政策
  { re: /国务院|国办|人民银行|央行|金融监管总局|国家统计局|发改委|财政部|工信部|商务部|证监会/, sub: "cn-policy" },
  // 8) 国际宏观
  { re: /美联储|美国|欧洲|日本|国际|海外|G7|世界银行|IMF/, sub: "news" },
  // 9) 兜底：广州/南沙政府政策文件（政策本身）
  { re: /政策|办法|规划|方案|措施|实施细则|管理办法|规定|条例|通告|标准|指南|通知/, sub: "gz-policy" },
];

function classifyHeuristic(title: string, sourceId: string): { relevant: boolean; subcategory: string } {
  // 国家级源（govcn）优先归 cn-policy，避免被南沙/广州的产业关键词误配
  if (sourceId === "govcn-policy") {
    return { relevant: true, subcategory: "cn-policy" };
  }
  for (const r of HEURISTIC_RULES) {
    if (r.re.test(title)) {
      if (r.relevant === false) return { relevant: false, subcategory: "" };
      return { relevant: true, subcategory: r.sub || "" };
    }
  }
  // 完全未命中：政府源默认相关并归广州政策；财富/信贷源按源兜底；其他源默认相关（源级兜底）
  if (sourceId === "gz-gov") return { relevant: true, subcategory: "gz-policy" };
  if (sourceId === "sina-money") return { relevant: true, subcategory: "gz-wealth" };
  if (sourceId === "21jingji-finance") return { relevant: true, subcategory: "gz-credit" };
  return { relevant: true, subcategory: "" };
}

const ANALYSIS_RULES = `你是招商银行广州分行零售决策简报的编辑。系统面向分行信息技术部领导和分管零售的行领导，核心诉求：更快掌握宏观经济/政府政策/市场变化，挖掘更多客户、发现更多商机。

对每条信息逐条判断：

1. relevant（bool）：对银行零售业务（财富管理/个人信贷/零售客群/私行业务）或分行经营决策是否有参考价值。
   - 无关示例（判 false）：历史建筑保护、门前三包、交通管制、环境保护、禁燃禁烟、司法行政决定书、招聘公告、普通民生通知等纯城市治理/行政事务。
   - 相关示例（判 true）：经济数据（社零/居民收入/CPI）、金融与信贷政策、房地产/房贷、产业扶持与招商、企业 IPO/融资/上市、消费与客群动态、税收/社保/个税等。

2. subcategory（string，仅 relevant=true 时填写，否则留空）：
   - gz-policy：广州市级/南沙的政府政策文件、产业扶持、招商政策（政策本身）
   - gz-wealth：财富管理（理财/基金/保险/投资/资产配置/黄金）
   - gz-credit：个人信贷（房贷/消费贷/经营贷/利率/首付）
   - gz-customer：零售客群（居民消费/社零/收入/人口/就业/民生金融）
   - gz-private：私行业务（家族企业/股权/企业主/高端产业/专精特新扶持）
   - gz-ipo：广州辖区（广州/南沙/湛江/清远）企业 IPO/上市/融资/辅导
   - cn-policy：国家级宏观政策（国务院/央行/部委）
   - news：国际宏观

3. summary：40-70 字中文摘要，站在银行零售业务视角点出这条信息意味着什么、对分行有什么启示。不要空话套话。

输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"items":[{"url":"<必须原样回填输入的url>","relevant":true,"subcategory":"gz-xxx","summary":"..."}]}

注意：summary 内的引号请用单引号或中文引号，禁止裸双引号（会破坏 JSON）。`;

async function analyzeBatch(
  batch: Array<{ url: string; title: string; source: string }>,
): Promise<Array<{ url: string; relevant: boolean; subcategory: string; summary: string }>> {
  const userPrompt = [
    ANALYSIS_RULES,
    "",
    `候选条目（共 ${batch.length} 条，JSON 数组，每条含 url/title/source）：`,
    JSON.stringify(batch),
    "",
    "请逐条分析并输出 {\"items\": [...]}，url 必须精确回填输入值。",
  ].join("\n");
  const { text } = await runLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 240_000 });
  const cleaned = extractJson(text);
  let parsed: { items?: Array<{ url?: string; relevant?: boolean; subcategory?: string; summary?: string }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonrepair = (await import("jsonrepair")).jsonrepair;
    parsed = JSON.parse(jsonrepair(cleaned));
  }
  return (parsed.items ?? [])
    .filter((x) => x.url)
    .map((x) => ({
      url: x.url!,
      relevant: x.relevant === true,
      subcategory: (x.subcategory || "").trim(),
      summary: (x.summary || "").trim(),
    }));
}

async function main() {
  // ---- 1. 收集条目 ----
  const gz = JSON.parse(fs.readFileSync("data/crawled-gz.json", "utf8"));
  const ipoPath = "data/crawled-articles.json";
  const ipo = fs.existsSync(ipoPath) ? JSON.parse(fs.readFileSync(ipoPath, "utf8")) : [];
  const govcn = await fetchGovCnPolicy("govcn-policy", 20).catch((e) => {
    console.warn("govcn 抓取失败:", e.message);
    return [];
  });
  // 财富/信贷商机源（新浪理财保险 + 21财经金融）
  const sinaMoney = await fetchSinaMoney("sina-money", 20).catch(() => []);
  const jingji = await fetch21jingjiFinance("21jingji-finance", 20).catch(() => []);

  const regById = new Map(loadAllSources().map((s) => [s.id, s.category]));
  const items = [
    ...gz.map((x: any) => ({
      url: x.url, title: x.title, source: x.source || "广州政府", srcId: x.sourceId,
      // category 按注册表路由（gz-gov→finance 宏观政策；gz-stats/gz-nansha→gz 商机）
      category: regById.get(x.sourceId) ?? "gz", publishedAt: x.publishedAt || undefined,
    })),
    ...govcn.map((x: any) => ({
      url: x.url, title: x.title, source: "中国政府网", srcId: x.sourceId,
      category: "finance", publishedAt: x.publishedAt ? x.publishedAt.toISOString() : undefined,
    })),
    ...sinaMoney.map((x: any) => ({
      url: x.url, title: x.title, source: "新浪理财保险", srcId: x.sourceId,
      category: "gz", publishedAt: x.publishedAt ? x.publishedAt.toISOString() : undefined,
    })),
    ...jingji.map((x: any) => ({
      url: x.url, title: x.title, source: "21财经", srcId: x.sourceId,
      category: "gz", publishedAt: x.publishedAt ? x.publishedAt.toISOString() : undefined,
    })),
    ...ipo.map((x: any) => ({
      url: x.url, title: x.title, source: x.source || "交易所", srcId: x.sourceId,
      category: x.region === "gz" ? "gz" : "ipo", publishedAt: x.publishedAt || undefined,
    })),
  ].filter((x: any) => x.url && x.title);

  console.log(`共 ${items.length} 条待分析（gz ${gz.length} + govcn ${govcn.length} + ipo ${ipo.length}）`);

  // ---- 2. 分类（--heuristic 走零成本启发式；默认走 LLM 批量分析）----
  const analysis: Record<string, { relevant: boolean; subcategory: string; summary: string }> = {};
  if (process.argv.includes("--heuristic")) {
    console.log("ℹ️ --heuristic 模式：零成本关键词分类（AI 余额不足时的降级方案）");
    for (const it of items) {
      const c = classifyHeuristic(it.title, it.srcId);
      analysis[it.url] = { relevant: c.relevant, subcategory: c.subcategory, summary: "" };
    }
  } else {
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      console.log(`[batch ${i / BATCH + 1}] 分析 ${batch.length} 条…`);
      try {
        const rows = await analyzeBatch(batch);
        for (const r of rows) {
          if (r.url) analysis[r.url] = { relevant: r.relevant, subcategory: r.subcategory, summary: r.summary };
        }
        console.log(`  → 返回 ${rows.length} 条`);
      } catch (e: any) {
        console.warn(`  batch 失败: ${e.message}`);
      }
    }
  }

  fs.writeFileSync("data/gz-analysis.json", JSON.stringify(analysis, null, 2), "utf8");
  const rel = Object.values(analysis).filter((a) => a.relevant).length;
  console.log(`\n✅ 分析完成：${Object.keys(analysis).length} 条有结果，其中 relevant=${rel}，irrelevant=${Object.keys(analysis).length - rel}`);

  // ---- 3. 按 subcategory 统计 ----
  const bySub: Record<string, number> = {};
  for (const a of Object.values(analysis)) {
    if (a.relevant) bySub[a.subcategory || "(无)"] = (bySub[a.subcategory || "(无)"] || 0) + 1;
  }
  console.log("相关条目子标签分布:", JSON.stringify(bySub, null, 2));

  // ---- 4. 全量写进历史库（按 HistoryEntry 完整格式：已有则更新，缺失则新增）----
  if (process.argv.includes("--write-history")) {
    const histPath = "data/article-history.json";
    const hist = JSON.parse(fs.readFileSync(histPath, "utf8"));
    const now = new Date().toISOString();
    const metaByUrl = new Map(items.map((it: any) => [it.url, it]));
    let updated = 0, created = 0;
    for (const [url, a] of Object.entries(analysis)) {
      const meta = metaByUrl.get(url);
      if (!meta) continue;
      const prev = hist[url];
      hist[url] = {
        title: prev?.title ?? meta.title,
        url,
        sourceId: prev?.sourceId ?? meta.srcId ?? "gz-local",
        source: prev?.source ?? meta.source ?? "广州商机",
        category: (meta.category ?? prev?.category ?? "gz") as any,
        // 条目级 AI/启发式分类（覆盖注册表源级）；无关条目也保留分类供过滤
        subcategory: a.subcategory || prev?.subcategory,
        excerpt: prev?.excerpt ?? "",
        publishedAt: prev?.publishedAt ?? meta.publishedAt,
        // 银行视角摘要（LLM 模式产出；启发式模式为空则不覆盖既有摘要）
        summary: a.summary && a.summary.length > 10 ? a.summary : prev?.summary,
        ai_relevant: a.relevant,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
      };
      if (prev) updated++;
      else created++;
    }
    fs.writeFileSync(histPath, JSON.stringify(hist, null, 2), "utf8");
    console.log(`\n📚 历史库全量写入完成：新增 ${created} 条，更新 ${updated} 条（data/article-history.json，共 ${Object.keys(hist).length} 条）`);
  } else {
    console.log("\n（未写历史库；如需写入加 --write-history）");
  }
}

main().catch((e) => {
  console.error("分析失败:", e);
  process.exit(1);
});
