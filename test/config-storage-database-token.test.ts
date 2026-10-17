import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { loadConfig, saveConfig, resolveStorageDatabaseToken } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { createStorage } from '../src/core/storage.ts';

// One config.json can serve several brains (each process overrides only the
// database via GBRAIN_DATABASE_URL). A `{database}` token in storage.localPath
// keeps each brain's files in its own store, chosen by the database the
// process actually connects to — so a forgotten env var can never route one
// brain's originals into another brain's store.

describe('resolveStorageDatabaseToken', () => {
  test('substitutes the database name from the URL path', () => {
    const out = resolveStorageDatabaseToken(
      { backend: 'local', bucket: 'b', localPath: '/srv/files/{database}' },
      'postgresql://u:p@localhost:5432/newsroom',
    ) as { localPath: string };
    expect(out.localPath).toBe('/srv/files/newsroom');
  });

  test('ignores query strings', () => {
    const out = resolveStorageDatabaseToken(
      { backend: 'local', bucket: 'b', localPath: '/srv/{database}/x' },
      'postgres://u@h/gbrain?sslmode=disable',
    ) as { localPath: string };
    expect(out.localPath).toBe('/srv/gbrain/x');
  });

  test('fails closed (drops storage) when the database name cannot be resolved', () => {
    expect(resolveStorageDatabaseToken({ backend: 'local', bucket: 'b', localPath: '/srv/{database}' }, undefined)).toBeUndefined();
    expect(resolveStorageDatabaseToken({ backend: 'local', bucket: 'b', localPath: '/srv/{database}' }, 'postgres://h/')).toBeUndefined();
    expect(resolveStorageDatabaseToken({ backend: 'local', bucket: 'b', localPath: '/srv/{database}' }, 'postgres://h/a%2F..%2Fetc')).toBeUndefined();
  });

  test('leaves storage without the token untouched', () => {
    const s = { backend: 'local', bucket: 'b', localPath: '/srv/files' };
    expect(resolveStorageDatabaseToken(s, undefined)).toBe(s);
    expect(resolveStorageDatabaseToken(undefined, 'postgres://h/db')).toBeUndefined();
  });
});

describe('loadConfig applies the {database} token after the env override', () => {
  test('GBRAIN_DATABASE_URL selects the per-database store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-storage-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, () => {
        saveConfig({
          engine: 'postgres',
          database_url: 'postgresql://u@localhost:5432/gbrain',
          storage: { backend: 'local', bucket: 'files', localPath: '/srv/files/{database}' },
        } as any);
      });
      await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, () => {
        expect((loadConfig()!.storage as any).localPath).toBe('/srv/files/gbrain');
      });
      await withEnv(
        { GBRAIN_HOME: home, GBRAIN_DATABASE_URL: 'postgresql://u@localhost:5432/newsroom', DATABASE_URL: undefined },
        () => {
          expect((loadConfig()!.storage as any).localPath).toBe('/srv/files/newsroom');
        },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('createStorage refuses an unresolved {database} token', () => {
  test('throws instead of creating a literal {database} directory', async () => {
    await expect(createStorage({ backend: 'local', bucket: 'b', localPath: '/tmp/x/{database}' } as any)).rejects.toThrow('unresolved');
  });
});
