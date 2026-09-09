import { describe, it, expect, beforeAll } from 'bun:test';
import {
  resolveEntitySlug,
  resolveEntitySlugWithSource,
  namespaceStripCandidates,
  _resetResolveConfigCache,
} from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * slug-frag 2026-09-09 — the extractor mints namespaces the brain never had
 * (`companies/usd-234-fort-scott` for page `ks/usd-234`) and fuzzy resolution
 * happily files an entity under a STORY page whose title happens to overlap.
 * Fixtures mirror the newsroom shapes that produced 12,533 slugs for ~10k
 * entities; names are the real public bodies (a school district, a city).
 */

let engine: PGLiteEngine;
const E = () => engine as unknown as BrainEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  const pages = [
    { slug: 'ks/usd-234', title: 'USD 234 — Fort Scott Unified School District 234', type: 'org' },
    { slug: 'ks/usd-234/board', title: 'USD 234 Board of Education (Fort Scott)', type: 'org' },
    { slug: 'ks/usd-235/board', title: 'USD 235 Board of Education', type: 'org' },
    { slug: 'people/mark-shead', title: 'Mark Shead', type: 'person' },
    { slug: 'stories/2020/03/fort-scott-va', title: 'Fort Scott VA', type: 'story' },
    { slug: 'companies/acme-widgets', title: 'Acme Widgets', type: 'company' },
    { slug: 'orgs/evergy', title: 'Evergy', type: 'org' },
  ];
  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type as any,
      title: p.title,
      compiled_truth: `# ${p.title}`,
      frontmatter: { type: p.type, title: p.title, slug: p.slug },
    }, { sourceId: 'default' });
  }
  await engine.setPageAliases('ks/usd-234', 'default', ['usd 234', 'usd-234', 'fort scott usd 234']);
  await engine.setConfig('entities.resolve_strip_suffixes', 'fort-scott,fort-scott-ks,fort-scott-kansas,ks,kansas,inc,llc');
  _resetResolveConfigCache();
});

describe('namespaceStripCandidates', () => {
  it('yields the last segment, then qualifier-stripped forms, longest suffix first', () => {
    expect(namespaceStripCandidates('companies/usd-234-fort-scott-ks', ['fort-scott-ks', 'ks', 'fort-scott']))
      .toEqual(['usd-234-fort-scott-ks', 'usd-234']);
    expect(namespaceStripCandidates('organizations/usd-234-fort-scott', ['ks', 'fort-scott']))
      .toEqual(['usd-234-fort-scott', 'usd-234']);
  });
  it('drops single-token bases so bare generic words never suffix-match', () => {
    expect(namespaceStripCandidates('board', ['ks'])).toEqual([]);
    expect(namespaceStripCandidates('ks/usd-234/board', ['ks'])).toEqual([]);
  });
  it('a page-level duplicate sharing the suffix is not guessed, but a curated alias still wins', async () => {
    await engine.putPage('orgs/usd-234', { type: 'org' as any, title: 'USD 234 (coverage hub)', compiled_truth: '# x', frontmatter: {} }, { sourceId: 'default' });
    const r = await resolveEntitySlugWithSource(E(), 'default', 'schools/usd-234');
    expect(r!.slug).toBe('ks/usd-234');
    expect(r!.source).toBe('alias_exact');
    await engine.softDeletePage('orgs/usd-234');
  });
});

describe('invented namespace prefixes resolve to the real page', () => {
  it('companies/<entity> → the ks/ page (suffix match on the last segment)', async () => {
    const r = await resolveEntitySlugWithSource(E(), 'default', 'companies/usd-234');
    expect(r!.slug).toBe('ks/usd-234');
    expect(r!.source).toBe('exact_page');
  });
  it('geographic qualifier variants fold via config-driven suffix stripping + alias', async () => {
    for (const raw of ['companies/usd-234-fort-scott', 'organizations/usd-234-fort-scott-ks', 'usd-234-fort-scott-kansas', 'schools/usd-234']) {
      expect(await resolveEntitySlug(E(), 'default', raw)).toBe('ks/usd-234');
    }
  });
  it('a hyphenated full-name slug finds its own people/ page (fuzzy scored it 0.61 before)', async () => {
    expect(await resolveEntitySlug(E(), 'default', 'mark-shead')).toBe('people/mark-shead');
    expect(await resolveEntitySlug(E(), 'default', 'organizations/mark-shead')).toBe('people/mark-shead');
  });
  it('an ambiguous suffix (two boards) is refused, not guessed', async () => {
    // both ks/usd-234/board and ks/usd-235/board end in /board; single-token anyway
    expect(await resolveEntitySlug(E(), 'default', 'organizations/board')).toBe('organizations/board');
  });
  it('legal suffix: companies/acme-widgets-inc → companies/acme-widgets; a single-token base is refused', async () => {
    expect(await resolveEntitySlug(E(), 'default', 'companies/acme-widgets-inc')).toBe('companies/acme-widgets');
    expect(await resolveEntitySlug(E(), 'default', 'companies/acme-inc')).toBe('companies/acme-inc');
  });
});

describe('single-token base: exact title only', () => {
  it('companies/evergy → the page titled "Evergy" (equality, not fuzzy)', async () => {
    const r = await resolveEntitySlugWithSource(E(), 'default', 'companies/evergy');
    expect(r!.slug).toBe('orgs/evergy');
    expect(r!.source).toBe('exact_page');
  });
});

describe('fuzzy resolution never lands on a document page', () => {
  it('"Fort Scott" no longer resolves to the story titled "Fort Scott VA"', async () => {
    const r = await resolveEntitySlugWithSource(E(), 'default', 'Fort Scott');
    expect(r!.slug).not.toBe('stories/2020/03/fort-scott-va');
    expect(r!.source).toBe('fallback_slugify');
    expect(r!.slug).toBe('fort-scott');
  });
});
