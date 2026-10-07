/**
 * Local patch 2026-10-06 (gbxheld): newsroom entity guard for the facts extractor.
 *
 * This box runs two brains: gbx (business, the default) and gbn (newsroom). Newsroom people
 * (officials, residents, meeting speakers) and government bodies belong only in gbn. gbx pages
 * that are legitimate pipeline records still name them, and the gbx facts extractor turned those
 * mentions into person facts in gbx (2026-09-19: six facts about one local resident from one
 * method lesson).
 *
 * The guard drops a fact before insert when its entity is on a deny list built from gbn, unless
 * the allowlist covers it. The list lives in the brain's own config table under
 * `facts.newsroom_entity_guard`. It is written by `~/.claude/bin/gbx-newsroom-entity-guard`, set on
 * gbx only. A brain without the key (gbn, every upstream install) behaves exactly as before.
 *
 * Config shape (JSON, version 2), validated strictly:
 *   { "version": 2,
 *     "deny": { "<key>": "<gbn slug it came from>", ... },        non-empty object of strings
 *     "allow_keys": ["<key>", ...],                               optional array of strings
 *     "allow_slugs": ["people/x-acme-com", "clients/y", ...] }    optional array of strings
 * There are no prefix allows: a namespace alone never proves an entity is a business contact.
 * Absent or empty value = guard off. An invalid value = keep the last good list this process
 * loaded (none yet = off), so a bad edit can't silently switch the guard off for running workers.
 *
 * Decision (identical in the box-side sweep script):
 *   stored  = resolved slug, else the raw entity (what the writer would store)
 *   ALLOW   if stored is in allow_slugs, or any key of stored is in allow_keys. Only the stored
 *           identity can allow, so a sweep that sees only the stored slug can never expire a fact
 *           the writer allowed under the same list.
 *   BLOCK   else if any key of raw or of resolved is in deny.
 */

import type { BrainEngine } from '../engine.ts';

export const NEWSROOM_ENTITY_GUARD_CONFIG_KEY = 'facts.newsroom_entity_guard';

export interface NewsroomEntityGuard {
  deny: Map<string, string>;
  allowKeys: Set<string>;
  allowSlugs: Set<string>;
}

export interface GuardDecision {
  blocked: boolean;
  /** The normalized key that matched the deny list. */
  key?: string;
  /** The gbn slug the deny key came from. */
  gbnSlug?: string;
}

