import { runLlm } from "./llm";
import { extractJson } from "./json-util";

/**
 * 条目级 LLM 分类（并入 daily 流程）
 *
 * 对新增条目批量调用 LLM，输出 { relevant(是否与银行业务相关), subcategory(业务线子标签), summary(银行视角摘要) }。
 * 任何失败（余额不足 402 / 网络 / 解析）→ 返回空 Map，调用方降级到启发式/注册表，绝不影响 daily 主流程。
 */

export interface ItemClassifyResult {
  relevant: boolean;
  subcategory: string;
  summary: string;
}

const SYSTEM_PROMPT =
  "你是招商银行广州分行零售决策简报编辑。逐条判断相关性、归类业务线子标签、写银行视角摘要，严格按用户要求输出 JSON。";

const RULES = `你是招商银行广州分行零售决策简报的编辑。系统面向分行信息技术部领导和分管零售的行领导，核心诉求：更快掌握宏观经济/政府政策/市场变化，挖掘更多客户、发现更多商机。

对每条信息逐条判断：

1. relevant（bool）：对银行零售业务（财富管理/个人信贷/零售客群/私行业务）或分行经营决策是否有参考价值。
   - 无关示例（判 false）：历史建筑保护、门前三包、交通管制、环境保护、司法行政决定书、招聘公告、纯个股行情/白酒价格/娱乐八卦等。
   - 相关示例（判 true）：经济数据、金融与信贷政策、房地产/房贷、产业扶持与招商、企业 IPO/融资、消费与客群动态、理财/基金/保险/黄金、银行经营与监管。

2. subcategory（string，仅 relevant=true 时填写，否则留空）：
   - gz-wealth：财富管理（理财/基金/保险/黄金/存款/利率）
   - gz-credit：个人信贷（房贷/消费贷/经营贷/普惠/银行经营）
   - gz-customer：零售客群（居民消费/社零/收入/人口/就业）
   - gz-private：私行业务（家族企业/股权/企业主/高端产业扶持）
   - gz-ipo：企业 IPO/上市/融资/辅导（广州辖区）
   - gz-policy：广州市级/南沙政府政策文件
   - cn-policy：国家级宏观政策（国务院/央行/部委）
   - news：国际宏观

3. summary：40-70 字中文摘要，站在银行零售业务视角点出这条信息意味着什么、对分行有什么启示。

输出 STRICTLY 一个 JSON 对象（无 markdown 代码块）：
{"items":[{"url":"<必须原样回填输入的url>","relevant":true,"subcategory":"gz-xxx","summary":"..."}]}

注意：summary 内的引号请用单引号或中文引号，禁止裸双引号。`;

export async function classifyItemsWithLlm(
  items: Array<{ url: string; title: string; source?: string }>,
  batchSize = 40,
): Promise<Map<string, ItemClassifyResult>> {
  const result = new Map<string, ItemClassifyResult>();
  if (items.length === 0) return result;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const userPrompt = [
      RULES,
      "",
      `候选条目（共 ${batch.length} 条，JSON 数组，每条含 url/title/source）：`,
      JSON.stringify(batch),
      "",
      "请逐条分析并输出 {\"items\": [...]}，url 必须精确回填输入值。",
    ].join("\n");
    try {
      const { text } = await runLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs: 240_000 });
      const cleaned = extractJson(text);
      let parsed: { items?: Array<{ url?: string; relevant?: boolean; subcategory?: string; summary?: string }> };
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const jsonrepair = (await import("jsonrepair")).jsonrepair;
        parsed = JSON.parse(jsonrepair(cleaned));
      }
      for (const x of parsed.items ?? []) {
        if (x.url) {
          result.set(x.url, {
            relevant: x.relevant === true,
            subcategory: (x.subcategory || "").trim(),
            summary: (x.summary || "").trim(),
          });
        }
      }
    } catch {
      // 单批失败（402/网络/解析）→ 跳过该批，调用方降级
    }
  }
  return result;
}
