// 裁剪 data/article-history.json：仅保留最近 N 天的数据，避免缓存无限膨胀。
// 时间字段优先级：publishedAt → lastSeenAt → firstSeenAt（任一有效即可判定）。
// 用法：node scripts/cleanup-history.mjs  （可选 RETENTION_DAYS=7 覆盖保留天数）
import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);
const HISTORY_PATH = path.resolve(process.cwd(), 'data/article-history.json');
const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

function tsOf(entry) {
  for (const key of ['publishedAt', 'lastSeenAt', 'firstSeenAt']) {
    const v = entry[key];
    if (v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

if (!fs.existsSync(HISTORY_PATH)) {
  console.log(`[cleanup] 未找到 ${HISTORY_PATH}，跳过`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
const isArray = Array.isArray(raw);

let keptCount = 0;
let droppedCount = 0;
let kept;

if (isArray) {
  kept = raw.filter((e) => {
    const t = tsOf(e);
    if (t !== null && t >= cutoff) {
      keptCount++;
      return true;
    }
    droppedCount++;
    return false;
  });
} else {
  kept = {};
  for (const [k, e] of Object.entries(raw)) {
    const t = tsOf(e);
    if (t !== null && t >= cutoff) {
      kept[k] = e;
      keptCount++;
    } else {
      droppedCount++;
    }
  }
}

fs.writeFileSync(HISTORY_PATH, JSON.stringify(kept, null, 2), 'utf8');
const cutoffStr = new Date(cutoff).toISOString().slice(0, 10);
console.log(
  `[cleanup] 保留最近 ${RETENTION_DAYS} 天（>= ${cutoffStr}）：保留 ${keptCount} 条，丢弃 ${droppedCount} 条 -> ${HISTORY_PATH}`
);
