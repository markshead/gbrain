/**
 * Fact provenance on the legacy single-row insert path.
 *
 * A brain whose source has no `sources.local_path` (a thin-client /
 * DB-only install) has no markdown tree to fence onto, so
 * `runPipelineWithBody`'s Phase 4 routes EVERY extracted fact through
 * the legacy `engine.insertFact` path instead of the fence lane.
 *
 * Two properties that path has to hold at once, pinned here together
 * because a fix for either one on its own breaks the other:
 *
 *   1. Provenance is recorded. A reader must be able to ask which page
 *      produced a claim. The fence lane always records this — the
 *      `insertFacts` batch signature types `source_markdown_slug` as
 *      REQUIRED — and the read-side `Fact` / `TrajectoryPoint` types
 *      carry the column, so consumers can already ask the question.
 *
 *   2. The fact survives the `extract_facts` cycle reconcile. That phase
 *      treats the fence as canonical and hard-deletes a page's DB rows
 *      when the page carries no fence. On a thin-client brain NO page
 *      ever carries a fence, so a legacy row must not present itself to
 *      that reconcile as a fence-owned row.
 *
 * Uses a real PGLite engine (the defect is in the INSERT column list, so
 * a mocked engine would prove nothing) with the chat transport stubbed,
 * so no API keys and no network.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

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

/** Long enough to clear the backstop's minimum-body eligibility floor. */
const LONG_BODY = 'a real meeting note with enough substance to extract from '.repeat(3);

function chatStub(
  facts: Array<{ fact: string; kind: string; notability: 'high' | 'medium' | 'low'; entity?: string | null }>,
): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: facts.map(f => ({
        fact: f.fact,
        kind: f.kind,
        entity: f.entity ?? null,
        confidence: 1.0,
        notability: f.notability,
      })),
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

/**
 * A fresh PGLite seed leaves `sources.local_path` NULL, which IS the
 * thin-client condition under test. Assert it rather than assume it, so
 * this file fails loudly instead of silently testing the fence lane if
 * that seed default ever changes.
 */
async function assertThinClient(sourceId: string): Promise<void> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  expect(rows[0]?.local_path ?? null).toBeNull();
}

async function factRow(id: number): Promise<{
  fact: string;
  source_markdown_slug: string | null;
  row_num: number | null;
}> {
  const rows = await engine.executeRaw<{
    fact: string;
    source_markdown_slug: string | null;
    row_num: number | null;
  }>(`SELECT fact, source_markdown_slug, row_num FROM facts WHERE id = $1`, [id]);
  return rows[0];
}

describe('legacy single-row insert — page provenance (thin-client brain)', () => {
  test('records the page slug that produced the fact', async () => {
    await assertThinClient('default');

    const slug = 'meetings/provenance-' + Math.random().toString(36).slice(2, 9);
    chatStub([
      { fact: 'the budget was approved', kind: 'fact', notability: 'high', entity: null },
    ]);

    const r = await runFactsBackstop(
      { slug, type: 'meeting', compiled_truth: LONG_BODY, frontmatter: {} },
      { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' },
    );

    expect(r.mode).toBe('inline');
    if (r.mode !== 'inline') return;
    expect(r.inserted).toBe(1);

    const row = await factRow(r.fact_ids[0]);
    expect(row.fact).toBe('the budget was approved');
    // Precondition: this went down the legacy single-row path. A fence row
    // always carries a row_num; this one has none.
    expect(row.row_num).toBeNull();

    // The claim came from `slug`. A reader must be able to recover that.
    expect(row.source_markdown_slug).toBe(slug);
  });

  test('survives the extract_facts reconcile of the page it came from', async () => {
    await assertThinClient('default');

    const slug = 'meetings/reconcile-' + Math.random().toString(36).slice(2, 9);

    // The page exists in the DB and carries NO `## Facts` fence — the
    // normal state of every page on a thin-client brain, since the fence
    // lane needs a local_path to write one.
    await engine.putPage(slug, {
      title: slug,
      type: 'meeting',
      compiled_truth: LONG_BODY,
      frontmatter: {},
      timeline: '',
    });

    chatStub([
      { fact: 'the vendor contract renews in March', kind: 'fact', notability: 'high', entity: null },
    ]);

    const r = await runFactsBackstop(
      { slug, type: 'meeting', compiled_truth: LONG_BODY, frontmatter: {} },
      { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' },
    );
    expect(r.mode).toBe('inline');
    if (r.mode !== 'inline') return;
    expect(r.inserted).toBe(1);
    const factId = r.fact_ids[0];

    // The fence is canonical for pages that HAVE one. This page has none,
    // and this row was never fence-owned (`row_num` is NULL), so the
    // reconcile must leave it alone.
    await runExtractFacts(engine, { slugs: [slug], sourceId: 'default' });

    const survivors = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM facts WHERE id = $1`,
      [factId],
    );
    expect(Number(survivors[0].n)).toBe(1);

    const row = await factRow(factId);
    expect(row.row_num).toBeNull();
    expect(row.fact).toBe('the vendor contract renews in March');
  });
});
