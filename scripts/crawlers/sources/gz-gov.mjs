import { BaseCrawler } from '../base-crawler.mjs';
import { parseGovList, absUrl } from '../gz-utils.mjs';

/**
 * 广州市人民政府 - 市政府文件 + 政策解读
 * 站点: https://www.gz.gov.cn/zwgk/fggw/szfwj/  /  https://www.gz.gov.cn/zwgk/zcjd/
 * 内容: 广州产业政策 / 招商 / 城市治理文件（商机类核心源）
 * 注: szfwj 列表页无内联日期，publishedAt 留空由上游 fallback（与国内财经同策略）
 */
export class GzGovCrawler extends BaseCrawler {
  constructor() {
    super({
      name: '广州市政府',
      keywords: [],
      timeout: 15000,
      retries: 2,
    });
  }

  async getUrls() {
    return [
      { url: 'https://www.gz.gov.cn/zwgk/fggw/szfwj/index.html', sub: 'gz-industry' },
      { url: 'https://www.gz.gov.cn/zwgk/fggw/szfwj/index_1.html', sub: 'gz-industry' },
      { url: 'https://www.gz.gov.cn/zwgk/zcjd/index.html', sub: 'gz-industry' },
    ].map((u) => ({ ...u, headers: { 'User-Agent': this.userAgent } }));
  }

  async parseArticle(html, url) {
    const items = parseGovList(html, { minLen: 8 });
    const base = 'https://www.gz.gov.cn';
    return items.map((it) => ({
      ...it,
      url: absUrl(it.url, base),
      excerpt: `【广州市政府】${it.title}`,
      category: 'gz',
      subcategory: 'gz-industry',
      region: 'gz',
      sourceId: 'gz-gov',
      source: '广州市政府',
    }));
  }
}
