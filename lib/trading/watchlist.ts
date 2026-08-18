export type AssetGroup =
  | "us-equity" // 美股蓝筹 + ETF
  | "crypto" // 加密货币
  | "china-equity" // 中概股 / 港股
  | "commodity-fx" // 商品 + 外汇
  | "macro"; // 宏观信号（恐慌指数 / 利率 / 美元指数）

export interface TickerDef {
  symbol: string; // Yahoo Finance symbol
  displayName: string; // 中文展示名
  displayNameEn?: string; // English display name (falls back to displayName if absent)
  group: AssetGroup;
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "us-equity": "美股 / ETF",
  crypto: "加密货币",
  "china-equity": "中概 / 港股",
  "commodity-fx": "商品 / 外汇",
  macro: "宏观信号",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "us-equity": "US Stocks / ETF",
  crypto: "Crypto",
  "china-equity": "China / HK",
  "commodity-fx": "Commodities / FX",
  macro: "Macro",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  // 零售决策视角：A股风向 → 汇率/商品 → 宏观利率 → 全球/风险
  "china-equity",
  "commodity-fx",
  "macro",
  "us-equity",
  "crypto",
];

export const WATCHLIST: TickerDef[] = [
  // === A股大盘（基金/权益产品营销窗口、客户投资意愿）===
  { symbol: "000001.SS", displayName: "上证指数", group: "china-equity" },
  { symbol: "000300.SS", displayName: "沪深300", group: "china-equity" },
  // === 汇率 / 商品（外币理财、结售汇、通胀与避险配置）===
  { symbol: "USDCNY=X", displayName: "美元 / 人民币", displayNameEn: "USD / CNY", group: "commodity-fx" },
  { symbol: "GC=F", displayName: "黄金", displayNameEn: "Gold", group: "commodity-fx" },
  { symbol: "CL=F", displayName: "WTI 原油", displayNameEn: "WTI Crude", group: "commodity-fx" },
  // === 宏观信号（利率/风险情绪：理财收益预期、债市）===
  { symbol: "^TNX", displayName: "10Y 美债收益率 (%)", displayNameEn: "10Y Treasury Yield (%)", group: "macro" },
  { symbol: "^VIX", displayName: "VIX 恐慌指数", displayNameEn: "VIX (Volatility)", group: "macro" },
  // === 全球风向（S&P500）===
  { symbol: "SPY", displayName: "S&P 500", group: "us-equity" },
  // === 加密货币（风险情绪参考）===
  { symbol: "BTC-USD", displayName: "Bitcoin", group: "crypto" },
  { symbol: "ETH-USD", displayName: "Ethereum", group: "crypto" },
];
