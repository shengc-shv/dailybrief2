import { BaseCrawler } from '../base-crawler.mjs';
import { parseGovList, absUrl } from '../gz-utils.mjs';

/**
 * 广州南沙区人民政府 - 通知公告 + 政策文件
 * 站点: http://www.gzns.gov.cn/zwgk/tzgg/  /  http://www.gzns.gov.cn/zwgk/zcwjjjd/zcwj/
 * 内容: 南沙自贸片区金融/产业/招商动态（招行广州分行辖区内的政策热点）
 */
export class GzNanshaCrawler extends BaseCrawler {
  constructor() {
    super({
      name: '广州南沙',
      keywords: [],
      timeout: 15000,
      retries: 2,
    });
  }

  async getUrls() {
    return [
      { url: 'http://www.gzns.gov.cn/zwgk/tzgg/index.html', sub: 'gz-nansha' },
      { url: 'http://www.gzns.gov.cn/zwgk/tzgg/index_1.html', sub: 'gz-nansha' },
      { url: 'http://www.gzns.gov.cn/zwgk/zcwjjjd/zcwj/index.html', sub: 'gz-nansha' },
    ].map((u) => ({ ...u, headers: { 'User-Agent': this.userAgent } }));
  }

  async parseArticle(html, url) {
    let items = parseGovList(html, { minLen: 8 });
    const base = 'http://www.gzns.gov.cn';
    // 过滤行政决定书类噪声（司法厅/许可/注销等，对商机无价值）
    const noise = /司法厅|决定书|注销|准予|执业|行政许可|送达|催告/;
    items = items.filter((it) => !noise.test(it.title));
    return items.map((it) => ({
      ...it,
      url: absUrl(it.url, base),
      excerpt: `【南沙】${it.title}`,
      category: 'gz',
      subcategory: 'gz-nansha',
      region: 'gz',
      sourceId: 'gz-nansha',
      source: '广州南沙区政府',
    }));
  }
}
