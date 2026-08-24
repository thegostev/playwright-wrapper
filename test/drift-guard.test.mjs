// Drift guard (FYR-302) — acceptance + edge cases.
// Run with `npm test` (`node --test`).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sha7,
  extractShaFromRunId,
  normalizeSha,
  verdict,
  refusalMessage,
  checkRunDrift,
} from '../src/drift-guard.mjs';

const CLI = fileURLToPath(new URL('../src/drift-guard.cli.mjs', import.meta.url));

const OTHER_SHA = 'a3f9c21'; // a plausible report SHA that is not HEAD

// A throwaway git checkout with one commit; returns its dir + HEAD sha.
function makeTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'drift-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'init'], {
    cwd: dir,
    stdio: 'pipe',
  });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, head };
}

function makeRunId(sha) {
  const [date, time] = new Date().toISOString().slice(0, 19).split('T'); // YYYY-MM-DD, HH:MM:SS
  return `${date}T${time.replace(/:/g, '')}Z-${sha}`;
}

const repos = [];
function tmpRepo() {
  const r = makeTmpRepo();
  repos.push(r);
  return r;
}

after(() => {
  for (const r of repos) rmSync(r.dir, { recursive: true, force: true });
});

describe('extractShaFromRunId — read without opening anything', () => {
  it('extracts the 7-hex sha from a valid run-id', () => {
    assert.equal(extractShaFromRunId('2026-08-24T113052Z-a3f9c21'), 'a3f9c21');
  });
  it('lowercases an uppercase sha', () => {
    assert.equal(extractShaFromRunId('2026-08-24T113052Z-A3F9C21'), 'a3f9c21');
  });
  it('rejects names without a sha', () => {
    assert.equal(extractShaFromRunId('2026-08-24T113052Z'), null);
    assert.equal(extractShaFromRunId('2026-08-24T113052Z-zzz'), null);
    assert.equal(extractShaFromRunId('garbage'), null);
    assert.equal(extractShaFromRunId(undefined), null);
  });
});

describe('sha7', () => {
  it('shortens a full sha to 7 hex chars', () => {
    assert.equal(sha7('0123456789abcdef0123456789abcdef01234567'), '0123456');
  });
  it('rejects non-40-hex input', () => {
    assert.throws(() => sha7('abc'));
  });
});

describe('normalizeSha', () => {
  it('accepts 7- and 40-hex forms', () => {
    assert.equal(normalizeSha('a3f9c21'), 'a3f9c21');
    assert.equal(normalizeSha('A3F9C21'), 'a3f9c21');
    assert.equal(normalizeSha('0123456789abcdef0123456789abcdef01234567'), '0123456');
  });
  it('rejects anything else', () => {
    assert.throws(() => normalizeSha('not-a-sha'));
    assert.throws(() => normalizeSha(''));
  });
});

describe('verdict (pure)', () => {
  const headSha = '0123456789abcdef0123456789abcdef01234567';

  it('proceeds when the run sha equals local HEAD', () => {
    assert.deepEqual(verdict({ runSha: '0123456', headSha }), { ok: true, note: 'match' });
  });
  it('refuses on mismatch with no override', () => {
    assert.deepEqual(verdict({ runSha: OTHER_SHA, headSha }), { ok: false, reason: 'drift' });
  });
  it('proceeds when --drift-ok names the report sha exactly', () => {
    assert.deepEqual(verdict({ runSha: OTHER_SHA, headSha, override: OTHER_SHA }), { ok: true, note: 'override' });
  });
  it('proceeds when --drift-ok carries the full sha of the same commit', () => {
    const full = `0123456789abcdef0123456789abcdef01234567`;
    assert.deepEqual(verdict({ runSha: '0123456', headSha: 'ffffffffffffffffffffffffffffffffffffffff', override: full }), {
      ok: true,
      note: 'override',
    });
  });
  it('refuses when the override names a different sha', () => {
    assert.deepEqual(verdict({ runSha: OTHER_SHA, headSha, override: 'bbbbbbb' }), { ok: false, reason: 'drift' });
  });
  it('flags a malformed override instead of treating it as no override', () => {
    assert.deepEqual(verdict({ runSha: OTHER_SHA, headSha, override: 'reflexively-appended' }), {
      ok: false,
      reason: 'invalid_override',
    });
  });
  it('ignores the override when there is no drift', () => {
    assert.deepEqual(verdict({ runSha: '0123456', headSha, override: 'garbage' }), { ok: true, note: 'match' });
  });
});

