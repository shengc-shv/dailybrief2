import { runLlm } from "./llm";
import { extractJson } from "./json-util";

/**
 * 「执行摘要 / 商机提示」AI 层（用户 2026-08-19 确认实施）
 *
 * 每天一次 LLM 调用，基于当日 宏观政策(finance) + 广州商机(gz) 的高信号条目
 * 与市场点评，产出：
 *  - must_read：今日必读 3-5 条（高影响事件 + 对分行意味着什么）
 *  - insights：商机提示 3-5 条（对广州分行零售/对公的潜在影响 + 建议动作）
 * 把「看新闻」升级为「看结论」。任何失败 → 返回 null，页面不渲染该板块。
 */

export interface ExecInsight {
  /** 主题（一句话，如「LPR 下调预期升温」） */
  topic: string;
  /** 对分行零售/对公业务的潜在影响 */
  impact: string;
  /** 建议动作（获客/产品/风险，可执行） */
  action: string;
}

export interface ExecutiveSummary {
  /** 今日必读：高影响事件 + 为何重要 */
  must_read: Array<{ title: string; why: string }>;
  /** 商机提示：对广州分行零售/对公的潜在影响与建议动作 */
  insights: ExecInsight[];
}

export interface ExecSummaryInput {
  /** 当日宏观政策条目（title + 摘要） */
  finance: Array<{ title: string; summary?: string; subcategory?: string }>;
  /** 当日广州商机条目 */
  gz: Array<{ title: string; summary?: string; subcategory?: string }>;
  /** 市场行情总览（AI 点评，可选） */
  marketOverview?: string;
  /** 报告日期 YYYY-MM-DD */
  date: string;
}

const SYSTEM_PROMPT =
  "你是招商银行广州分行零售决策简报主编。基于当日信息生成「今日必读」与「商机提示」，面向分行信息技术部领导和分管零售的行领导，严格按用户要求输出 JSON。";

const RULES = `你是招商银行广州分行零售决策简报的主编。系统面向分行信息技术部领导和分管零售的行领导，核心诉求：更快掌握宏观经济变化、政府政策变化、市场变化，从而挖掘更多客户、发现更多商机。

基于输入的当日条目（宏观政策 + 广州商机 + 市场总览），输出两部分：

1. must_read（今日必读，3-5 条）：从输入中挑出对广州分行领导"今天最该知道"的高影响事件（如降准降息、LPR、社融、广州产业政策、广州本地金融动态、重要市场转折）。每条：
   - title：事件标题（15 字内，可精简）
   - why：为什么重要——对广州分行零售/对公意味着什么（30-50 字）

2. insights（商机提示，3-5 条）：把当日信息转化为"在广州可落地的商机/风险"，每条：
   - topic：主题（15 字内）
   - impact：对广州分行零售/对公业务的潜在影响（40-60 字）
   - action：建议动作——具体可执行（获客方向/产品配置/风险提示，40-60 字），如"关注消费贷客群、加大理财配置推荐、提示按揭风险"

要求：
- 只基于输入信息，不要编造
- 广州本地信息（南沙/广州企业/广州政策）优先于泛全国信息
- 语言精炼，站在分行行长视角，不写空话套话
- 输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"must_read":[{"title":"...","why":"..."}],"insights":[{"topic":"...","impact":"...","action":"..."}]}
注意：字符串内引号用单引号或中文引号，禁止裸双引号。`;

export async function generateExecutiveSummary(
  input: ExecSummaryInput,
): Promise<ExecutiveSummary | null> {
  const payload = {
    date: input.date,
    market_overview: input.marketOverview ?? "",
    finance: input.finance.slice(0, 12),
    gz: input.gz.slice(0, 12),
  };
  const userPrompt = [
    RULES,
    "",
    `当日信息（JSON）：`,
    JSON.stringify(payload),
    "",
    "请输出 {\"must_read\": [...], \"insights\": [...]}，must_read 3-5 条、insights 3-5 条。",
  ].join("\n");
  try {
    const { text } = await runLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 240_000 });
    const cleaned = extractJson(text);
    let parsed: ExecutiveSummary;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonrepair = (await import("jsonrepair")).jsonrepair;
      parsed = JSON.parse(jsonrepair(cleaned));
    }
    if (!Array.isArray(parsed.must_read) || !Array.isArray(parsed.insights)) return null;
    return {
      must_read: parsed.must_read.slice(0, 5),
      insights: parsed.insights.slice(0, 5),
    };
  } catch {
    return null;
  }
}
