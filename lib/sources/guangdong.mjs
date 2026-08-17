/**
 * 广东地区企业识别（纯文本关键词匹配）
 *
 * 适用场景：没有股票代码可解析省份的源——例如国外 RSS 资信源（Crunchbase News /
 * TechCrunch / EU-Startups / StrictlyVC）和港交所英文公告。这些源无法像沪深北那样
 * 用东方财富 F10 按代码解析省份，只能用「公司名/正文中出现的广东城市名」来识别。
 *
 * 关键词 = 广东 21 个地级市的中英文名称。刻意不含过于宽泛的 "China"（几乎每家中国
 * 公司都会命中，会淹没真正属于广东的企业）。
 *
 * 该列表与 scripts/crawlers/sources/hkex-ipo.mjs 中使用的 GUANGDONG_KEYWORDS 保持一致，
 * 作为广东地区识别的单一事实来源。
 */

// 广东（含 21 个地级市）中英文城市名
export const GUANGDONG_KEYWORDS = [
  // 中文
  '广东', '广州', '深圳', '东莞', '佛山', '珠海', '中山', '惠州', '江门', '汕头',
  '湛江', '肇庆', '梅州', '汕尾', '河源', '阳江', '清远', '潮州', '揭阳', '云浮',
  // 英文（与中文一一对应，标题大小写不敏感匹配）
  'Guangdong', 'Shenzhen', 'Guangzhou', 'Dongguan', 'Foshan', 'Zhuhai',
  'Zhongshan', 'Huizhou', 'Jiangmen', 'Shantou', 'Zhanjiang', 'Zhaoqing',
  'Meizhou', 'Shanwei', 'Heyuan', 'Yangjiang', 'Qingyuan', 'Chaozhou',
  'Jieyang', 'Yunfu',
];

/**
 * 判断一段文本是否涉及广东地区企业。
 * 大小写不敏感（英文城市名常见于标题大写，但正文可能小写）。
 * @param {string} text 待检测文本（标题 + 摘要）
 * @returns {boolean}
 */
export function isGuangdongEnterprise(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return GUANGDONG_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}
