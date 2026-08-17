import { BaseCrawler } from '../base-crawler.mjs';
import { isGuangdong } from '../province-resolver.mjs';

const SZSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// IPO / 发行上市 相关关键词（标题命中即视为 IPO 动态）
const IPO_KEYWORDS = [
  '发行', '上市', '招股', '公开发行', 'IPO',
  '注册', '受理', '问询', '上会', '过会', '注册生效',
  '首次公开发行', '申购', '中签', '路演', '询价',
  '辅导备案', '辅导验收',
];

export class SZSEAPICrawler extends BaseCrawler {
  constructor() {
    super({
      name: '深交所IPO公告',
      keywords: [],        // 地区过滤交给省份解析器，父类不再按关键词过滤
      timeout: 30000,
      // 深交所接口对云端 IP 偶尔连接层抖动，给足重试（与 SSE 保持一致）
      retries: 3,
    });
  }

  getUrls() {
    // 深交所全量披露列表接口（GET 即可，返回 JSON）
    return [{
      url: `https://www.szse.cn/api/disc/announcement/detailinfo?random=${Math.random()}&pageSize=50&pageNum=1&plateCode=szse`,
      method: 'GET',
      headers: {
        'Referer': 'https://www.szse.cn/disclosure/listed/notice/index.html',
        'User-Agent': SZSE_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      },
    }];
  }

  async parseArticle(responseText, url) {
    const articles = [];
    try {
      const data = JSON.parse(responseText);
      const groups = data?.data;
      if (!Array.isArray(groups)) {
        console.warn(`[${this.name}] 返回数据格式异常`);
        return articles;
      }

      // 展平所有公告
      const flat = [];
      for (const g of groups) {
        for (const a of (g.announList || [])) {
          flat.push({ ...a, secCode: g.secCode, secName: g.secName });
        }
      }
      console.log(`[${this.name}] 接口共返回 ${flat.length} 条公告`);

      // 计算 30 天前
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const seen = new Set();   // 按股票代码去重（每家公司只保留第一条命中公告）
      let provinceChecks = 0;

      for (const item of flat) {
        const stockName = item.secName || '';
        const stockCode = item.secCode || '';
        const titleText = item.title || '';

        // 同公司多条公告只处理一次（避免同一企业刷屏）
        if (seen.has(stockCode)) continue;

        // 1) 先按 IPO 关键词做廉价本地过滤（大幅减少后续的省份解析请求）
        const isIpo = IPO_KEYWORDS.some(k => titleText.includes(k));
        if (!isIpo) continue;

        // 2) 再按股票代码解析注册省份，判断是否为广东企业
        provinceChecks++;
        const guangdong = await isGuangdong(stockCode, 'SZ');
        if (!guangdong) continue;

        // 解析日期
        const pubDate = (item.publishTime || '').slice(0, 10)
          || new Date().toISOString().slice(0, 10);
        if (new Date(pubDate) < thirtyDaysAgo) continue;

        seen.add(stockCode);

        const title = `${stockName} (${stockCode})`;
        const excerpt = `深交所公告 | ${titleText} | 日期: ${pubDate}`;
        const detailUrl = item.attachPath
          ? `https://disc.static.szse.cn${item.attachPath}`
          : '';

        articles.push({ title, url: detailUrl, excerpt, publishedAt: pubDate });
      }

      console.log(`[${this.name}] IPO 命中 ${provinceChecks} 家，其中广东企业 ${articles.length} 家`);
      return articles;
    } catch (err) {
      console.error(`[${this.name}] 解析失败:`, err.message);
      return articles;
    }
  }
}

export function createCrawler() {
  return new SZSEAPICrawler();
}