/** ASCII whitespace only, so TypeScript and Python trim identically. */
export function trimAscii(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

/**
 * Normalize an entity string to a comparison key. Lowercase, quotes and apostrophes dropped,
 * `&` read as "and", every other run of characters outside [a-z0-9] collapsed to a single `-`.
 * `Alice "Q" Example` -> `alice-q-example`; `people/alice-example` -> `people-alice-example`.
 * Must stay identical to `norm()` in ~/.claude/bin/gbx-newsroom-entity-guard.
 */
export function normalizeEntityKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"‘’“”]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Keys an entity string is checked under: the whole string, and its last path segment. */
export function candidateKeys(s: string): string[] {
  const keys: string[] = [];
  const whole = normalizeEntityKey(s);
  if (whole) keys.push(whole);
  const t = trimAscii(s).replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  if (i >= 0) {
    const last = normalizeEntityKey(t.slice(i + 1));
    if (last && !keys.includes(last)) keys.push(last);
  }
  return keys;
}

function stringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

/** Parse and validate the config value. Returns null (no guard) for anything invalid. */
export function parseNewsroomEntityGuard(raw: string | null | undefined): NewsroomEntityGuard | null {
  if (!raw || !trimAscii(raw)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.version !== 2) return null;
  if ('allow_slug_prefixes' in o) return null; // v1 field; prefixes are no longer an allow rule
  if (!o.deny || typeof o.deny !== 'object' || Array.isArray(o.deny)) return null;
  const deny = new Map<string, string>();
  for (const [k, v] of Object.entries(o.deny as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    const key = normalizeEntityKey(k);
    if (key) deny.set(key, v);
  }
  if (deny.size === 0) return null;
  const allowKeys = stringArray(o.allow_keys);
  const allowSlugs = stringArray(o.allow_slugs);
  if (!allowKeys || !allowSlugs) return null;
  return {
    deny,
    allowKeys: new Set(allowKeys.map(normalizeEntityKey).filter(Boolean)),
    allowSlugs: new Set(allowSlugs.map(trimAscii).filter(Boolean)),
  };
}

/**
 * Decide one fact. `raw` is the extractor's entity string; `resolvedSlug` is what the resolver
 * returned (null when nothing resolved).
 */
export function checkNewsroomEntity(
  guard: NewsroomEntityGuard | null,
  raw: string | null | undefined,
  resolvedSlug: string | null | undefined,
): GuardDecision {
  if (!guard) return { blocked: false };
  const r = typeof raw === 'string' ? trimAscii(raw) : '';
  const res = typeof resolvedSlug === 'string' ? trimAscii(resolvedSlug) : '';
  const stored = res || r;
  if (!stored) return { blocked: false };
  if (guard.allowSlugs.has(stored)) return { blocked: false };
  if (candidateKeys(stored).some((k) => guard.allowKeys.has(k))) return { blocked: false };
  for (const s of [r, res]) {
    if (!s) continue;
    for (const k of candidateKeys(s)) {
      const gbnSlug = guard.deny.get(k);
      if (gbnSlug !== undefined) return { blocked: true, key: k, gbnSlug };
    }
  }
  return { blocked: false };
}

const CACHE_TTL_MS = 60_000;
const cache = new WeakMap<object, { at: number; guard: NewsroomEntityGuard | null }>();

/**
 * Load the guard for this engine, cached for a minute so a refresh lands without a restart.
 * A failed config read, or an invalid value, keeps the last good list. Only an absent or empty
 * value switches the guard off.
 */
export async function loadNewsroomEntityGuard(engine: BrainEngine): Promise<NewsroomEntityGuard | null> {
  const hit = cache.get(engine as object);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.guard;
  let raw: string | null;
  try {
    raw = await engine.getConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY);
  } catch {
    const kept = hit?.guard ?? lastGood.get(engine as object) ?? null;
    cache.set(engine as object, { at: now, guard: kept });
    return kept;
  }
  let guard: NewsroomEntityGuard | null;
  if (raw == null || !trimAscii(raw)) {
    guard = null;
  } else {
    guard = parseNewsroomEntityGuard(raw) ?? lastGood.get(engine as object) ?? null;
  }
  if (guard) lastGood.set(engine as object, guard);
  cache.set(engine as object, { at: now, guard });
  return guard;
}

const lastGood = new WeakMap<object, NewsroomEntityGuard>();

/** Convenience for insert paths: is this entity (raw and/or resolved) blocked on this brain? */
export async function isNewsroomGuardedEntity(
  engine: BrainEngine,
  raw: string | null | undefined,
  resolvedSlug?: string | null,
): Promise<GuardDecision> {
  return checkNewsroomEntity(await loadNewsroomEntityGuard(engine), raw, resolvedSlug ?? null);
}

/**
 * Record dropped facts in ingest_log (source_type `facts:guard`, kept apart from
 * `facts:absorb` so the doctor's extraction-health check does not read guard drops as failures).
 * Best-effort: logging never breaks the write path.
 */
export async function logNewsroomEntityGuardDrops(
  engine: BrainEngine,
  sourceId: string,
  ref: string,
  drops: Array<{ entity: string; key: string; gbnSlug: string }>,
): Promise<void> {
  if (drops.length === 0) return;
  try {
    const detail = drops
      .slice(0, 8)
      .map((d) => `${d.entity}->${d.gbnSlug || d.key}`)
      .join(', ');
    await engine.logIngest({
      source_id: sourceId,
      source_type: 'facts:guard',
      source_ref: ref,
      pages_updated: [],
      summary: `newsroom_entity_guard: dropped ${drops.length} (${detail})`.slice(0, 480),
    });
  } catch {
    // Observability only.
  }
}
