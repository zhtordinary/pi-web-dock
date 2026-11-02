import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('aggregate runner delivers every result when its reporter temporarily blocks', t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-runner-drain-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 for (const directory of ['app', 'components', 'hooks', 'lib', 'public', 'scripts', 'packages']) {
  fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, directory, 'fixture.test.mjs'), `import test from 'node:test';\nfor(let i=0;i<100;i++) test(${JSON.stringify(directory + ':' + 'x'.repeat(300))}+i,()=>{});\n`);
 }
 const reporter = path.join(root, 'reporter.mjs');
 fs.writeFileSync(reporter, `export default async function* (source) { let blocked=false; for await(const event of source) { if(!blocked){blocked=true;const until=Date.now()+1500;while(Date.now()<until){}} if(event.type==='test:summary')yield JSON.stringify(event.data)+'\\n'; } }`);
 const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
 const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-reader-tests.mjs', import.meta.url)), '--test-concurrency=1', '--test-reporter='+reporter], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
 assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
 const summaries = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
 assert.equal(summaries.at(-1).counts.tests, 700); assert.equal(summaries.at(-1).counts.passed, 700);
 // A result near the end must neither disappear nor turn a failed run green.
 fs.appendFileSync(path.join(root, 'public', 'fixture.test.mjs'), `test('last intentional failure',()=>{throw new Error('fixture failure');});\n`);
 const failed = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/run-reader-tests.mjs', import.meta.url)), '--test-concurrency=1', '--test-reporter='+reporter], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
 assert.equal(failed.error, undefined); assert.equal(failed.status, 1, failed.stderr);
 const failureSummary = failed.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1);
 assert.equal(failureSummary.counts.tests, 701); assert.equal(failureSummary.counts.failed, 1); assert.equal(failureSummary.counts.passed, 700);
});

test('explicit file selection never appends the full-suite patterns', t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-runner-selected-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 for (const directory of ['lib', 'app']) fs.mkdirSync(path.join(root, directory));
 fs.writeFileSync(path.join(root, 'lib', 'selected.test.mjs'), `import test from 'node:test'; test('selected-only',()=>{});\n`);
 fs.writeFileSync(path.join(root, 'app', 'unrelated.test.mjs'), `import test from 'node:test'; test('unrelated-must-not-run',()=>{throw Error('unrelated failure')});\n`);
 const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
 const runner = fileURLToPath(new URL('../scripts/run-reader-tests.mjs', import.meta.url));
 const result = spawnSync(process.execPath, [runner, '--test-concurrency=1', '--', 'lib/selected.test.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
 assert.equal(result.status, 0, result.stderr + result.stdout);
 assert.match(result.stdout, /selected-only/); assert.doesNotMatch(result.stdout, /unrelated-must-not-run/);
 const empty = spawnSync(process.execPath, [runner, '--'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
 assert.equal(empty.status, 2); assert.match(empty.stderr, /at least one test file/);
 const missing = spawnSync(process.execPath, [runner, '--', 'lib/missing.test.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
 assert.equal(missing.status, 2); assert.match(missing.stderr, /Explicit test file does not exist/); assert.doesNotMatch(missing.stdout, /unrelated-must-not-run/);
});

test('explicit parameter-route filenames stay literal rather than selecting a glob decoy or zero tests', t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-runner-literal-route-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const route = path.join('app', 'api', 'sessions', '[id]', 'cost', 'route.test.mjs');
 const decoy = path.join('app', 'api', 'sessions', 'i', 'cost', 'route.test.mjs');
 for (const file of [route, decoy]) fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
 fs.writeFileSync(path.join(root, route), `import test from 'node:test'; test('literal-parameter-route-executed',()=>{});\n`);
 fs.writeFileSync(path.join(root, decoy), `import test from 'node:test'; test('glob-decoy-must-not-run',()=>{throw Error('wrong route')});\n`);
 const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
 const runner = fileURLToPath(new URL('../scripts/run-reader-tests.mjs', import.meta.url));
 const result = spawnSync(process.execPath, [runner, '--test-concurrency=1', '--', route], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
 assert.equal(result.error, undefined);
 assert.equal(result.status, 0, result.stderr + result.stdout);
 assert.match(result.stdout, /literal-parameter-route-executed/);
 assert.doesNotMatch(result.stdout, /glob-decoy-must-not-run/);
 fs.rmSync(path.join(root, decoy));
 const noDecoy = spawnSync(process.execPath, [runner, '--test-concurrency=1', '--', route], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
 assert.equal(noDecoy.status, 0, noDecoy.stderr + noDecoy.stdout);
 assert.match(noDecoy.stdout, /literal-parameter-route-executed/);
});
