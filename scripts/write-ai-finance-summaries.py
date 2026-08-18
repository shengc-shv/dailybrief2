#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国内财经 / 国际财经 AI 解读（由 WorkBuddy 逐条产出，银行零售视角）
读取 article-history.json 中 cn-finance（新浪/央视）与 news（国际）源条目，
按标题规则+逐条定制生成解读写入 summary；白酒/个股价格等杂讯判 ai_relevant=false。
"""
import json, re

HIST = json.load(open("data/article-history.json", encoding="utf8"))
FIN_SRCS = {"sina-finance", "cctv-finance", "bloomberg-markets", "ft-companies",
            "bbc-business", "economist-finance", "cnbc-top", "yahoo-finance",
            "investing-news", "guardian-business", "fed-press", "ftchinese"}

# ---------- 国内财经（新浪/央视）逐条定制解读 ----------
CN_INTERPRET = {
    "贷款“降速提质” 居民存款仍在搬家": "7月信贷降速、存款搬家：居民资金向理财/基金等转移，是财富管理业务与存款稳定性管理的双重信号。",
    "多家银行竞推“算力贷” “算力证明信用”能走多远": "银行竞推算力贷：以算力资产增信服务AI企业，是科技金融创新点，可关注对公联动与风险模型。",
    "营收注水、减值随意、研发乱账……证监会年报监管报告点名八大乱象": "证监会年报监管点名财务乱象：银行业尽调/审计需强化财务真实性识别，防范信贷风险。",
    "7月金融数据出炉：信贷结构持续优化、债券与股票融资占比继续提升": "7月金融数据：信贷结构优化、直接融资占比提升，反映实体经济融资渠道变化，影响银行信贷投放策略。",
    "银行业从严监管“穿透到人” 今年以来共罚款12.19亿元禁业178人": "银行业严监管穿透到人：合规红线收紧，分行需强化员工行为管理与消保合规。",
    "5年期存款利率逆势上升！发生了什么？": "5年期存款利率逆势上行：负债成本承压，关注存款定价竞争与理财替代效应。",
    "我国保险资金运用余额首次突破40万亿元": "保险资金运用余额破40万亿：险资配置需求旺盛，是银保/代销业务与高净值客群联动机会。",
    "北京保险业全面规范短期健康险互联网宣传与销售": "监管规范短期健康险互联网销售：代销合规要求提升，保险产品准入与销售话术需同步调整。",
    "金融监管总局：保险业快速应对台风“白海豚”已赔付3409万元": "保险业快速理赔台风灾害：灾害理赔案例可作风险教育与保险销售切入点。",
    "Token能贷款了！AI产业迎来全新融资标尺": "AI产业数据资产融资新标尺：数据资产质押/评估是未来信贷创新方向，宜提前研究。",
    "电脑价格7月涨幅超17%，专家称最快明年下半年缓解压力": "电脑等电子产品涨价：短期通胀信号，关注消费类信贷需求与通胀预期管理。",
    "吉利汽车上半年营收1736亿元，核心归母净利润劲增46%": "吉利半年报营收利润双增：汽车产业链景气，相关企业客群是代发与供应链金融机会。",
    "频准激光上市首日开盘涨488%，中一签浮盈超45万": "新股频准激光首日暴涨：打新财富效应显著，是零售财富客户关注热点与权益营销窗口。",
    "A股年内最贵新股来了！频准激光高开488% 单签赚超45万创历史记录": "A股最贵新股首日大涨：打新收益高企，可引导财富客户参与新股/权益配置。",
    "金价升破4430美元，机构称还能涨超60%": "金价突破4430美元：避险与通胀配置需求强劲，是贵金属/黄金积存业务营销窗口。",
    "人民币兑美元中间价报6.7905，下调32点": "人民币中间价下调：汇率波动影响外币理财与结售汇客户，需提示汇率风险与配置策略。",
    "中汽协：7月乘用车出口92.2万辆，同比增长84.6%": "乘用车出口高增84.6%：汽车出海产业链景气，相关企业融资与供应链金融机会。",
    "57岁黄建军空降接任申万宏源总经理，能否突破发展瓶颈？": "券商高管变动：券商经营调整，代销渠道合作策略可跟踪。",
    "顾雷：数智赋能地方金融 严守监管合规底线": "数智赋能地方金融：银行数字化风控与合规建设是信息技术部关注方向。",
    "连平：金融服务实体经济方式正在发生深刻转变": "金融服务实体经济方式转变：信贷投向与综合金融服务模式需向产业/科创倾斜。",
    "付一夫：县域消费再度迎来政策东风": "县域消费政策利好：下沉市场客群是消费贷/信用卡/收单的新增长点。",
    "罗志恒：如何理解“供强需弱”的深层逻辑？——7月经济运行观察": "供强需弱宏观分析：需求端偏弱提示零售信贷与消费刺激的空间与策略。",
    "快讯：恒指低开0.33% 科指跌0.28% 科网股低迷 黄金股普涨 光通信板块高开": "港股低开黄金股涨：市场避险情绪，财富客户配置建议向黄金/固收倾斜。",
    "华宝基金红利风向标 | 指数继续回暖，港股红利攻守兼备": "港股红利策略受关注：红利/高股息是稳健型财富客户配置方向。",
    "华宝基金ETF早知道：8月18日": "ETF市场动态：指数基金配置热度反映财富客户风险偏好。",
    "余敬中：恒科指变阵触发港股硬科技“破壁”时刻": "港股硬科技崛起：科技主题投资机会，财富客户权益配置参考。",
    "华住集团-S早盘高开逾11% 二季度业绩稳健增长公司上调全年指引": "华住二季度业绩高增：消费服务景气，相关企业及从业客群是代发/经营贷机会。",
    "周生生早盘高开逾11% 预计上半年盈利约21亿至22亿港元": "周生生盈利预喜：黄金珠宝消费旺盛，贵金属销售与消费金融联动机会。",
    "开盘：三大指数集体低开 工业金属板块跌幅居前": "A股低开工业金属走弱：市场情绪偏谨慎，权益类产品销售节奏宜稳健。",
    "上半年亏损超6亿，芯原股份亟待百亿AI订单扭转局面": "芯原股份亏损承压：半导体企业现金流压力，科创企业信贷风险需关注。",
    "招商蛇口浙江公司负责人赵海峰被调查，涉嫌商务饭局中侵犯女性": "招商系高管被查：企业合规与声誉事件，涉事企业关联业务宜审慎。",
    "孚宝智能科技董事长贾国强：AI产品规模化出海的堵点与破局": "AI产品出海观察：科技企业出海融资与外汇服务机会。",
    "铜市供需持续失衡，LME库存单月骤降32%，矿业股迎来新一轮上行机遇": "铜市供需失衡：大宗商品价格上行，相关产业链企业融资与商品类产品机会。",
    "光模块科普③ | 一个视频看懂“易、中、天”产业链分工": "光模块产业链：科技产业科普，对公科技金融方向参考。",
    "观星程|车能融合下，充电产业如何突破低效竞争困局？": "充电产业竞争：新能源基础设施企业融资需求，对公业务参考。",
    "电商“AB货”，乱象背后是行业内卷": "电商AB货乱象：商户经营规范性风险，收单/商户贷风控提示。",
    "组合拳出击，叫停“速成车”": "整治速成车乱象：行业规范治理，相关产业信贷审慎。",
    "落实防范打击非法金融要求 多地监管优化治理机制": "打击非法金融：消保与合规治理，分行需配合开展风险排查。",
}

# ---------- 规则：无关杂讯（白酒/个股价格、娱乐、体育等） ----------
CN_NOISE = re.compile(
    r"水晶剑南春|青花郎|习酒|古井贡|洋河梦之蓝|国窖1573|五粮液|精品茅台|飞天茅台|青花汾|茅台五粮液|名酒"
    r"|剑南春|泸州老窖|早盘三分钟|中一签|单签|涨488|汽车之家"
)
INTL_NOISE = re.compile(
    r"Ferrari|Lamborghini|Tesla FSD|Mangione|gun|shooting|freeze her eggs|college|football|sports|soccer"
    r"|Marijuana|cannabis|World Liberty|Instagram|Facebook|Meta loses|AOC|grandma|pets|dog|cat"
    r"|pubs|bar|restaurant|movie|film|celebrity|tiktok|influencer"
)

def interp_cn(title):
    for k, s in CN_INTERPRET.items():
        if k in title:
            return s
    return ""

def interp_intl(title):
    t = title.lower()
    # 国际宏观/金融相关 → 解读；杂讯 → 无关（返回空，由调用处判 false）
    if "fed" in t or "treasury" in t or "federal reserve" in t:
        return "美联储/美债动态：全球利率与美元走势影响国内资产配置与外币理财策略。"
    if "rate" in t or "mortgage" in t or "heloc" in t or "refinance" in t:
        return "美国房贷/利率动态：跨境利率环境参考，提示国内房贷利率趋势与海外置业客群。"
    if "oil" in t or "copper" in t or "gold" in t or "commodity" in t:
        return "大宗商品（原油/铜/黄金）动态：通胀与避险信号，关联贵金属与商品类财富产品。"
    if "china" in t or "xi " in t or "yuan" in t:
        return "中国经济相关报道：外部视角观察中国经济，提示宏观政策与市场预期变化。"
    if "japan" in t or "yen" in t:
        return "日本经济/日元动态：全球资金流向与套息交易风险，影响跨境资产配置。"
    if "euro" in t or "eu " in t or "germany" in t or "france" in t:
        return "欧洲经济动态：全球需求与贸易环境参考，间接影响出口链企业信贷。"
    if "bank" in t or "lending" in t or "credit" in t:
        return "海外银行/信贷动态：国际信贷环境与金融创新参考。"
    if "trump" in t:
        return "美国政治经济动态：政策不确定性影响全球市场情绪与资产配置。"
    if "nvidia" in t or "openai" in t or "ai " in t or "data centre" in t:
        return "AI产业投资动态：全球AI资本开支高企，科技产业链融资与财富科技主题参考。"
    if "india" in t:
        return "印度经济动态：新兴市场需求与供应链转移参考。"
    if "uk " in t or "britain" in t or "london" in t or "ftse" in t:
        return "英国/欧洲市场动态：全球市场情绪参考。"
    return ""  # 未命中主题：由规则判无关或留空

updated = 0
marked_noise = 0
for url, e in HIST.items():
    sid = e.get("sourceId", "")
    if sid not in FIN_SRCS:
        continue
    title = e.get("title", "")
    if e.get("ai_relevant") is False:
        continue  # 已判无关
    # 国内：杂讯判无关
    if sid in ("sina-finance", "cctv-finance"):
        if CN_NOISE.search(title) and sid == "sina-finance":
            e["ai_relevant"] = False
            marked_noise += 1
            continue
        s = interp_cn(title)
        if s and s != e.get("summary"):
            e["summary"] = s
            updated += 1
        continue
    # 国际：杂讯判无关，否则主题解读
    if INTL_NOISE.search(title):
        e["ai_relevant"] = False
        marked_noise += 1
        continue
    s = interp_intl(title)
    if s and s != e.get("summary"):
        e["summary"] = s
        updated += 1

json.dump(HIST, open("data/article-history.json", "w", encoding="utf8"), ensure_ascii=False, indent=2)
print(f"✅ 国内/国际财经解读：更新 {updated} 条 summary，判无关 {marked_noise} 条")

# 统计
from collections import Counter
fin = [v for v in HIST.values() if v.get("sourceId") in FIN_SRCS]
print(f"国内/国际财经条目 {len(fin)}，带 summary {sum(1 for v in fin if v.get('summary'))}，ai_relevant=false {sum(1 for v in fin if v.get('ai_relevant') is False)}")
