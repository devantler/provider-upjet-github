import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { context, verifySourceIdentity, receipt, verifyReceipt } from './owned-provider-publisher.mjs';

const env = {
  GITHUB_REPOSITORY: 'devantler/provider-upjet-github',
  GITHUB_REPOSITORY_ID: '1278532211',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
  GITHUB_WORKFLOW_REF: 'devantler/provider-upjet-github/.github/workflows/publish-owned-provider.yml@refs/heads/main',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};
const source = {
  commit: 'a211e095e2fe49c477836acec2ad4a28aa60e030',
  tree: 'a13d594402df53e2c51d7a98ef896adeeb725ea6',
  build: '99c79f0c310d02157495f457f99b95370200c389',
  dirty: '',
};

test('a reviewed main dispatch has one fixed owned destination', () => {
  assert.equal(context(env).image, 'ghcr.io/devantler/provider-upjet-github');
  assert.equal(context(env).tag, 'v0.20.0-devantler.123.1');
});

for (const [name, delta] of Object.entries({
  upstream: { GITHUB_REPOSITORY: 'crossplane-contrib/provider-upjet-github' },
  similarOwner: { GITHUB_REPOSITORY: 'devantler-tech/provider-upjet-github' },
  transferredRepository: { GITHUB_REPOSITORY_ID: '123' },
  pullRequest: { GITHUB_EVENT_NAME: 'pull_request' },
  branch: { GITHUB_REF: 'refs/heads/codex/test' },
  tag: { GITHUB_REF: 'refs/tags/v0.20.0' },
  differentWorkflow: { GITHUB_WORKFLOW_REF: 'devantler/provider-upjet-github/.github/workflows/other.yml@refs/heads/main' },
  differentWorkflowCommit: { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) },
  malformedCommit: { GITHUB_SHA: 'main', GITHUB_WORKFLOW_SHA: 'main' },
  tagInjection: { GITHUB_RUN_ID: '123; touch /tmp/unexpected' },
  zeroAttempt: { GITHUB_RUN_ATTEMPT: '0' },
  missingRepositoryID: { GITHUB_REPOSITORY_ID: undefined },
})) {
  test(`refuse ${name} before producing a destination`, () => {
    assert.throws(() => context({ ...env, ...delta }), /Refusing/);
  });
}

test('only the released runtime and build submodule are accepted', () => {
  assert.doesNotThrow(() => verifySourceIdentity(source));
  for (const key of ['commit', 'tree', 'build', 'dirty']) {
    assert.throws(() => verifySourceIdentity({ ...source, [key]: 'changed' }), /Refusing/);
    assert.throws(() => verifySourceIdentity({ ...source, [key]: undefined }), /Refusing/);
  }
});

test('package receipts bind both bytes and the exact workflow run', () => {
  const ctx = context(env);
  const bytes = Buffer.from('one synthetic package');
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const arch of ['amd64', 'arm64']) {
    const valid = receipt(ctx, arch, hash);
    assert.doesNotThrow(() => verifyReceipt(ctx, arch, hash, valid));
    for (const key of ['source', 'tree', 'build', 'workflowCommit', 'run', 'attempt', 'architecture', 'sha256']) {
      assert.throws(() => verifyReceipt(ctx, arch, hash, { ...valid, [key]: 'different' }), /Refusing/);
    }
    assert.throws(() => verifyReceipt(ctx, arch, 'f'.repeat(64), valid), /Refusing/);
  }
  assert.throws(() => receipt(ctx, '../arm64', hash), /Refusing/);
  assert.throws(() => receipt(ctx, 'amd64', 'invalid'), /Refusing/);
  assert.throws(() => verifyReceipt(ctx, 'amd64', hash, null), /Refusing/);
});

test('the real receipt handoff refuses changed bytes, missing architecture and symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'owned-provider-test-'));
  const script = fileURLToPath(new URL('./owned-provider-publisher.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: directory, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  try {
    for (const arch of ['amd64', 'arm64']) {
      const folder = join(directory, `package-${arch}`);
      mkdirSync(folder);
      writeFileSync(join(folder, 'provider.xpkg'), `package for ${arch}`);
      const result = run('receipt', folder, arch);
      assert.equal(result.status, 0, result.stderr);
    }
    let result = run('verify', directory);
    assert.equal(result.status, 0, result.stderr);
    const provenance = JSON.parse(readFileSync(join(directory, 'source-provenance.json')));
    assert.equal(provenance.source, source.commit);
    assert.equal(provenance.workflowCommit, env.GITHUB_SHA);
    assert.equal(provenance.packages.length, 2);

    const arm = join(directory, 'package-arm64', 'provider.xpkg');
    writeFileSync(arm, 'different bytes');
    result = run('verify', directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package receipt differs at sha256/);
    rmSync(arm);
    result = run('verify', directory);
    assert.equal(result.status, 1);
    symlinkSync(join(directory, 'package-amd64', 'provider.xpkg'), arm);
    result = run('verify', directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package must be a regular file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
