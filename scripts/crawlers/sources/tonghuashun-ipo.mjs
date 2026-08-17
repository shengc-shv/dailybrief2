import { BaseCrawler } from '../base-crawler.mjs';
import iconv from 'iconv-lite';

/**
 * 同花顺 - 新股预披露爬虫
 * 数据来源: https://data.10jqka.com.cn/ipo/xgyp/
 */
export class TonghuashunIPOCrawler extends BaseCrawler {
  constructor() {
    super({
      name: '同花顺新股预披露',
      keywords: [],
      timeout: 15000,
    });
  }

  async getUrls() {
    return [
      'https://data.10jqka.com.cn/ipo/xgyp/',
    ];
  }

  // ⭐ 重写 run 方法，使用 iconv-lite 解码 GBK
  async run() {
    console.log(`[${this.name}] 开始抓取...`);
    const items = await this.getUrls();
    let total = 0;

    for (const item of items) {
      const targetUrl = typeof item === 'string' ? item : item.url;
      const method = item.method || 'GET';
      const headers = item.headers || { 'User-Agent': this.userAgent };

      try {
        const fetchOptions = {
          method: method,
          headers: headers,
          signal: AbortSignal.timeout(this.timeout),
        };

        if (method === 'POST' && item.body) {
          fetchOptions.body = item.body;
        }

        const resp = await fetch(targetUrl, fetchOptions);
        if (!resp.ok) {
          console.warn(`[${this.name}] ${targetUrl} 返回 ${resp.status}，跳过`);
          continue;
        }

        // ⭐ 获取原始 buffer，用 iconv-lite 解码为 UTF-8
        const buffer = await resp.arrayBuffer();
        const html = iconv.decode(Buffer.from(buffer), 'GBK');

        const articles = await this.parseArticle(html, targetUrl);

        // 直接使用全部数据，由子类 parseArticle 自行决定过滤
        this.results.push(...articles);
        total += articles.length;
        console.log(`[${this.name}] 从 ${targetUrl} 抓取 ${articles.length} 条`);
      } catch (err) {
        console.warn(`[${this.name}] ${targetUrl} 抓取失败: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }

    console.log(`[${this.name}] 完成，共 ${this.results.length} 条`);
    return this.results;
  }

  async parseArticle(html, url) {
    const articles = [];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 按板块把每条预披露路由到对应交易所二级标签
    const boardToSource = (board) => {
      const b = (board || '').trim();
      if (b.includes('创业') || b.includes('深')) return 'gd-szse';
      if (b.includes('科创') || b.includes('沪')) return 'gd-sse';
      if (b.includes('北交')) return 'gd-bse';
      if (b.includes('主板')) return 'gd-sse'; // 纯"主板"无深沪提示时默认沪市
      return 'gd-szse';
    };

    const regionKeywords = [
      '广东', '广州', '深圳', '东莞', '佛山', '珠海', '中山', '惠州',
      '江门', '汕头', '湛江', '肇庆', '梅州', '汕尾', '河源', '阳江',
      '清远', '潮州', '揭阳', '云浮'
    ];

    try {
      const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
      if (!tbodyMatch) {
        console.warn(`[${this.name}] 未找到 <tbody> 标签`);
        return articles;
      }

      const tbodyContent = tbodyMatch[1];
      const trMatches = tbodyContent.match(/<tr>[\s\S]*?<\/tr>/gi);
      if (!trMatches || trMatches.length === 0) {
        console.warn(`[${this.name}] 未找到数据行`);
        return articles;
      }

      console.log(`[${this.name}] 共找到 ${trMatches.length} 行数据`);

      for (const trContent of trMatches) {
        const tdMatches = trContent.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (!tdMatches || tdMatches.length < 9) continue;

        const tds = tdMatches.map(td => {
          // 移除 HTML 标签
          let text = td.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
          text = text.replace(/<[^>]+>/g, '');
          text = text.replace(/\s+/g, ' ').trim();
          return text;
        });

        if (tds.length < 9) continue;
        if (tds[0] === '序号' || tds[0] === '') continue;

        const stockName = tds[1] || '';
        const disclosureDate = tds[2] || '';
        const board = tds[3] || '';
        const disclosureType = tds[4] || '';
        const estimatedFunds = tds[5] || '';
        const estimatedShares = tds[6] || '';
        const reportLink = tds[8] || '';

        // ⭐ 地区过滤
        const isRegion = regionKeywords.some(kw => stockName.includes(kw));
        if (!isRegion) continue;

        // 解析日期
        let pubDate = disclosureDate;
        if (pubDate) {
          const dateMatch = pubDate.match(/(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            pubDate = dateMatch[1];
          }
        } else {
          pubDate = new Date().toISOString().slice(0, 10);
        }

        // 日期过滤
         const itemDate = new Date(pubDate);
         if (itemDate < sevenDaysAgo) continue;

        let title = `${stockName}`;
        if (board) title += ` [${board}]`;
        if (disclosureType) title += ` (${disclosureType})`;

        let excerpt = `同花顺新股预披露`;
        if (board) excerpt += ` | 板块: ${board}`;
        if (disclosureType) excerpt += ` | 类型: ${disclosureType}`;
        if (disclosureDate) excerpt += ` | 披露日期: ${disclosureDate}`;
        if (estimatedFunds && estimatedFunds !== '-') excerpt += ` | 募资: ${estimatedFunds}`;
        if (estimatedShares && estimatedShares !== '-') excerpt += ` | 发行: ${estimatedShares}`;

        let detailUrl = url;
        if (reportLink && reportLink !== '-' && reportLink.startsWith('http')) {
          detailUrl = reportLink;
        } else {
          detailUrl = `https://data.10jqka.com.cn/ipo/search/?keyword=${encodeURIComponent(stockName)}`;
        }

        articles.push({
          title,
          url: detailUrl,
          excerpt,
          publishedAt: pubDate,
          sourceId: boardToSource(board),
        });
      }

      console.log(`[${this.name}] 匹配到 ${articles.length} 家广东新股预披露`);

    } catch (err) {
      console.error(`[${this.name}] 解析HTML失败:`, err.message);
    }

    return articles;
  }
}

export function createCrawler() {
  return new TonghuashunIPOCrawler();
}
