import fs from 'node:fs';
import path from 'node:path';
import { HKEXCrawler } from './sources/hkex-ipo.mjs';  // 只导入港交所
import { SSEAPICrawler } from './sources/sse-api.mjs';
import { SZSEAPICrawler } from './sources/szse-api-crawler.mjs';
import { BSEAPICrawler } from './sources/bse-api.mjs';
import { EastMoneyIPOCrawler } from './sources/eastmoney-ipo.mjs';
import { TonghuashunIPOCrawler } from './sources/tonghuashun-ipo.mjs';
import { CNInfoCrawler } from './sources/cninfo-crawler.mjs';
const OUTPUT_PATH = path.resolve(process.cwd(), 'data/crawled-articles.json');

async function main() {
  console.log('🚀 开始运行爬虫...\n');
  
  const crawlers = [
    new HKEXCrawler(),
    new SSEAPICrawler(),
    new SZSEAPICrawler(),
    new BSEAPICrawler(),
    new EastMoneyIPOCrawler(),
    new TonghuashunIPOCrawler(),
    new CNInfoCrawler(),
  ];

  const allResults = [];

  for (const crawler of crawlers) {
    try {
      await crawler.run();
      allResults.push(...crawler.toDailyBriefFormat());
    } catch (err) {
      console.error(`[${crawler.name}] 爬虫异常:`, err.message);
    }
  }

  // 去重（按 URL）
  const seen = new Set();
  const unique = allResults.filter(item => {
    const key = item.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 确保目录存在
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 写入 JSON（DailyBrief 可读格式）
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(unique, null, 2), 'utf8');
  
  console.log(`\n✅ 爬虫完成，共写入 ${unique.length} 条到 ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('爬虫运行失败:', err);
  process.exit(1);
});
