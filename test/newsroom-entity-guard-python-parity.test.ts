/**
 * Local patch 2026-10-06 (gbxheld): the box-side Python refresh/sweep script must decide exactly
 * like the TypeScript guard. Runs its fixture self-test (no database needed) inside bun test.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

describe.skipIf(!py)('newsroom entity guard: Python parity', () => {
  test('scripts/local/gbx-newsroom-entity-guard.py test passes the shared fixture', () => {
    const r = spawnSync(py!, ['-I', join(import.meta.dir, '..', 'scripts', 'local', 'gbx-newsroom-entity-guard.py'), 'test'], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/(\d+)\/\1 passed/);
    expect(r.status).toBe(0);
  });
});
