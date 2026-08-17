/**
 * Rolling 30-day article history + AI-summary cache.
 *
 * Single source of truth on disk (`data/article-history.json`) that the
 * report entrypoints (daily.ts / dry-run.ts) use for two purposes:
 *
 *  1. **"过去30天" tab** — every article ever seen in the last 30 days is
 *     kept here, so the renderer can show a rolling backlog alongside the
 *     freshly-fetched "当天" items.
 *  2. **AI 解读去重** — when an article's URL already has a `summary` in the
 *     history, daily.ts reuses it instead of calling the LLM again, saving
 *     cost. The summary is the "AI 解读结果" the user referred to.
 *
 * The file is public/committed (not gitignored) so it persists across CI
 * runs — both test.yml and daily.yml commit it back after each run.
 */
import fs from "node:fs";
import path from "node:path";

import type { ArticleInput } from "../ai/pipeline";
import type { Category } from "../sources/types";
import { loadAllSources } from "../sources/registry";

const HISTORY_PATH = path.resolve(process.cwd(), "data/article-history.json");
const HISTORY_DAYS = 30;
const MAX_AGE_MS = HISTORY_DAYS * 86_400_000;

export interface HistoryEntry {
  title: string;
  url: string;
  sourceId: string;
  source: string;
  category: Category;
  subcategory?: string;
  excerpt?: string;
  /** ISO string (from article.publishedAt). */
  publishedAt?: string;
  /** AI-generated summary in the active REPORT_LOCALE, if analyzed before. */
  summary?: string;
  /** ISO — first time we saw this URL. */
  firstSeenAt: string;
  /** ISO — most recent run that carried this URL. Used for 30-day pruning. */
  lastSeenAt: string;
}

export type HistoryStore = Record<string, HistoryEntry>;

function subcatOf(a: ArticleInput): string | undefined {
  const s = loadAllSources().find((x) => x.id === a.sourceId);
  return s?.subcategory;
}

export function loadHistory(): HistoryStore {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as HistoryStore;
      }
    }
  } catch {
    // corrupt file — start fresh rather than crash the whole run
  }
  return {};
}

function isFresh(iso: string | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= MAX_AGE_MS;
}

/** Drop entries whose lastSeenAt is older than HISTORY_DAYS (in place-safe copy). */
export function pruneHistory(store: HistoryStore): HistoryStore {
  const out: HistoryStore = {};
  for (const [url, e] of Object.entries(store)) {
    if (isFresh(e.lastSeenAt)) out[url] = e;
  }
  return out;
}

function entryToArticle(e: HistoryEntry, fetchedToday: boolean): ArticleInput {
  return {
    sourceId: e.sourceId,
    title: e.title,
    url: e.url,
    excerpt: e.excerpt,
    publishedAt: e.publishedAt ? new Date(e.publishedAt) : undefined,
    category: e.category,
    summary: e.summary,
    source: e.source,
    fetchedToday,
  };
}

/**
 * Merge today's freshly-fetched articles with the rolling history into a
 * single list, tagging each with `fetchedToday`. Today's items win on URL
 * collision (so an updated title/excerpt/summary for a recurring URL shows
 * under "当天"). History entries outside the 30-day window are dropped.
 */
export function buildRolling(
  today: ArticleInput[],
  history: HistoryStore,
): ArticleInput[] {
  const map = new Map<string, ArticleInput>();
  for (const e of Object.values(history)) {
    if (!isFresh(e.lastSeenAt)) continue;
    map.set(e.url, entryToArticle(e, false));
  }
  for (const a of today) {
    map.set(a.url, { ...a, fetchedToday: true });
  }
  return Array.from(map.values());
}

/**
 * Persist today's articles (with whatever summary they now carry) into the
 * history store, bumping lastSeenAt. Called after AI enrichment so newly
 * generated summaries are cached for future runs. Returns the updated store.
 */
export function saveHistory(
  today: ArticleInput[],
  history: HistoryStore,
  nowIso: string,
): HistoryStore {
  const store = pruneHistory(history);
  for (const a of today) {
    const prev = store[a.url];
    store[a.url] = {
      title: a.title,
      url: a.url,
      sourceId: a.sourceId,
      source: a.source,
      category: a.category,
      subcategory: subcatOf(a),
      excerpt: a.excerpt,
      publishedAt: a.publishedAt?.toISOString(),
      // Keep a previously-cached summary if this run produced none
      // (e.g. dry-run has no AI — don't clobber good history).
      summary: a.summary || prev?.summary,
      firstSeenAt: prev?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
    };
  }
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}
