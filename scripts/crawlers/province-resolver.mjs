import { fetch } from 'undici';

/**
 * 股票代码 -> 注册省份 解析器（共享模块）
 *
 * 为什么需要它：深交所 / 北交所的公告列表只返回「股票简称」（如"君正股份"），
 * 公司名里几乎不含省份/城市名，因此原来靠「标题里出现广东/深圳等关键词」做地区过滤
 * 几乎永远命中不了（实测 273 条公告匹配 0 条）。
 *
 * 可靠做法：用股票代码去东方财富 F10 公司概况接口拿 `PROVINCE` 字段（权威、含注册地）。
 * 深圳/广州的公司 PROVINCE 都是 "广东"，所以按省份判断即可覆盖全省。
 *
 * - 带进程内缓存，避免同一代码重复请求；
 * - 任何异常（限流/超时/无数据）都返回 ''，绝不让爬虫崩溃。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const cache = new Map();

/**
 * 把 (股票代码, 交易所提示) 转成东方财富 Code 参数。
 * exchange 可传 'SZ' | 'SH' | 'BJ'（大小写均可）；为空时按代码前缀推断。
 */
function toEastMoneyCode(stockCode, exchange) {
  const c = String(stockCode || '').trim();
  if (!c) return null;
  const e = String(exchange || '').toUpperCase();
  if (e === 'SZ') return `SZ${c}`;
  if (e === 'SH') return `SH${c}`;
  if (e === 'BJ') return `BJ${c}`;
  // 按前缀推断
  if (/^6/.test(c)) return `SH${c}`;          // 上交所
  if (/^[03]/.test(c)) return `SZ${c}`;       // 深交所
  if (/^[89]/.test(c) || /^920/.test(c) || /^4/.test(c)) return `BJ${c}`; // 北交所
  return `SZ${c}`;
}

/**
 * 解析股票代码的注册省份（如 "广东"）。失败/未知返回 ''。
 */
export async function provinceOf(stockCode, exchange) {
  const code = toEastMoneyCode(stockCode, exchange);
  if (!code) return '';
  if (cache.has(code)) return cache.get(code);

  try {
    const res = await fetch(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${code}`,
      {
        headers: { 'User-Agent': UA, 'Referer': 'https://emweb.securities.eastmoney.com/' },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) return ''; // 瞬时限流/网络错误：不缓存，下次可重试
    const data = await res.json();
    const jbzl = data && data.jbzl;
    const prov = (jbzl && jbzl[0] && jbzl[0].PROVINCE) || '';
    if (prov) cache.set(code, prov); // 仅缓存命中结果；空值（含非法代码）不缓存
    return prov;
  } catch {
    return ''; // 异常不缓存，允许重试
  }
}

/** 是否为广东省（含深圳/广州等地，省份字段即 "广东"）。 */
export async function isGuangdong(stockCode, exchange) {
  return (await provinceOf(stockCode, exchange)) === '广东';
}
