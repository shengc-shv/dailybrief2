import { BaseCrawler } from '../base-crawler.mjs';
import { parseGovList, absUrl } from '../gz-utils.mjs';

/**
 * 广州市统计局 - 数据发布栏目
 * 站点: http://tjj.gz.gov.cn/stats_newtjyw/sjfb/
 * 内容: 广州社零 / 居民收入 / 服务业 / 产业数据（直接对应零售客群画像）
 */
export class GzStatsCrawler extends BaseCrawler {
  constructor() {
    super({
      name: '广州统计局',
      keywords: [],
      timeout: 15000,
      retries: 2,
    });
  }

  async getUrls() {
    const base = 'http://tjj.gz.gov.cn/stats_newtjyw/sjfb/';
    return [base + 'index.html', base + 'index_1.html', base + 'index_2.html'].map((u) => ({
      url: u,
      headers: { 'User-Agent': this.userAgent },
    }));
  }

  async parseArticle(html, url) {
    const items = parseGovList(html, { minLen: 8 });
    const base = new URL(url).origin;
    return items.map((it) => ({
      ...it,
      url: absUrl(it.url, base),
      excerpt: `【广州统计局】${it.title}`,
      category: 'gz',
      subcategory: 'gz-retail',
      region: 'gz',
      sourceId: 'gz-stats',
      source: '广州市统计局',
    }));
  }
}
