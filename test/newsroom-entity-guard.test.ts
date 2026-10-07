/**
 * Local patch 2026-10-06 (gbxheld) — newsroom entity guard for the facts extractor.
 *
 * Pins: key normalization, config parsing (fail-open on anything unusable), allow-over-deny
 * decisions, and the two write paths that consult the guard (the extraction pipeline and
 * writeSingleFact). Cases are shared with the box-side sweep script through
 * test/fixtures/newsroom-entity-guard-cases.json so both implementations decide alike.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import {
  NEWSROOM_ENTITY_GUARD_CONFIG_KEY,
  checkNewsroomEntity,
  loadNewsroomEntityGuard,
  normalizeEntityKey,
  parseNewsroomEntityGuard,
} from '../src/core/facts/newsroom-entity-guard.ts';

const CASES = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/newsroom-entity-guard-cases.json'), 'utf8'));
const GUARD_JSON = JSON.stringify(CASES.guard);

describe('normalizeEntityKey', () => {
  for (const [input, want] of CASES.normalize as Array<[string, string]>) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
      expect(normalizeEntityKey(input)).toBe(want);
    });
  }
});

describe('parseNewsroomEntityGuard', () => {
  test('parses the fixture', () => {
    const g = parseNewsroomEntityGuard(GUARD_JSON);
    expect(g).not.toBeNull();
    expect(g!.deny.size).toBe(Object.keys(CASES.guard.deny).length);
  });
  for (const raw of CASES.invalid_configs as Array<string | null>) {
    test(`fails open (no guard) on ${JSON.stringify(raw)}`, () => {
      expect(parseNewsroomEntityGuard(raw)).toBeNull();
    });
  }
});

describe('checkNewsroomEntity (shared cases)', () => {
  const g = parseNewsroomEntityGuard(GUARD_JSON);
  for (const c of CASES.decide as Array<{ raw: string | null; resolved: string | null; source?: string | null; blocked: boolean; why: string }>) {
    test(`${c.why}: ${JSON.stringify(c.raw)} / ${JSON.stringify(c.resolved)} -> ${c.blocked ? 'blocked' : 'kept'}`, () => {
      expect(checkNewsroomEntity(g, c.raw, c.resolved, c.source ?? null).blocked).toBe(c.blocked);
    });
  }
  for (const nc of CASES.no_carveout_configs as Array<{ why: string; config: unknown; raw: string; source: string }>) {
    test(nc.why, () => {
      const g2 = parseNewsroomEntityGuard(JSON.stringify(nc.config));
      expect(g2).not.toBeNull();
      expect(checkNewsroomEntity(g2, nc.raw, null, nc.source).blocked).toBe(true);
    });
  }
  test('no guard never blocks', () => {
    expect(checkNewsroomEntity(null, 'alice-example', null).blocked).toBe(false);
  });
  test('a block reports the gbn slug it matched', () => {
    const d = checkNewsroomEntity(g, 'Alice "Q" Example', null);
    expect(d.gbnSlug).toBe('people/alice-example');
  });
});

// ---- write paths ---------------------------------------------------------

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

function chatStub(facts: Array<{ fact: string; entity: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: facts.map((f) => ({ fact: f.fact, kind: 'fact', entity: f.entity, confidence: 1.0, notability: 'high' })) }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

const ctx = (): FactsBackstopCtx => ({ engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' });
const page = () => ({
  slug: 'notes/guard-' + Math.random().toString(36).slice(2, 9),
  type: 'note' as const,
  compiled_truth: 'a pipeline lesson that names a resident and a county body in passing. '.repeat(3),
  frontmatter: {} as Record<string, unknown>,
});

// The guard caches the config for 60 s per engine object, so each test that changes the config
// uses a fresh engine wrapper around the same database.
function freshEngineView(): PGLiteEngine {
  return Object.create(engine) as PGLiteEngine;
}

async function rowsFor(entity: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query('SELECT count(*)::int AS n FROM facts WHERE entity_slug LIKE $1', [`%${entity}%`]);
  return r.rows[0].n;
}

describe('loadNewsroomEntityGuard', () => {
  test('a failed config read keeps the last good list', async () => {
    let fail = false;
    const fake = { getConfig: async () => { if (fail) throw new Error('db down'); return GUARD_JSON; } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await loadNewsroomEntityGuard(fake as any);
    expect(first).not.toBeNull();
    fail = true;
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000; // past the cache TTL
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await loadNewsroomEntityGuard(fake as any);
      expect(second).toBe(first);
    } finally {
      Date.now = realNow;
    }
  });

  test('an invalid value after a good one keeps the last good list; an absent value switches it off', async () => {
    let value: string | null = GUARD_JSON;
    const fake = { getConfig: async () => value };
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const good = await loadNewsroomEntityGuard(fake as any);
      expect(good).not.toBeNull();
      value = '{"version": 2, "deny": "broken"}';
      clock += 120_000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await loadNewsroomEntityGuard(fake as any)).toBe(good);
      value = null;
      clock += 120_000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await loadNewsroomEntityGuard(fake as any)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('an explicit disable is not undone by a later read failure', async () => {
    let value: string | null = GUARD_JSON;
    let fail = false;
    const fake = { getConfig: async () => { if (fail) throw new Error('db down'); return value; } };
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await loadNewsroomEntityGuard(fake as any)).not.toBeNull();
      value = '';
      clock += 120_000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await loadNewsroomEntityGuard(fake as any)).toBeNull();
      fail = true;
      clock += 120_000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await loadNewsroomEntityGuard(fake as any)).toBeNull();
      value = '{"version": 2, "deny": "broken"}';
      fail = false;
      clock += 120_000;
      // invalid after an explicit disable: there is no last good list to fall back to
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await loadNewsroomEntityGuard(fake as any)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('pipeline (runFactsBackstop) with the guard set', () => {
  test('drops the newsroom facts, keeps the rest, logs the drop', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
    chatStub([
      { fact: 'guard-test: alice chaired the meeting', entity: 'people/alice-example' },
      { fact: 'guard-test: the county commission voted 3-2', entity: 'Acme County Commission' },
      { fact: 'guard-test: bob renewed the ad', entity: 'bob-example' },
      { fact: 'guard-test: dave fixed the build', entity: 'people/dave-example' },
    ]);
    const r = await runFactsBackstop(page(), { ...ctx(), engine: freshEngineView() });
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(2);
    expect(await rowsFor('alice-example')).toBe(0);
    expect(await rowsFor('acme-county')).toBe(0);
    expect(await rowsFor('bob-example')).toBe(1);
    expect(await rowsFor('dave-example')).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = await (engine as any).db.query("SELECT summary FROM ingest_log WHERE source_type = 'facts:guard' ORDER BY id DESC LIMIT 1");
    expect(log.rows[0].summary).toContain('newsroom_entity_guard: dropped 2');
  });

  test('a body fact extracted from a pipeline page is kept; from another page it is dropped', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
    chatStub([{ fact: 'guard-test-body: commission meets mondays', entity: 'Acme County Commission' }]);
    const pipe = { ...page(), slug: 'news-pipeline/guard-body-' + Math.random().toString(36).slice(2, 7) };
    const r1 = await runFactsBackstop(pipe, { ...ctx(), engine: freshEngineView() });
    if (r1.mode === 'inline') expect(r1.inserted).toBe(1);
    chatStub([{ fact: 'guard-test-body2: commission voted', entity: 'Acme County Commission' }]);
    const other = { ...page(), slug: 'localities/guard-body-' + Math.random().toString(36).slice(2, 7) };
    const r2 = await runFactsBackstop(other, { ...ctx(), engine: freshEngineView() });
    if (r2.mode === 'inline') expect(r2.inserted).toBe(0);
  });

  test('no config key: nothing is dropped (gbn and upstream behaviour)', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, '');
    chatStub([{ fact: 'guard-test-off: carol spoke', entity: 'people/carol-example' }]);
    const r = await runFactsBackstop(page(), { ...ctx(), engine: freshEngineView() });
    if (r.mode === 'inline') expect(r.inserted).toBe(1);
  });

  test('malformed config fails open', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, '{oops');
    chatStub([{ fact: 'guard-test-bad: alice again', entity: 'alice-q-example' }]);
    const r = await runFactsBackstop(page(), { ...ctx(), engine: freshEngineView() });
    if (r.mode === 'inline') expect(r.inserted).toBe(1);
  });
});

describe('writeSingleFact with the guard set', () => {
  test('refuses a newsroom entity with a pointer to gbn', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
    await expect(
      writeSingleFact(freshEngineView(), 'default', { fact: 'guard-test-remember: alice is mayor', provenance: 'test', entity: 'Alice "Q" Example' }),
    ).rejects.toThrow(/newsroom_entity/);
  });
  test('writes an entity whose stored slug is on allow_slugs', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
    const r = await writeSingleFact(freshEngineView(), 'default', { fact: 'guard-test-remember: client renewed', provenance: 'test', entity: 'clients/carol-example' });
    expect(r.id).toBeGreaterThan(0);
  });

  test('writes an allowed entity', async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
    const r = await writeSingleFact(freshEngineView(), 'default', { fact: 'guard-test-remember: bob renewed', provenance: 'test', entity: 'bob-example' });
    expect(r.id).toBeGreaterThan(0);
  });
});
