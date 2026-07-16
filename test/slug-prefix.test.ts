/**
 * Per-source slug-prefix (sources.config.slug_prefix) — v0.42.x.
 *
 * A source may declare `config.slug_prefix = "news-server"` so every page it
 * syncs mounts under that namespace (`news-server/agents`) instead of the
 * brain's top level. Coverage:
 *
 *   1. validateSlugPrefix / slugPrefixFromSourceConfig — shape validation,
 *      loud rejection of bad values, unset = undefined.
 *   2. resolveSlugForPath — prefixed derivation for markdown AND code paths
 *      (the delete/rename fallback shape in commands/sync.ts).
 *   3. importFile / importCodeFile — import-time slugs carry the prefix,
 *      uniformly across the path-derived, frontmatter-fallback, and code
 *      branches; unset prefix is bit-for-bit today's behavior.
 *   4. PGLite integration — `sources add --slug-prefix` persists
 *      config.slug_prefix; getSourceSlugPrefix round-trips + fails loudly on
 *      invalid stored config; resolveSlugByPathOrSourcePath never
 *      double-prefixes a slug resolved via pages.source_path.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SLUG_PREFIX_RE,
  validateSlugPrefix,
  slugPrefixFromSourceConfig,
  resolveSlugForPath,
} from '../src/core/sync.ts';
import { importFile, importCodeFile } from '../src/core/import-file.ts';
import { addSource, SourceOpError } from '../src/core/sources-ops.ts';
import { getSourceSlugPrefix } from '../src/core/sources-load.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const TMP = join(import.meta.dir, '.tmp-slug-prefix-test');

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── 1. Validation ───────────────────────────────────────────────────────────

describe('validateSlugPrefix', () => {
  test('accepts single lowercase segment', () => {
    expect(validateSlugPrefix('news-server')).toBe('news-server');
    expect(validateSlugPrefix('a')).toBe('a');
    expect(validateSlugPrefix('a1')).toBe('a1');
  });

  test('accepts multi-segment prefixes', () => {
    expect(validateSlugPrefix('repos/news-server')).toBe('repos/news-server');
    expect(validateSlugPrefix('a1-b2/c3')).toBe('a1-b2/c3');
  });

  test('rejects leading slash', () => {
    expect(() => validateSlugPrefix('/x')).toThrow(/Invalid slug_prefix/);
  });

  test('rejects trailing slash', () => {
    expect(() => validateSlugPrefix('x/')).toThrow(/Invalid slug_prefix/);
  });

  test('rejects uppercase', () => {
    expect(() => validateSlugPrefix('X')).toThrow(/Invalid slug_prefix/);
    expect(() => validateSlugPrefix('News-Server')).toThrow(/Invalid slug_prefix/);
  });

  test('rejects empty segments (double slash)', () => {
    expect(() => validateSlugPrefix('a//b')).toThrow(/Invalid slug_prefix/);
  });

  test('rejects empty string, spaces, underscores, leading hyphen', () => {
    expect(() => validateSlugPrefix('')).toThrow(/Invalid slug_prefix/);
    expect(() => validateSlugPrefix('news server')).toThrow(/Invalid slug_prefix/);
    expect(() => validateSlugPrefix('a_b')).toThrow(/Invalid slug_prefix/);
    expect(() => validateSlugPrefix('-a')).toThrow(/Invalid slug_prefix/);
  });

  test('error message names the caller-provided context', () => {
    expect(() => validateSlugPrefix('/x', 'source "news-server" config.slug_prefix'))
      .toThrow(/source "news-server" config\.slug_prefix/);
  });

  test('SLUG_PREFIX_RE is anchored (no partial matches)', () => {
    expect(SLUG_PREFIX_RE.test('ok/but trailing junk!')).toBe(false);
  });
});

describe('slugPrefixFromSourceConfig', () => {
  test('unset → undefined (the default for every existing source)', () => {
    expect(slugPrefixFromSourceConfig({})).toBeUndefined();
    expect(slugPrefixFromSourceConfig({ slug_prefix: null })).toBeUndefined();
    expect(slugPrefixFromSourceConfig({ federated: true })).toBeUndefined();
  });

  test('valid string round-trips', () => {
    expect(slugPrefixFromSourceConfig({ slug_prefix: 'news-server' })).toBe('news-server');
  });

  test('present-but-invalid fails loudly', () => {
    expect(() => slugPrefixFromSourceConfig({ slug_prefix: '' })).toThrow(/Invalid/);
    expect(() => slugPrefixFromSourceConfig({ slug_prefix: 'X' })).toThrow(/Invalid/);
    expect(() => slugPrefixFromSourceConfig({ slug_prefix: 42 })).toThrow(/expected a string/);
    expect(() => slugPrefixFromSourceConfig({ slug_prefix: 'a//b' })).toThrow(/Invalid/);
  });
});

// ── 2. Path-derived fallback shape ──────────────────────────────────────────

describe('resolveSlugForPath with slug prefix', () => {
  test('markdown path mounts under the prefix', () => {
    expect(resolveSlugForPath('docs/agents.md', 'news-server')).toBe('news-server/docs/agents');
    expect(resolveSlugForPath('agents.md', 'news-server')).toBe('news-server/agents');
  });

  test('code path mounts under the prefix (flattened code slug)', () => {
    expect(resolveSlugForPath('src/core/sync.ts', 'news-server')).toBe('news-server/src-core-sync-ts');
  });

  test('no prefix = unchanged behavior', () => {
    expect(resolveSlugForPath('docs/agents.md')).toBe('docs/agents');
    expect(resolveSlugForPath('src/core/sync.ts')).toBe('src-core-sync-ts');
  });
});

// ── 3. Import-time slugs ────────────────────────────────────────────────────

// Minimal mock engine (same pattern as test/import-file.test.ts — kept in
// step with it, including the in-memory pageStore that satisfies #2869's
// post-write read-back guard in importFromContent/importCodeFile. Without the
// store, every import throws "post-write read-back failed").
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  // In-memory page store: slug → page row (simulates a real DB index).
  const pageStore = new Map<string, { slug: string; content_hash: string; title: string; type: string; frontmatter: Record<string, unknown> }>();
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };

  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') {
        return async (slug: string, opts?: { sourceId?: string }) => {
          // A test-supplied getPage models the pre-existing page; the store
          // models the post-write state the read-back guard must observe.
          if (overrides.getPage) {
            const overrideResult = await overrides.getPage(slug, opts);
            if (overrideResult) {
              const stored = pageStore.get(slug);
              if (stored) return { ...overrideResult, content_hash: stored.content_hash };
              return overrideResult;
            }
          }
          return pageStore.get(slug) ?? null;
        };
      }
      if (prop === 'putPage') {
        return async (slug: string, page: { content_hash?: string; title?: string; type?: string; frontmatter?: Record<string, unknown> }, _opts?: { sourceId?: string }) => {
          calls.push({ method: 'putPage', args: [slug, page, _opts] });
          if (overrides.putPage) overrides.putPage(slug, page, _opts);
          pageStore.set(slug, {
            slug,
            content_hash: page.content_hash ?? '',
            title: page.title ?? '',
            type: page.type ?? '',
            frontmatter: page.frontmatter ?? {},
          });
          return Promise.resolve(undefined);
        };
      }
      if (prop === 'getChunks') return overrides.getChunks || (() => Promise.resolve([]));
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

describe('importFile with slugPrefix', () => {
  test('markdown import derives the prefixed slug', async () => {
    const filePath = join(TMP, 'prefixed-page.md');
    writeFileSync(filePath, `---
type: concept
title: Prefixed Page
---

Body text.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/prefixed-page.md', {
      noEmbed: true,
      slugPrefix: 'news-server',
    });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('news-server/concepts/prefixed-page');

    const putCall = (engine as any)._calls.find((c: any) => c.method === 'putPage');
    expect(putCall.args[0]).toBe('news-server/concepts/prefixed-page');
    // source_path stays the RAW repo-relative path — DB lookups by path are
    // prefix-agnostic, which is what protects delete/rename from double-prefixing.
    expect(putCall.args[1].source_path).toBe('concepts/prefixed-page.md');
  });

  test('no slugPrefix = today\'s behavior exactly', async () => {
    const filePath = join(TMP, 'unprefixed-page.md');
    writeFileSync(filePath, `---
type: concept
title: Unprefixed Page
---

Body text.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/unprefixed-page.md', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('concepts/unprefixed-page');
  });

  test('anti-spoof check compares UNprefixed slugs; final slug is prefixed', async () => {
    // Frontmatter declares the slug relative to its repo (matching the path);
    // the prefix mounts it. A prefix must not break existing repos that pin
    // slugs in frontmatter.
    const filePath = join(TMP, 'fm-match.md');
    writeFileSync(filePath, `---
type: concept
title: FM Match
slug: concepts/fm-match
---

Body.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'concepts/fm-match.md', {
      noEmbed: true,
      slugPrefix: 'news-server',
    });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('news-server/concepts/fm-match');
  });

  test('frontmatter-fallback slug (exotic filename) is prefixed uniformly', async () => {
    // Emoji filename → slugifyPath('') → frontmatter slug takes over → the
    // prefix applies AFTER that resolution, same as the path-derived branch.
    const filePath = join(TMP, '🚀.md');
    writeFileSync(filePath, `---
type: project
title: Launch
slug: projects/launch
---

Body.
`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, '🚀.md', {
      noEmbed: true,
      slugPrefix: 'news-server',
    });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('news-server/projects/launch');
  });

  test('code file routed through importFile gets the prefixed code slug', async () => {
    const filePath = join(TMP, 'widget.ts');
    writeFileSync(filePath, `export function widget(): number {\n  return 42;\n}\n`);

    const engine = mockEngine();
    const result = await importFile(engine, filePath, 'src/widget.ts', {
      noEmbed: true,
      slugPrefix: 'news-server',
    });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('news-server/src-widget-ts');
    // Matches the delete/rename fallback derivation exactly:
    expect(result.slug).toBe(resolveSlugForPath('src/widget.ts', 'news-server'));
  });
});

describe('importCodeFile with slugPrefix', () => {
  test('prefixed code slug', async () => {
    const engine = mockEngine();
    const result = await importCodeFile(engine, 'src/core/thing.ts', 'export const x = 1;\n', {
      noEmbed: true,
      slugPrefix: 'news-server',
    });
    expect(result.slug).toBe('news-server/src-core-thing-ts');
  });

  test('no prefix = unchanged code slug', async () => {
    const engine = mockEngine();
    const result = await importCodeFile(engine, 'src/core/thing.ts', 'export const x = 1;\n', {
      noEmbed: true,
    });
    expect(result.slug).toBe('src-core-thing-ts');
  });
});

// ── 4. PGLite integration: sources add / config round-trip / fallbacks ─────

describe('slug prefix — PGLite integration', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('sources add --slug-prefix persists config.slug_prefix', async () => {
    const row = await addSource(engine, {
      id: 'news-server',
      localPath: '/tmp/slug-prefix-test/news-server',
      slugPrefix: 'news-server',
    });
    expect(row.config.slug_prefix).toBe('news-server');

    // And the loader round-trips it (the value sync/import actually use).
    expect(await getSourceSlugPrefix(engine, 'news-server')).toBe('news-server');
  });

  test('sources add rejects an invalid prefix loudly, before inserting', async () => {
    for (const bad of ['/x', 'x/', 'X', 'a//b']) {
      try {
        await addSource(engine, { id: 'bad-prefix', localPath: '/tmp/slug-prefix-test/bad', slugPrefix: bad });
        throw new Error(`expected addSource to reject prefix "${bad}"`);
      } catch (e) {
        expect(e).toBeInstanceOf(SourceOpError);
        expect((e as SourceOpError).code).toBe('invalid_slug_prefix');
      }
    }
    // Nothing was inserted for any of the rejected attempts.
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = 'bad-prefix'`,
    );
    expect(rows.length).toBe(0);
  });

  test('getSourceSlugPrefix: unset prefix and unknown source → undefined', async () => {
    await addSource(engine, { id: 'plain', localPath: '/tmp/slug-prefix-test/plain' });
    expect(await getSourceSlugPrefix(engine, 'plain')).toBeUndefined();
    expect(await getSourceSlugPrefix(engine, 'does-not-exist')).toBeUndefined();
  });

  test('getSourceSlugPrefix: invalid stored config fails loudly (no silent unprefixed import)', async () => {
    // Simulate a hand-edited / corrupted config row (addSource would have
    // rejected this value).
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('corrupt', 'corrupt', '{"slug_prefix":"/bad/"}'::jsonb)`,
    );
    await expect(getSourceSlugPrefix(engine, 'corrupt')).rejects.toThrow(/Invalid source "corrupt" config\.slug_prefix/);
  });

  test('resolveSlugByPathOrSourcePath: stored slug wins and is NEVER re-prefixed', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('news-server', 'news-server') ON CONFLICT DO NOTHING`,
    );
    // Page imported under the prefix — its stored slug already carries it.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('news-server', 'news-server/docs/agents', 'note', 'Agents', 'body', 'markdown', 'docs/agents.md')`,
    );
    const slug = await resolveSlugByPathOrSourcePath(engine, 'docs/agents.md', 'news-server', 'news-server');
    expect(slug).toBe('news-server/docs/agents'); // NOT news-server/news-server/...
  });

  test('resolveSlugByPathOrSourcePath: derived fallback carries the prefix', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('news-server', 'news-server') ON CONFLICT DO NOTHING`,
    );
    // No row for this path → pure-JS derivation must agree with import-time slugs.
    const md = await resolveSlugByPathOrSourcePath(engine, 'plan-postmodern-migration.md', 'news-server', 'news-server');
    expect(md).toBe('news-server/plan-postmodern-migration');
    const code = await resolveSlugByPathOrSourcePath(engine, 'db/migrate.ts', 'news-server', 'news-server');
    expect(code).toBe('news-server/db-migrate-ts');
  });

  test('resolveSlugByPathOrSourcePath: no prefix = today\'s fallback exactly', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    const slug = await resolveSlugByPathOrSourcePath(engine, 'concepts/hello.md', undefined);
    expect(slug).toBe('concepts/hello');
  });
});

// ── 5. End-to-end: gbrain sync against a prefixed source ───────────────────
//
// The whole feature, driven the way production drives it: the prefix lives
// ONLY in sources.config (performSyncInner resolves it — nothing passes
// slugPrefix explicitly), a real git repo backs the source, and both the
// full-walk first sync AND the incremental delete path are exercised.
// Pattern mirrors test/performfullsync-source-id.test.ts.

describe('sync end-to-end with config.slug_prefix', () => {
  let e2eEngine: PGLiteEngine;
  let repoPath: string;

  const git = (cmd: string) => execSync(cmd, { cwd: repoPath, stdio: 'pipe' });
  /** Live slugs of the news-server source, sorted. Shared by every test here. */
  const slugs = async () => (await e2eEngine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'news-server' AND deleted_at IS NULL ORDER BY slug`,
  )).map(r => r.slug);

  beforeAll(async () => {
    e2eEngine = new PGLiteEngine();
    await e2eEngine.connect({});
    await e2eEngine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (e2eEngine) await e2eEngine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  }, 60_000);

  test('first sync mounts every page under the prefix; incremental delete removes the prefixed slug', async () => {
    // #2707: `sources add --path` now requires the path to already be a git
    // repo with committed, tracked files — so build the repo BEFORE
    // registering it (which is also the order the error message tells users
    // to use). Registration then goes through the real CLI surface, with the
    // prefix living in sources.config only.
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-slug-prefix-'));
    git('git init');
    git('git config user.email "test@test.com"');
    git('git config user.name "Test"');
    writeFileSync(join(repoPath, 'agents.md'), '---\ntitle: Agents\n---\n\nAgent docs.\n');
    mkdirSync(join(repoPath, 'db/migrations'), { recursive: true });
    writeFileSync(join(repoPath, 'db/migrations/readme.md'), '---\ntitle: Migrations\n---\n\nHow to migrate.\n');
    git('git add -A && git commit -m "initial"');

    const { runSources } = await import('../src/commands/sources.ts');
    await runSources(e2eEngine, ['add', 'news-server', '--path', repoPath, '--no-federated', '--slug-prefix', 'news-server']);

    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(e2eEngine, {
      repoPath,
      sourceId: 'news-server',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(['first_sync', 'synced']).toContain(first.status);

    expect(await slugs()).toEqual(['news-server/agents', 'news-server/db/migrations/readme']);

    // Incremental: delete a file. The delete resolves the PREFIXED slug (via
    // source_path lookup, with the prefixed derivation as fallback) — the
    // page must actually disappear, not orphan.
    rmSync(join(repoPath, 'agents.md'));
    git('git add -A && git commit -m "remove agents"');

    const second = await performSync(e2eEngine, {
      repoPath,
      sourceId: 'news-server',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(second.deleted).toBe(1);
    expect(await slugs()).toEqual(['news-server/db/migrations/readme']);
  }, 120_000);

  // Adversarial-review finding (codex #1, independently reproduced end-to-end
  // in a scratch PGLite brain): upstream #2018 made write-through mirror a
  // page to the SOURCE's own working tree. That tree is the synced repo, so a
  // slug-derived mirror path re-injects the prefix as a real directory —
  // `<repo>/news-server/agents/probe.md` — and the next full sync re-imports
  // it as `news-server/news-server/agents/probe`, once more per cycle.
  // The mirror path must be the RAW repo-relative path, the one source_path
  // holds and the importer reads back.
  test('write-through mirrors a prefixed page to its repo-relative path, not the prefixed one', async () => {
    await e2eEngine.putPage(
      'news-server/agents/probe',
      { type: 'note', title: 'Probe', compiled_truth: 'probe body', timeline: '', frontmatter: {} },
      { sourceId: 'news-server' },
    );
    const { writePageThrough } = await import('../src/core/write-through.ts');
    const res = await writePageThrough(e2eEngine, 'news-server/agents/probe', { sourceId: 'news-server' });

    expect(res.written).toBe(true);
    expect(existsSync(join(repoPath, 'agents/probe.md'))).toBe(true);
    // The regression: a `news-server/` directory INSIDE the synced repo.
    expect(existsSync(join(repoPath, 'news-server'))).toBe(false);

    // Round-trip: committing the mirror and re-syncing must NOT fork a
    // doubled-prefix page — the file re-imports onto its own slug.
    git('git add -A && git commit -m "write-through artifact"');
    const after = await performSyncFn()(e2eEngine, {
      repoPath, sourceId: 'news-server', noPull: true, noEmbed: true, noExtract: true,
    });
    expect(after.status).not.toBe('error');
    const all = await slugs();
    expect(all).toContain('news-server/agents/probe');
    expect(all).not.toContain('news-server/news-server/agents/probe');
  }, 120_000);

  // Adversarial-review finding (grok #4 / codex #5): the drift probe must look
  // only at FILE-BACKED rows. A put_page / MCP row legitimately lives outside
  // the mount; counting it made the warning fire on every sync forever, which
  // trains operators to ignore it — and with it the real drift it exists for.
  test('drift warning ignores non-file-backed (put_page) rows', async () => {
    await e2eEngine.putPage(
      'scratch/manual-note',
      { type: 'note', title: 'Manual', compiled_truth: 'manual body', timeline: '', frontmatter: {} },
      { sourceId: 'news-server' },
    );
    const captured: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const realError = console.error;
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return (realWrite as any)(chunk, ...rest);
    };
    console.error = (...args: any[]) => {
      captured.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    try {
      await performSyncFn()(e2eEngine, {
        repoPath, sourceId: 'news-server', noPull: true, noEmbed: true, noExtract: true,
      });
    } finally {
      (process.stderr as any).write = realWrite;
      console.error = realError;
    }
    expect(captured.join('')).not.toContain('declares slug_prefix');
  }, 120_000);

  // Adversarial-review finding (codex): adding/changing a prefix on a source
  // that already has pages forks their slugs. There is no CLI surface to
  // mutate the prefix, so this only reaches a user via a hand-edited config —
  // which means it would otherwise be entirely silent. Sync must say so.
  test('warns when configured prefix does not match already-stored slugs', async () => {
    // `serr` routes through console.error when no source prefix is active,
    // and through process.stderr.write when one is — capture both.
    const captured: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const realError = console.error;
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return (realWrite as any)(chunk, ...rest);
    };
    console.error = (...args: any[]) => {
      captured.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    try {
      // Drift the config out from under the already-synced pages.
      await e2eEngine.executeRaw(
        `UPDATE sources SET config = jsonb_set(config, '{slug_prefix}', '"elsewhere"') WHERE id = $1`,
        ['news-server'],
      );
      await performSyncFn()(e2eEngine, {
        repoPath, sourceId: 'news-server', noPull: true, noEmbed: true, noExtract: true,
      });
    } finally {
      (process.stderr as any).write = realWrite;
      console.error = realError;
    }
    const all = captured.join('');
    expect(all).toContain('declares slug_prefix "elsewhere"');
    expect(all).toContain('are NOT under it');
  }, 120_000);
});

/** Lazy import so the drift test shares the module instance used above. */
function performSyncFn() {
  return async (engine: any, opts: any) => {
    const { performSync } = await import('../src/commands/sync.ts');
    return performSync(engine, opts);
  };
}
