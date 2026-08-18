import fs from 'node:fs';
import path from 'node:path';
import { GzStatsCrawler } from './sources/gz-stats.mjs';
import { GzGovCrawler } from './sources/gz-gov.mjs';
import { GzNanshaCrawler } from './sources/gz-nansha.mjs';

/**
 * 广州商机抓取入口（独立于 run-all.mjs，不影响现有 IPO 爬虫流程）
 * 输出: data/crawled-gz.json（B/C 阶段接入渲染用；当前阶段供「看效果」采样）
 */
const OUTPUT_PATH = path.resolve(process.cwd(), 'data/crawled-gz.json');

async function main() {
  console.log('🚀 开始抓取广州商机源...\n');

  const crawlers = [new GzStatsCrawler(), new GzGovCrawler(), new GzNanshaCrawler()];
  const allResults = [];

  for (const crawler of crawlers) {
    try {
      await crawler.run();
      // 直接取原始 results（保留 category/subcategory/region/sourceId 全字段）
      allResults.push(...crawler.results);
    } catch (err) {
      console.error(`[${crawler.name}] 异常:`, err.message);
    }
  }

  // 去重（按 URL）
  const seen = new Set();
  const unique = allResults.filter((item) => {
    const key = item.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 按 subcategory 统计
  const bySub = {};
  for (const it of unique) {
    const s = it.subcategory || '(none)';
    bySub[s] = (bySub[s] || 0) + 1;
  }
  console.log('子维度分布:', JSON.stringify(bySub, null, 2));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(unique, null, 2), 'utf8');
  console.log(`\n✅ 广州商机抓取完成，共 ${unique.length} 条 → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('抓取失败:', err);
  process.exit(1);
});
