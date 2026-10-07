/**
 * Local patch 2026-10-06 (gbxheld) — the newsroom entity guard on the two insert paths that do
 * not go through the extraction pipeline: the extract_facts cycle phase (fence -> DB reconcile)
 * and conversation-facts extraction. Pipeline and writeSingleFact coverage lives in
 * newsroom-entity-guard.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { PER_SEGMENT_SOURCE_PREFIX, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { NEWSROOM_ENTITY_GUARD_CONFIG_KEY } from '../src/core/facts/newsroom-entity-guard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const CASES = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/newsroom-entity-guard-cases.json'), 'utf8'));
const GUARD_JSON = JSON.stringify(CASES.guard);

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

const FENCE = (rows: string): string => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

async function count(where: string, args: unknown[] = []): Promise<number> {
  const r = await engine.executeRaw<{ n: string | number }>(`SELECT COUNT(*) AS n FROM facts WHERE ${where}`, args);
  return Number(r[0]?.n ?? 0);
}

describe('extract_facts cycle phase (fence -> DB) with the guard set', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw(`UPDATE sources SET local_path = '/tmp/gbrain-guard-paths-test' WHERE id = 'default'`);
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
  });

  test('a guarded page\'s fence rows are not reconciled into the DB; an ordinary page\'s are', async () => {
    const rows = `| 1 | Chaired the meeting | fact | 1.0 | world | high | 2026-01-01 |  | s |  |`;
    for (const slug of ['people/alice-example', 'people/dave-example']) {
      await engine.putPage(slug, { title: slug, type: 'person', compiled_truth: FENCE(rows), frontmatter: {}, timeline: '' });
    }
    const r = await runExtractFacts(engine, { slugs: ['people/alice-example', 'people/dave-example'] });
    expect(await count(`source_markdown_slug = 'people/alice-example'`)).toBe(0);
    expect(await count(`source_markdown_slug = 'people/dave-example'`)).toBe(1);
    expect(r.factsInserted).toBe(1);
  });
});

describe('conversation facts extraction with the guard set', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    await engine.setConfig(NEWSROOM_ENTITY_GUARD_CONFIG_KEY, GUARD_JSON);
    await engine.putPage('sessions/example', {
      type: 'conversation',
      title: 'Example conversation',
      compiled_truth: [
        '**Alpha Example** (2026-08-12 10:00 AM): The commission met.',
        '**Beta Example** (2026-08-12 10:01 AM): Noted.',
      ].join('\n'),
      timeline: '',
      frontmatter: {},
    });
  });

  test('drops facts about guarded entities and keeps the rest', async () => {
    const facts: ExtractedFact[] = [
      { fact: 'Alice chaired it', kind: 'event', entity_slug: 'Alice Example', source: 't', source_session: null, confidence: 1, notability: 'medium' },
      { fact: 'Dave took notes', kind: 'event', entity_slug: 'Dave Example', source: 't', source_session: null, confidence: 1, notability: 'medium' },
      { fact: 'It rained', kind: 'fact', entity_slug: null, source: 't', source_session: null, confidence: 1, notability: 'low' },
    ];
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runExtractConversationFactsCore(engine, {
        sourceId: 'default', slug: 'sessions/example', types: ['conversation'], sleepMs: 0,
        extractor: async () => facts.map((f) => ({ ...f })),
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source = $1 AND source_markdown_slug = 'sessions/example' ORDER BY row_num`,
      [PER_SEGMENT_SOURCE_PREFIX],
    );
    expect(rows.map((r) => r.fact)).toEqual(['Dave took notes', 'It rained']);
  });
});