describe('refusal message', () => {
  it('states the mismatch', () => {
    const msg = refusalMessage('drift', { runSha: OTHER_SHA, headSha: '0123456789abcdef0123456789abcdef01234567' });
    assert.ok(msg.includes(OTHER_SHA), `should name the run sha: ${msg}`);
    assert.ok(msg.includes('0123456'), `should name local HEAD: ${msg}`);
  });
  it('never names the bypass flag in any refusal', () => {
    const reasons = [
      refusalMessage('drift', { runSha: OTHER_SHA, headSha: '0123456789abcdef0123456789abcdef01234567' }),
      refusalMessage('unreadable_sha'),
      refusalMessage('not_git'),
      refusalMessage('no_head'),
      refusalMessage('invalid_override', { override: 'x' }),
    ];
    for (const msg of reasons) assert.ok(!msg.includes('drift-ok'), `leaked flag in: ${msg}`);
  });
});

describe('checkRunDrift (integration, real checkout)', () => {
  it('acceptance: report sha == local HEAD proceeds', () => {
    const { dir, head } = tmpRepo();
    const run = makeRunId(sha7(head));
    assert.deepEqual(checkRunDrift({ run, cwd: dir }), { ok: true, note: 'match', runSha: sha7(head), headSha: head });
  });

  it('acceptance: report sha != local HEAD refuses, without naming the flag', () => {
    const { dir, head } = tmpRepo();
    const run = makeRunId(OTHER_SHA);
    const result = checkRunDrift({ run, cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'drift');
    assert.ok(result.message.includes(OTHER_SHA));
    assert.ok(result.message.includes(sha7(head)));
    assert.ok(!result.message.includes('drift-ok'), `refusal leaked the flag: ${result.message}`);
  });

  it('acceptance: --drift-ok=<that-sha> proceeds', () => {
    const { dir } = tmpRepo();
    const run = makeRunId(OTHER_SHA);
    const result = checkRunDrift({ run, cwd: dir, override: OTHER_SHA });
    assert.equal(result.ok, true);
    assert.equal(result.note, 'override');
  });

  it('acceptance: report sha changed between override construction and the check -> override fails', () => {
    const { dir } = tmpRepo();
    // The report sits at commit A; the override is constructed from A's sha.
    const runAtA = makeRunId(OTHER_SHA);
    assert.equal(checkRunDrift({ run: runAtA, cwd: dir, override: OTHER_SHA }).ok, true);
    // The report underneath changes to commit B before the check runs.
    const changedSha = 'bbbbbbb';
    const runAtB = makeRunId(changedSha);
    const result = checkRunDrift({ run: runAtB, cwd: dir, override: OTHER_SHA });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'drift');
  });

  it('refuses when the override names the wrong sha', () => {
    const { dir } = tmpRepo();
    const result = checkRunDrift({ run: makeRunId(OTHER_SHA), cwd: dir, override: 'bbbbbbb' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'drift');
  });

  it('refuses a malformed override', () => {
    const { dir } = tmpRepo();
    const result = checkRunDrift({ run: makeRunId(OTHER_SHA), cwd: dir, override: 'reflexive' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_override');
  });

  it('refuses when the run-id carries no sha', () => {
    const { dir } = tmpRepo();
    const result = checkRunDrift({ run: '2026-08-24T113052Z', cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreadable_sha');
    assert.ok(!result.message.includes('drift-ok'));
  });

  it('refuses outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-norepo-'));
    repos.push({ dir, head: null });
    const result = checkRunDrift({ run: makeRunId(OTHER_SHA), cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_git');
    assert.ok(!result.message.includes('drift-ok'));
  });

  it('refuses an empty repository with no HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-empty-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
    repos.push({ dir, head: null });
    const result = checkRunDrift({ run: makeRunId(OTHER_SHA), cwd: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_head');
    assert.ok(!result.message.includes('drift-ok'));
  });

  it('accepts a run folder path, reading the run-id from its basename', () => {
    const { dir, head } = tmpRepo();
    const run = makeRunId(sha7(head));
    const result = checkRunDrift({ run: join('/tmp/playwright-output/project', run), cwd: dir });
    assert.equal(result.ok, true);
  });
});

describe('cli', () => {
  it('refuses on mismatch and never reveals the flag', () => {
    const { dir } = tmpRepo();
    const run = makeRunId(OTHER_SHA);
    const r = spawnSync(process.execPath, [CLI, run], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('refusing to heal'));
    assert.ok(!r.stdout.includes('drift-ok'));
  });
  it('proceeds with the exact override', () => {
    const { dir } = tmpRepo();
    const run = makeRunId(OTHER_SHA);
    const r = spawnSync(process.execPath, [CLI, run, `--drift-ok=${OTHER_SHA}`], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0);
  });
  it('rejects a bare flag (it must be value-bearing)', () => {
    const { dir } = tmpRepo();
    const run = makeRunId(OTHER_SHA);
    const r = spawnSync(process.execPath, [CLI, run, '--drift-ok'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('value-bearing'));
  });
  it('prints usage when the run arg is missing', () => {
    const { dir } = tmpRepo();
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('usage'));
  });
});
