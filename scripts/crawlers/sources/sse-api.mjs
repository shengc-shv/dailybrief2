import { BaseCrawler } from '../base-crawler.mjs';

/**
 * 上交所 IPO 公告爬虫（API 版）
 * 数据来源: https://query.sse.com.cn/commonSoaQuery.do
 *
 * 接口本身返回的是 IPO 相关公告（fileTypeMap 限定），但为了与港交所统一逻辑，
 * 仍然做「地区 + IPO」双重过滤。
 * - 地区关键词：广东、广州、深圳、东莞、佛山、珠海等
 * - IPO关键词：发行、上市、招股、公开发行、IPO 等
 */
export class SSEAPICrawler extends BaseCrawler {
  constructor() {
    super({
      name: '上交所IPO公告',
      keywords: [],   // 父类不过滤，传空数组
      timeout: 15000,
      // 上交所 query.sse.com.cn 反爬/WAF 对云端 IP 常在连接层直接掐断，给足重试
      retries: 3,
    });
  }

  async getUrls() {
    return [{
      url: 'https://query.sse.com.cn/commonSoaQuery.do',
      method: 'POST',
      headers: {
        'Referer': 'https://www.sse.com.cn/listing/disclosure/ipo/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams({
        isPagination: 'true',
        sqlId: 'GP_COMMON_FILE_SEARCH',
        fileTypeMap: 'I0011,I0012,I0013,I3010',
        marketType: '',
        fileTitle: '',
        searchDateBegin: '',
        searchDateEnd: '',
        'pageHelp.pageSize': '25',
        'pageHelp.pageNo': '1',
      }).toString(),
    }];
  }

  async parseArticle(responseText, url) {
    const articles = [];
    // 计算 30 天前的时间戳
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 地区关键词（广东及主要城市）
    const regionKeywords = [
      '广东', '广州', '深圳', '东莞', '佛山', '珠海', '中山', '惠州',
      '江门', '汕头', '湛江', '肇庆', '梅州', '汕尾', '河源', '阳江',
      '清远', '潮州', '揭阳', '云浮'
    ];

    // IPO 相关关键词（上交所接口已经是 IPO 公告，但保留做双重验证）
    const ipoKeywords = [
      '发行', '上市', '招股', '公开发行', 'IPO', '注册', '受理',
      '问询', '上会', '过会', '注册生效', '首次公开发行'
    ];

    try {
      const data = JSON.parse(responseText);
      if (!data.result || !Array.isArray(data.result)) {
        console.warn(`[${this.name}] API返回数据格式异常`);
        return articles;
      }

      const list = data.result;
      console.log(`[${this.name}] API共返回 ${list.length} 条公告`);

      const guangdongStocks = new Set();

      for (const item of list) {
        const stockName = item.stockName || '';
        const stockCode = item.stockCode || '';
        const fileTitle = item.fileTitle || '';
        const filedate = item.filedate || '';

        // 解析日期
        let pubDate = (filedate || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] ||
          new Date().toISOString().slice(0, 10);

        // 过滤 30 天前的数据
        const itemDate = new Date(pubDate);
        if (itemDate < thirtyDaysAgo) {
          continue;
        }

        // ⭐ 双重过滤：地区 + IPO（AND 逻辑）
        const allText = `${stockName} ${fileTitle}`;

        // 检查地区关键词（公司名或标题中包含地区词）
        const isRegion = regionKeywords.some(kw =>
          allText.includes(kw)
        );

        // 检查 IPO 关键词
        const isIpo = ipoKeywords.some(kw =>
          allText.includes(kw)
        );

        // 必须同时满足地区 + IPO
        if (!isRegion || !isIpo) {
          continue;
        }

        // 去重
        const key = `${stockCode || ''}_${stockName}`;
        if (guangdongStocks.has(key)) continue;
        guangdongStocks.add(key);

        const title = `${stockName} (${stockCode || ''})`;
        const excerpt = `上交所IPO动态 | ${fileTitle} | 日期: ${filedate || ''}`;
        const detailUrl = `https://www.sse.com.cn/listing/disclosure/ipo/detail.shtml?stockCode=${stockCode || ''}`;

        articles.push({
          title,
          url: detailUrl,
          excerpt,
          publishedAt: pubDate,
        });
      }

      console.log(`[${this.name}] 匹配到 ${articles.length} 家广东IPO企业（最近30天）`);
      return articles;

    } catch (err) {
      console.error(`[${this.name}] 解析失败:`, err.message);
      return articles;
    }
  }
}

export function createCrawler() {
  return new SSEAPICrawler();
}
