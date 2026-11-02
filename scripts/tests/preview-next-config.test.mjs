import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../next.config.ts', import.meta.url));
function fixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'reader-next-config-'));
  try {
    writeFileSync(join(root, 'next.config.ts'), readFileSync(source));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: 'fixture' }));
    mkdirSync(join(root, '.preview'));
    writeFileSync(join(root, '.preview/state.json'), JSON.stringify({ identity: { head: 'a'.repeat(40) } }));
    writeFileSync(join(root, '.pi-web-reader-release.json'), JSON.stringify({ readerCommit: 'b'.repeat(40) }));
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `const { default: config } = await import(${JSON.stringify(pathToFileURL(join(root, 'next.config.ts')).href)}); console.log(JSON.stringify(config));`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, NODE_ENV: mode, PI_WEB_ALLOWED_HOSTS: 'fixture.tailnet.ts.net',
        ...(mode === 'development' ? { NEXT_PUBLIC_READER_COMMIT: 'c'.repeat(40) } : {}),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('next.config.ts: development reuses preview task HEAD and explicit host list', () => {
  const config = fixture('development');
  assert.equal(config.env.NEXT_PUBLIC_READER_COMMIT, 'a'.repeat(40));
  assert.ok(config.allowedDevOrigins.includes('fixture.tailnet.ts.net'));
  assert.equal(config.experimental.proxyClientMaxBodySize, '128mb');
});

test('next.config.ts: production ignores preview metadata and keeps release identity and origins', () => {
  const config = fixture('production');
  assert.equal(config.env.NEXT_PUBLIC_READER_COMMIT, 'b'.repeat(40));
  assert.ok(!config.allowedDevOrigins.includes('fixture.tailnet.ts.net'));
  assert.equal(config.allowedDevOrigins.length, 22);
  assert.equal(config.images.unoptimized, true);
  assert.equal(config.experimental.proxyClientMaxBodySize, '128mb');
});
