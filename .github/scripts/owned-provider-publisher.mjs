import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = 'a211e095e2fe49c477836acec2ad4a28aa60e030';
const tree = 'a13d594402df53e2c51d7a98ef896adeeb725ea6';
const build = '99c79f0c310d02157495f457f99b95370200c389';
const repository = 'devantler/provider-upjet-github';
const workflow = `${repository}/.github/workflows/publish-owned-provider.yml@refs/heads/main`;
const architectures = ['amd64', 'arm64'];

function requireThat(condition, reason) {
  if (!condition) throw new Error(`Refusing publication: ${reason}`);
}

export function context(env) {
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: '1278532211',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: workflow,
  })) requireThat(env[key] === value, `unexpected ${key}`);
  requireThat(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'invalid workflow commit');
  requireThat(env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA, 'workflow commit differs from dispatch');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    requireThat(/^[1-9][0-9]*$/.test(env[key] ?? ''), `invalid ${key}`);
  }
  return {
    image: `ghcr.io/${repository}`,
    tag: `v0.20.0-devantler.${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}`,
    workflowCommit: env.GITHUB_SHA,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}

export function verifySourceIdentity(actual) {
  for (const [key, value] of Object.entries({ commit: source, tree, build, dirty: '' })) {
    requireThat(actual[key] === value, `unexpected runtime ${key}`);
  }
}

export function receipt(ctx, architecture, sha256) {
  requireThat(architectures.includes(architecture), 'unsupported architecture');
  requireThat(/^[a-f0-9]{64}$/.test(sha256), 'invalid package checksum');
  return { source, tree, build, ...ctx, architecture, sha256 };
}

export function verifyReceipt(ctx, architecture, sha256, actual) {
  const expected = receipt(ctx, architecture, sha256);
  requireThat(actual !== null && typeof actual === 'object', 'missing receipt');
  requireThat(Object.keys(actual).length === Object.keys(expected).length, 'unexpected receipt fields');
  for (const [key, value] of Object.entries(expected)) {
    requireThat(actual[key] === value, `package receipt differs at ${key}`);
  }
}

function hashFile(path) {
  requireThat(lstatSync(path).isFile(), 'package must be a regular file');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const ctx = context(process.env);
  const [command, directory, architecture] = process.argv.slice(2);
  if (command === 'context') {
    for (const [key, value] of Object.entries(ctx)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  } else if (command === 'source') {
    const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', directory, ...args], { encoding: 'utf8' }).trim();
    verifySourceIdentity({
      commit: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      build: execFileSync('git', ['--no-replace-objects', '-C', join(directory, 'build'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: git('status', '--porcelain', '--untracked-files=all'),
    });
  } else if (command === 'receipt') {
    const value = receipt(ctx, architecture, hashFile(join(directory, 'provider.xpkg')));
    writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(value, null, 2)}\n`);
  } else if (command === 'verify') {
    const packages = architectures.map((arch) => {
      const folder = join(directory, `package-${arch}`);
      const value = JSON.parse(readFileSync(join(folder, 'receipt.json'), 'utf8'));
      verifyReceipt(ctx, arch, hashFile(join(folder, 'provider.xpkg')), value);
      return value;
    });
    writeFileSync('source-provenance.json', `${JSON.stringify({
      upstream: 'https://github.com/crossplane-contrib/provider-upjet-github',
      source, tree, build,
      workflow: `https://github.com/${workflow}`,
      ...ctx,
      packages,
    }, null, 2)}\n`);
  } else {
    throw new Error('Refusing publication: unknown command');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
