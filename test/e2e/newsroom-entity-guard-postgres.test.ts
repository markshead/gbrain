/**
 * Local patch 2026-10-06 (gbxheld) — newsroom entity guard on the REAL Postgres engine.
 * The unit suite covers the same paths on PGLite; this pins that the config read, the drop log
 * and the guarded write paths behave the same against Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runFactsBackstop } from '../../src/core/facts/backstop.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { NEWSROOM_ENTITY_GUARD_CONFIG_KEY } from '../../src/core/facts/newsroom-entity-guard.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
if (skip) test.skip('newsroom entity guard Postgres e2e skipped (DATABASE_URL unset)', () => {});

const CASES = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/newsroom-entity-guard-cases.json'), 'utf8'));
const GUARD_JSON = JSON.stringify(CASES.guard);
const TAG = 'nr-guard-e2e';

describe.skipIf(skip)('newsroom entity guard on Postgres', () => {
  let engine: PostgresEngine;
  const view = () => Object.create(engine) as PostgresEngine; // fresh guard cache per test

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });
  afterAll(async () => {
    if (!engine) return;
    await engine.executeRaw(`DELETE FROM facts WHERE fact LIKE '${TAG}%'`);
    await engine.executeRaw(`DELETE FROM pages WHERE slug IN ('people/alice-example', 'people/dave-example', 'notes/${TAG}')`);
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, '');
    __setChatTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });
  beforeEach(async () => {
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
  });

  test('pipeline drops guarded entities and keeps the rest', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [
        { fact: `${TAG} alice chaired`, kind: 'fact', entity: 'people/alice-example', confidence: 1, notability: 'high' },
        { fact: `${TAG} dave fixed it`, kind: 'fact', entity: 'people/dave-example', confidence: 1, notability: 'high' },
      ] }),
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub', providerId: 'test',
    }));
    const r = await runFactsBackstop(
      { slug: `notes/${TAG}`, type: 'note', compiled_truth: 'a pipeline note naming people in passing. '.repeat(4), frontmatter: {} },
      { engine: view(), sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' },
    );
    if (r.mode === 'inline') expect(r.inserted).toBe(1);
    const rows = await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE fact LIKE '${TAG}%' ORDER BY fact`);
    expect(rows.map((x) => x.fact)).toEqual([`${TAG} dave fixed it`]);
  });

  test('writeSingleFact refuses a guarded entity', async () => {
    await expect(writeSingleFact(view(), 'default', { fact: `${TAG} remember alice`, provenance: 'test', entity: 'Alice Example' }))
      .rejects.toThrow(/newsroom_entity/);
  });

  test('fence reconcile skips a guarded page', async () => {
    const fence = (claim: string) => `# P\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | ${claim} | fact | 1.0 | world | high | 2026-01-01 |  | s |  |\n<!--- gbrain:facts:end -->\n`;
    await engine.putPage('people/alice-example', { title: 'A', type: 'person', compiled_truth: fence(`${TAG} fenced alice`), frontmatter: {}, timeline: '' });
    await engine.putPage('people/dave-example', { title: 'D', type: 'person', compiled_truth: fence(`${TAG} fenced dave`), frontmatter: {}, timeline: '' });
    await runExtractFacts(view(), { slugs: ['people/alice-example', 'people/dave-example'] });
    const rows = await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE fact LIKE '${TAG} fenced%' ORDER BY fact`);
    expect(rows.map((x) => x.fact)).toEqual([`${TAG} fenced dave`]);
  });
});
