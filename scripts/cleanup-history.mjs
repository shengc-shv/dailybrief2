// 裁剪 data/article-history.json：仅保留最近 N 天的数据，避免缓存无限膨胀。
// 关键：被移除的条目不会真正丢弃，而是累积写入 data/article-history-backup.json
// （按条目去重，永不丢失），主文件只保留最近 N 天。
//
// 时间字段优先级：publishedAt → lastSeenAt → firstSeenAt（任一有效即可判定）。
// 用法：node scripts/cleanup-history.mjs  （可选 RETENTION_DAYS=7 覆盖保留天数）
import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);
const HISTORY_PATH = path.resolve(process.cwd(), 'data/article-history.json');
const BACKUP_PATH = path.resolve(process.cwd(), 'data/article-history-backup.json');
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

// 去重键：优先用稳定 id，否则用 sourceId+title+时间 拼接
function keyOf(e) {
  if (e && e.id) return String(e.id);
  const src = (e && (e.sourceId || e.source)) || '';
  const title = (e && (e.title || '')).slice(0, 60);
  const t = (e && (e.publishedAt || e.lastSeenAt || e.firstSeenAt)) || '';
  return `${src}|${title}|${t}`;
}

// 读取已有备份（对象或数组），返回 Map<key, entry>
function loadBackup() {
  const map = new Map();
  if (fs.existsSync(BACKUP_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
      const arr = Array.isArray(raw) ? raw : Object.values(raw);
      for (const e of arr) map.set(keyOf(e), e);
    } catch {
      /* 损坏则忽略，重新累积 */
    }
  }
  return map;
}

if (!fs.existsSync(HISTORY_PATH)) {
  console.log(`[cleanup] 未找到 ${HISTORY_PATH}，跳过`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
const isArray = Array.isArray(raw);

let kept;
const dropped = [];

if (isArray) {
  kept = [];
  for (const e of raw) {
    const t = tsOf(e);
    if (t !== null && t >= cutoff) kept.push(e);
    else dropped.push(e);
  }
} else {
  kept = {};
  for (const [k, e] of Object.entries(raw)) {
    const t = tsOf(e);
    if (t !== null && t >= cutoff) kept[k] = e;
    else dropped.push(e);
  }
}

const keptCount = isArray ? kept.length : Object.keys(kept).length;

// 写回主文件（仅最近 N 天）
fs.writeFileSync(HISTORY_PATH, JSON.stringify(kept, null, 2), 'utf8');

// 累积写入备份文件（本次移除 + 历史已移除，去重）
const backupMap = loadBackup();
let added = 0;
for (const e of dropped) {
  const k = keyOf(e);
  if (!backupMap.has(k)) {
    backupMap.set(k, e);
    added++;
  }
}
fs.writeFileSync(BACKUP_PATH, JSON.stringify([...backupMap.values()], null, 2), 'utf8');

const cutoffStr = new Date(cutoff).toISOString().slice(0, 10);
console.log(
  `[cleanup] 保留最近 ${RETENTION_DAYS} 天（>= ${cutoffStr}）：` +
    `主文件保留 ${keptCount} 条，本次移除 ${dropped.length} 条；` +
    `备份累计 ${backupMap.size} 条（新增 ${added}）-> ${BACKUP_PATH}`
);
