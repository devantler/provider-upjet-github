import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { assertContext, assertKubeconfig, assertNegative, assertHealthy, assertPolicy, runtimeEnvironment, assertBootstrap, finishResult, parseRenderedObjects, assertRenderedObjects } from './verify-owned-provider.mjs';
const inventory = JSON.parse(fs.readFileSync(new URL('./owned-provider-inventory.json', import.meta.url), 'utf8'));

const image = 'ghcr.io/devantler/provider-upjet-github@sha256:7bdc33e1d5b8283b2b0a3282341cd22df562ed0bbf8ef5169739a36644f66be8';
const old = 'ghcr.io/crossplane-contrib/provider-upjet-github@sha256:04d509bb9f6f57eacee141de81cc7fcab630693646c3f56cbc414f6c687aa85a';
const activeNames = [
  'repositories.repo.github.m.upbound.io', 'defaultbranches.repo.github.m.upbound.io',
  'branchprotections.repo.github.m.upbound.io', 'repositoryrulesets.repo.github.m.upbound.io',
  'issuelabels.repo.github.m.upbound.io', 'organizationrulesets.enterprise.github.m.upbound.io',
  'teams.team.github.m.upbound.io', 'teammemberships.team.github.m.upbound.io',
  'teamrepositories.team.github.m.upbound.io', 'repositorypermissions.actions.github.m.upbound.io',
];
const env = {
  GITHUB_REPOSITORY: 'devantler/provider-upjet-github', GITHUB_REPOSITORY_ID: '1278532211',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: '1234567890123456789012345678901234567890', GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64', RUNNER_TEMP: '/tmp/runner',
};
const own = (uid) => [{ uid, controller: true }];
const condition = (type, generation = 1) => ({ type, status: 'True', observedGeneration: generation });
function healthyFixture(ref = old) {
  const names = [...inventory.old];
  if (ref === image) names.push(...inventory.added);
  const definitions = names.map((name, i) => ({
    apiVersion: 'apiextensions.crossplane.io/v1alpha1', kind: inventory.configuration.includes(name) ? 'CustomResourceDefinition' : 'ManagedResourceDefinition',
    metadata: { name, uid: `definition-${i}`, ownerReferences: own('revision-uid') },
    spec: { state: activeNames.includes(name) ? 'Active' : 'Inactive' },
  }));
  const refs = definitions.map(({ apiVersion, kind, metadata }) => ({ apiVersion, kind, name: metadata.name, uid: metadata.uid }));
  return {
    provider: { metadata: { name: 'github-acceptance', uid: 'provider-uid', generation: 3 }, spec: { package: ref },
      status: { currentIdentifier: ref, currentRevision: 'actual-revision-name', conditions: [condition('Healthy', 3), condition('Installed', 3)], appliedImageConfigRefs: [{ name: 'owned-provider-acceptance', reason: 'VerifyImage' }] } },
    revisions: [{ metadata: { name: 'actual-revision-name', uid: 'revision-uid', generation: 1, ownerReferences: own('provider-uid') },
      spec: { image: ref, desiredState: 'Active' }, status: { conditions: [condition('RevisionHealthy'), condition('RuntimeHealthy'), condition('RuntimeActive')], objectRefs: refs } }],
    deployments: [{ metadata: { name: 'controller', uid: 'deployment-uid', generation: 2, ownerReferences: own('revision-uid') },
      spec: { replicas: 1, template: { spec: { containers: [{ name: 'package-runtime', image: ref }] } } },
      status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1, readyReplicas: 1 } }],
    replicaSets: [{ metadata: { uid: 'rs-uid', ownerReferences: own('deployment-uid') } }],
    pods: [{ metadata: { uid: 'pod-uid', ownerReferences: own('rs-uid') }, spec: { containers: [{ name: 'package-runtime', image: ref }] },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'package-runtime', ready: true, restartCount: 0, imageID: `docker-pullable://${ref}` }] } }],
    definitions, crds: [...activeNames.map((name, i) => ({ metadata: { name, uid: `crd-${i}`, ownerReferences: own(definitions.find(d => d.metadata.name === name).metadata.uid) }, status: { conditions: [condition('Established')] } })),
      ...definitions.filter(d => d.kind === 'CustomResourceDefinition').map(d => ({ ...structuredClone(d), status: { conditions: [condition('Established')] } }))],
    providerConfigs: [], activation: { spec: { activate: [...activeNames] } },
    fixture: { metadata: { name: 'preserved', uid: 'fixture-uid', annotations: { 'crossplane.io/external-name': 'synthetic-repository', 'crossplane.io/paused': 'true' } },
      spec: { forProvider: { branch: 'main' }, managementPolicies: ['Observe'], providerConfigRef: { name: 'absent', kind: 'ClusterProviderConfig' } },
      status: { conditions: [{ type: 'Synced', status: 'Unknown', reason: 'ReconcilePaused' }] } },
  };
}

test('accepts only a manual run in the owned fork on a hosted Linux runner', () => {
  assert.doesNotThrow(() => assertContext(env));
  for (const change of [
    { GITHUB_REPOSITORY: 'crossplane-contrib/provider-upjet-github' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/unreviewed' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'macOS' }, { RUNNER_ARCH: 'ARM64' },
    { GITHUB_RUN_ID: '../prod' }, { GITHUB_SHA: '' }, { RUNNER_TEMP: '/' },
  ]) assert.throws(() => assertContext({ ...env, ...change }), /acceptance context/);
});

test('cluster subprocesses receive no GitHub, cloud or inherited Docker credentials', () => {
  const isolated = runtimeEnvironment({ PATH: '/usr/bin', HOME: '/home/runner', GH_TOKEN: 'synthetic', GITHUB_TOKEN: 'synthetic',
    AWS_ACCESS_KEY_ID: 'synthetic', KUBECONFIG: '/prod', DOCKER_HOST: 'remote', HTTPS_PROXY: 'remote' }, '/tmp/owned');
  assert.deepEqual(Object.keys(isolated).sort(), ['DOCKER_CONFIG', 'HOME', 'KUBECONFIG', 'LANG', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']);
  assert.equal(isolated.KUBECONFIG, '/tmp/owned/kubeconfig');
  assert.equal(isolated.DOCKER_CONFIG, '/tmp/owned/docker');
  assert.equal(isolated.HOME, '/home/runner');
});

test('the actual run entrypoint refuses upstream execution before starting tools', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-owned-provider.mjs', import.meta.url)), 'run'],
    { env: { ...process.env, ...env, GITHUB_REPOSITORY: 'crossplane-contrib/provider-upjet-github' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'upstream invocation must fail before any cluster operation');
  assert.match(result.stderr, /acceptance context/);
});

test('requires the exact digest, strict identity and sole authority in the real policy', () => {
  const policy = { spec: { matchImages: [{ type: 'Prefix', prefix: image }], verification: { provider: 'Cosign', cosign: { authorities: [{ name: 'owned-publisher', keyless: { identities: [{ issuer: 'https://token.actions.githubusercontent.com', subject: 'https://github.com/devantler/provider-upjet-github/.github/workflows/publish-owned-provider.yml@refs/heads/main' }] } }] } } } };
  assert.doesNotThrow(() => assertPolicy(policy));
  for (const change of [
    p => { p.spec.matchImages[0].prefix = 'ghcr.io/devantler/'; },
    p => { p.spec.verification.cosign.authorities[0].keyless.identities[0].subjectRegExp = '.*'; },
    p => { p.spec.verification.cosign.authorities[0].keyless.insecureIgnoreSCT = true; },
    p => { p.spec.verification.cosign.authorities.push({ name: 'permissive' }); },
    p => { p.spec.verification.cosign.authorities[0].keyless.identities[0].issuer = 'other'; },
  ]) { const p = structuredClone(policy); change(p); assert.throws(() => assertPolicy(p), /signature policy/); }
});

test('refuses kubeconfig fallback, remote servers, exec credentials and TLS bypass', () => {
  const config = { 'current-context': 'kind-provider-acceptance-1234-1',
    contexts: [{ name: 'kind-provider-acceptance-1234-1', context: { cluster: 'local', user: 'local' } }],
    clusters: [{ name: 'local', cluster: { server: 'https://127.0.0.1:12345', 'certificate-authority-data': 'synthetic' } }],
    users: [{ name: 'local', user: { 'client-certificate-data': 'synthetic', 'client-key-data': 'synthetic' } }],
  };
  assert.doesNotThrow(() => assertKubeconfig(config, 'kind-provider-acceptance-1234-1'));
  for (const change of [
    c => { c.clusters[0].cluster.server = 'https://production.invalid:6443'; },
    c => { c.clusters[0].cluster['insecure-skip-tls-verify'] = true; },
    c => { c.users[0].user.exec = { command: 'credential-helper' }; },
    c => { c.clusters[0].cluster['proxy-url'] = 'https://remote.invalid'; },
    c => { c.users[0].user['client-key'] = '/borrowed/key'; },
    c => { c.contexts.push(structuredClone(c.contexts[0])); },
    c => { delete c.clusters[0].cluster['certificate-authority-data']; },
  ]) { const c = structuredClone(config); change(c); assert.throws(() => assertKubeconfig(c, 'kind-provider-acceptance-1234-1'), /kubeconfig/); }
});

test('requires real signature rejection and no installed revision or runtime', () => {
  const snapshot = { provider: { spec: { package: image }, status: { conditions: [
    { type: 'Healthy', status: 'False', message: 'cannot unpack package: authority "acceptance-reject-issuer": signature verification failed with no matching signatures: none of the expected identities matched what was in the certificate, got subjects [synthetic] with issuer synthetic' },
  ] } }, revisions: [], deployments: [], pods: [], definitions: [] };
  assert.doesNotThrow(() => assertNegative(snapshot, 'issuer'));
  assert.throws(() => assertNegative(snapshot, 'subject'), /signature rejection/);
  for (const change of [
    s => { s.provider.status.conditions[0].message = 'image pull timeout'; },
    s => { s.provider.status.conditions[0].status = 'True'; },
    s => { s.revisions.push({}); }, s => { s.deployments.push({}); },
    s => { s.pods.push({}); }, s => { s.definitions.push({}); },
  ]) { const s = structuredClone(snapshot); change(s); assert.throws(() => assertNegative(s, 'issuer'), /signature rejection/); }
});

test('accepts actual current healthy revision and preserved old/new/old identities', () => {
  const baseline = healthyFixture();
  assert.doesNotThrow(() => assertHealthy(baseline, old, 3));
  assert.doesNotThrow(() => assertHealthy(healthyFixture(image), image, 3, baseline));
  assert.doesNotThrow(() => assertHealthy(healthyFixture(), old, 3, baseline));
});

test('bootstrap requires both owned ready Deployments and every container identity', () => {
  const core = 'xpkg.crossplane.io/crossplane/crossplane@sha256:c5d773aa940041475e2cf6b9adf3512cb382b1a6b889f53ed791192ed8ada75b';
  const s = { deployments: [], replicaSets: [], pods: [], activations: [] };
  for (const name of ['crossplane', 'crossplane-rbac-manager']) {
    const spec = { containers: [{ name: 'runtime', image: core }], initContainers: [{ name: 'init', image: core }] };
    s.deployments.push({ metadata: { name, uid: name, generation: 1 }, spec: { replicas: 1, template: { spec } },
      status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } });
    s.replicaSets.push({ metadata: { uid: `${name}-rs`, ownerReferences: own(name) } });
    s.pods.push({ metadata: { ownerReferences: own(`${name}-rs`) }, spec: structuredClone(spec), status: { phase: 'Running', conditions: [condition('Ready')],
      containerStatuses: [{ name: 'runtime', ready: true, restartCount: 0, imageID: `docker-pullable://${core}` }],
      initContainerStatuses: [{ name: 'init', restartCount: 0, state: { terminated: { exitCode: 0 } }, imageID: `docker-pullable://${core}` }] } });
  }
  assert.doesNotThrow(() => assertBootstrap(s));
  for (const change of [
    x => { x.pods[0].status.containerStatuses = []; }, x => { x.pods[0].status.initContainerStatuses = []; },
    x => { x.pods[0].spec.containers[0].image = image; }, x => { x.deployments[0].spec.template.spec.containers[0].image = image; },
    x => { x.pods[0].metadata.ownerReferences = own('other'); }, x => { x.replicaSets[0].metadata.ownerReferences = own('other'); },
    x => { x.pods[0].status.containerStatuses[0].imageID = image; }, x => { x.pods[0].status.initContainerStatuses[0].state.terminated.exitCode = 1; },
    x => { x.deployments.pop(); }, x => { x.activations.push({}); },
  ]) { const value = structuredClone(s); change(value); assert.throws(() => assertBootstrap(value), /bootstrap proof/); }
});

test('terminal success is written only after cleanup and a failed recovery cannot hide the original error', () => {
  const outputs = []; let cleaned = false;
  const save = (name, value) => { if (name === 'result' && value.passed) assert.ok(cleaned); outputs.push({ name, value }); };
  finishResult(undefined, () => { cleaned = true; }, save, { source: 'synthetic' });
  assert.equal(outputs.at(-1)?.value.passed, true);
  outputs.length = 0; cleaned = false;
  assert.throws(() => finishResult(undefined, () => { throw Error('owned cleanup failed'); }, save, {}), /owned cleanup failed/);
  assert.equal(outputs.at(-1)?.value.passed, false);
  assert.throws(() => finishResult(Error('upgrade failed'), () => { cleaned = true; }, save, {}), /upgrade failed/);
  assert.equal(outputs.at(-1)?.value.passed, false);
});

const corruptions = [
  ['stale Provider health', s => { s.provider.status.conditions[0].observedGeneration = 2; }],
  ['wrong package', s => { s.provider.spec.package = old; }],
  ['missing signature selection', s => { s.provider.status.appliedImageConfigRefs = []; }],
  ['stale active revision', s => { s.revisions[0].spec.image = old; }],
  ['two active revisions', s => { s.revisions.push(structuredClone(s.revisions[0])); }],
  ['unhealthy revision', s => { s.revisions[0].status.conditions[0].status = 'False'; }],
  ['missing runtime health', s => { s.revisions[0].status.conditions = s.revisions[0].status.conditions.filter(c => c.type !== 'RuntimeHealthy'); }],
  ['stale runtime activation', s => { s.revisions[0].status.conditions.find(c => c.type === 'RuntimeActive').observedGeneration = 0; }],
  ['unready Deployment', s => { s.deployments[0].status.availableReplicas = 0; }],
  ['wrong runtime image', s => { s.pods[0].status.containerStatuses[0].imageID = `docker-pullable://${old}`; }],
  ['unexpected provider init container', s => { s.pods[0].spec.initContainers = [{ name: 'unreviewed', image }]; }],
  ['unowned runtime', s => { s.replicaSets[0].metadata.ownerReferences = own('other'); }],
  ['missing definition', s => { s.definitions.pop(); }],
  ['definition identity changed', s => { s.definitions[0].metadata.uid = 'replacement'; }],
  ['unexpected inventory name', s => { s.revisions[0].status.objectRefs[0].name = 'unreviewed'; }],
  ['wrong definition kind', s => { s.revisions[0].status.objectRefs[0].kind = 'ConfigMap'; }],
  ['missing active CRD', s => { s.crds.pop(); }],
  ['CRD recreated', s => { s.crds[0].metadata.uid = 'replacement'; }],
  ['unowned active CRD', s => { s.crds[0].metadata.ownerReferences = own('other'); }],
  ['new kind activated', s => { s.definitions.at(-1).spec.state = 'Active'; }],
  ['unselected older kind activated', s => { s.definitions.find(d => d.kind === 'ManagedResourceDefinition' && !activeNames.includes(d.metadata.name)).spec.state = 'Active'; }],
  ['unexpected active CRD', s => { s.crds.push({ metadata: { name: 'unselected.repo.github.m.upbound.io', uid: 'extra' } }); }],
  ['Provider recreated', s => { s.provider.metadata.uid = 'replacement'; }],
  ['fixture recreated', s => { s.fixture.metadata.uid = 'replacement'; }],
  ['fixture unpaused', s => { delete s.fixture.metadata.annotations['crossplane.io/paused']; }],
  ['fixture external identity changed', s => { s.fixture.metadata.annotations['crossplane.io/external-name'] = 'other'; }],
  ['fixture write policy added', s => { s.fixture.spec.managementPolicies.push('Update'); }],
  ['fixture credential kind changed', s => { s.fixture.spec.providerConfigRef.kind = 'ProviderConfig'; }],
  ['credential configuration added', s => { s.providerConfigs.push({}); }],
  ['wildcard activation added', s => { s.activation.spec.activate.push('*'); }],
];
for (const [name, change] of corruptions) test(`rejects false success: ${name}`, () => {
  const s = healthyFixture(image); change(s);
  assert.throws(() => assertHealthy(s, image, 3, healthyFixture()), /acceptance proof/);
});

// Captured from checksum-verified kubectl v1.36.4 (source bb826b1d48562f110659e64e8ec444327433db95).
// The two ServiceAccounts come from the pinned Crossplane 2.4.0 chart. A credential-free local
// discovery fixture answered only GET /api, /apis and /api/v1; no real cluster was contacted.
// Native stdout SHA256: 66c0e83a1f40929efe208844fb1709db6b893994f814663bab2406870e099c63.
test('parses every resource from actual kubectl 1.36.4 chart dry-run output', () => {
  const output = fs.readFileSync(new URL('./fixtures/crossplane-serviceaccounts.kubectl-1.36.4.jsonstream', import.meta.url), 'utf8');
  const expected = [JSON.parse(output.slice(0, 652)), JSON.parse(output.slice(652))];
  assert.deepEqual(parseRenderedObjects(output), expected);
  assert.deepEqual(expected.map(o => o.metadata.name), ['rbac-manager', 'crossplane']);
});

test('preserves quoted delimiters, escaped quotes, backslashes and nested JSON values', () => {
  const object = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nested' },
    data: { text: 'quoted } ] { [ ' + String.fromCharCode(34, 92, 34, 92, 92) },
    spec: { array: [null, true, false, 1.25e3, { child: ['}', '[', {}] }] } };
  const next = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'next' } };
  const output = ' ' + JSON.stringify(object, null, 4) + String.fromCharCode(13, 10, 9) + JSON.stringify(next);
  assert.deepEqual(parseRenderedObjects(output), [object, next]);
});

for (const bad of ['', '  ', '[]', 'null', 'true', '1', '"object"', '{}', '{"kind":"Pod"}', '{"apiVersion":"v1"}',
  '{"apiVersion":"v1","kind":"Pod"', '{"apiVersion":"v1","kind":"Pod","spec":[}',
  '{"apiVersion":"v1","kind":"Pod","spec":tru}', '{"apiVersion":"v1","kind":"Pod","data":{"x":"unterminated}}']) {
  test('rejects incomplete, malformed or non-resource JSON: ' + bad.slice(0, 60), () => {
    assert.throws(() => parseRenderedObjects(bad), /rendered JSON/);
  });
}

test('rejects trailing garbage, malformed later documents and unexpected top-level values without partial success', () => {
  const valid = JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'valid' } });
  for (const suffix of ['garbage', '[]', 'null', '{', '{"apiVersion":"v1","kind":"Pod"', '{}']) {
    assert.throws(() => parseRenderedObjects(valid + String.fromCharCode(10) + suffix), /rendered JSON/);
  }
});

test('rejects list wrappers and bounds document count and total input size', () => {
  for (const kind of ['List', 'PodList']) {
    assert.throws(() => parseRenderedObjects(JSON.stringify({ apiVersion: 'v1', kind, items: [] })), /rendered JSON/);
  }
  const valid = JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'valid' } });
  assert.throws(() => parseRenderedObjects((valid + '\n').repeat(4097)), /rendered JSON/);
  assert.throws(() => parseRenderedObjects(' '.repeat(32 * 1024 * 1024 + 1)), /rendered JSON/);
});

test('the unchanged render guards inspect later stream resources, including init container images', () => {
  const output = fs.readFileSync(new URL('./fixtures/crossplane-serviceaccounts.kubectl-1.36.4.jsonstream', import.meta.url), 'utf8');
  const image = 'xpkg.crossplane.io/crossplane/crossplane@sha256:c5d773aa940041475e2cf6b9adf3512cb382b1a6b889f53ed791192ed8ada75b';
  const runtime = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'crossplane' }, spec: { template: { spec: {
    containers: [{ image }], initContainers: [{ image }],
  } } } };
  const rendered = output + JSON.stringify(runtime);
  assert.doesNotThrow(() => assertRenderedObjects(parseRenderedObjects(rendered)));
  assert.throws(() => assertRenderedObjects(parseRenderedObjects(output)), /unpinned Crossplane render/);
  for (const kind of ['Provider', 'Function', 'Configuration', 'ManagedResourceActivationPolicy']) {
    const extra = JSON.stringify({ apiVersion: 'pkg.crossplane.io/v1', kind, metadata: { name: 'unexpected' } });
    assert.throws(() => assertRenderedObjects(parseRenderedObjects(rendered + '\n' + extra)), /unexpected bootstrap package or activation/);
  }
  for (const key of ['containers', 'initContainers']) {
    const bad = structuredClone(runtime); bad.spec.template.spec[key][0].image = 'untrusted.example/runtime:latest';
    assert.throws(() => assertRenderedObjects(parseRenderedObjects(rendered + '\n' + JSON.stringify(bad))), /unpinned Crossplane render/);
  }
});

import * as harness from "./verify-owned-provider.mjs";

const fixture = () => JSON.parse(fs.readFileSync(new URL('./fixtures/crossplane-bootstrap-restart.json', import.meta.url)));
function transport(snapshot = fixture()) {
  const calls = []; const saved = [];
  const io = {
    read(kind, name, options) {
      calls.push({ kind, name, options });
      const key = { Deployment: 'deployments', ReplicaSet: 'replicaSets', Pod: 'pods' }[kind];
      const value = snapshot[key].find(o => o.metadata.name === name);
      assert.ok(value, 'unexpected read target');
      return structuredClone(value);
    },
    logs(pod, container, previous, options) {
      calls.push({ log: true, pod, container, previous, options });
      return previous ? '2026-09-08T15:56:24Z startup failed: diagnostic fixture\n' : '2026-09-08T15:56:25Z controller ready\n';
    },
    events(pod, options) {
      calls.push({ event: true, pod, options });
      return [{ involvedObject: { kind: 'Pod', namespace: 'crossplane-system', name: pod.name, uid: pod.uid },
        type: 'Warning', reason: 'BackOff', message: 'Synthetic event for the exact owned Pod.' }];
    },
    save(name, value) { saved.push({ name, value }); },
  };
  return { io, calls, saved };
}

test('actual restart fixture remains rejected and captures its bounded evidence before cleanup', () => {
  const snapshot = fixture(); const t = transport(snapshot); const order = [];
  assert.throws(() => harness.assertBootstrap(snapshot), /bootstrap proof/);
  const primary = new Error('original bootstrap refusal');
  assert.throws(() => harness.finishResult(primary, () => order.push('cleanup'), (name, value) => {
    t.io.save(name, value); if (name === 'bootstrap-diagnostics') order.push('diagnostics');
  }, {}, () => harness.collectBootstrapDiagnostics(snapshot, {
    ...t.io, save(name, value) { t.io.save(name, value); order.push('diagnostics'); },
  })), error => error === primary);
  assert.deepEqual(order, ['diagnostics', 'cleanup']);
  const proof = t.saved.find(v => v.name === 'bootstrap-diagnostics').value;
  assert.equal(proof.pods.length, 2);
  assert.equal(proof.pods.flatMap(p => p.logs).length, 8);
  assert.ok(proof.pods[0].logs.some(l => l.previous && l.text.includes('startup failed')));
  assert.equal(t.saved.find(v => v.name === 'result').value.passed, false);
  assert.ok(t.calls.every(c => c.options.timeout > 0 && c.options.timeout <= 3000 && c.options.maxBuffer <= 262144));
});

test('diagnostic and diagnostic-save failures cannot hide the primary failure or prevent cleanup', () => {
  const primary = new Error('original failure'); const order = [];
  assert.throws(() => harness.finishResult(primary, () => order.push('cleanup'), (name, value) => {
    if (name === 'diagnostic-failure') throw new Error('private filesystem detail');
    order.push(name); assert.equal(value.failure, primary.message);
  }, {}, () => { order.push('diagnose'); throw new Error('credential-like private error'); }), error => error === primary);
  assert.deepEqual(order, ['diagnose', 'cleanup', 'result']);
});

test('successful runs do not collect diagnostic logs', () => {
  let diagnostic = false;
  harness.finishResult(undefined, () => {}, () => {}, {}, () => { diagnostic = true; });
  assert.equal(diagnostic, false);
});

for (const [name, mutate] of [
  ['foreign namespace', s => { s.pods[0].metadata.namespace = 'other'; }],
  ['wrong Pod owner', s => { s.pods[0].metadata.ownerReferences[0].uid = 'foreign'; }],
  ['wrong ReplicaSet owner', s => { s.replicaSets[0].metadata.ownerReferences[0].uid = 'foreign'; }],
  ['different Deployment image', s => { s.deployments[0].spec.template.spec.containers[0].image = 'unreviewed'; }],
  ['different runtime image', s => { s.pods[0].status.containerStatuses[0].imageID = 'unreviewed'; }],
  ['unapproved container name', s => { s.pods[0].spec.containers[0].name = 'other'; }],
]) test(`refuses ${name} before any logs or events`, () => {
  const snapshot = fixture(); mutate(snapshot); const t = transport(snapshot);
  assert.throws(() => harness.collectBootstrapDiagnostics(snapshot, t.io), /diagnostic scope/);
  assert.equal(t.calls.filter(c => c.log || c.event).length, 0);
});

test('refuses a replaced live Pod before reading logs', () => {
  const snapshot = fixture(); const t = transport(snapshot); const read = t.io.read;
  t.io.read = (kind, ...args) => { const o = read(kind, ...args); if (kind === 'Pod') o.metadata.uid = 'replaced'; return o; };
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  assert.equal(t.calls.filter(c => c.log || c.event).length, 0);
  assert.ok(t.saved[0].value.pods.every(p => p.error === 'diagnostic capture unavailable'));
});

test('discards log output if the Pod identity changes during the request', () => {
  const snapshot = fixture(); const t = transport(snapshot); const read = t.io.read; const logs = t.io.logs; let changed = false;
  t.io.logs = (...args) => { changed = true; return logs(...args); };
  t.io.read = (kind, ...args) => { const o = read(kind, ...args); if (kind === 'Pod' && changed) o.metadata.uid = 'replaced'; return o; };
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  assert.ok(t.calls.some(c => c.log));
  assert.ok(!JSON.stringify(t.saved).includes('controller ready'));
});

test('rejects another Pods event instead of accepting an imprecise event query', () => {
  const snapshot = fixture(); const t = transport(snapshot);
  t.io.events = () => [{ involvedObject: { kind: 'Pod', namespace: 'crossplane-system', name: 'other', uid: 'other' }, message: 'must not be saved' }];
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  assert.ok(!JSON.stringify(t.saved).includes('must not be saved'));
});

test('log size and line limits fail closed without saving exception details', () => {
  for (const text of ['x'.repeat(16385), Array(102).fill('line').join('\n')]) {
    const snapshot = fixture(); const t = transport(snapshot); t.io.logs = () => text;
    harness.collectBootstrapDiagnostics(snapshot, t.io);
    assert.ok(!JSON.stringify(t.saved).includes(text));
    assert.ok(t.saved[0].value.pods.every(p => p.logs.every(l => l.error === 'diagnostic capture unavailable')));
  }
});

test('transport failures save only a fixed diagnostic error', () => {
  const snapshot = fixture(); const t = transport(snapshot); t.io.logs = () => { throw new Error('secret-like external error'); };
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  assert.ok(!JSON.stringify(t.saved).includes('secret-like'));
  assert.ok(t.saved[0].value.pods.every(p => p.logs.every(l => l.error === 'diagnostic capture unavailable')));
});

test('an exhausted diagnostic time budget issues no further requests and still permits cleanup', t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const snapshot = fixture(); const transportState = transport(snapshot); const read = transportState.io.read;
  transportState.io.read = (...args) => { now += 3000; return read(...args); };
  let cleaned = false; const primary = new Error('original failure');
  assert.throws(() => harness.finishResult(primary, () => { cleaned = true; }, () => {}, {},
    () => harness.collectBootstrapDiagnostics(snapshot, transportState.io)), e => e === primary);
  assert.equal(cleaned, true);
  assert.ok(transportState.calls.filter(c => c.kind).length <= 15);
  assert.ok(transportState.saved[0].value.pods.some(p => p.error || p.logs.some(l => l.error)));
});

test('missing previous logs retain current logs and do not hide the original failure', () => {
  const snapshot = fixture(); const t = transport(snapshot); const logs = t.io.logs;
  t.io.logs = (pod, container, previous, options) => {
    if (previous) throw new Error('previous terminated container not found');
    return logs(pod, container, previous, options);
  };
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  for (const p of t.saved[0].value.pods) {
    assert.equal(p.logs.filter(l => l.text).length, 2);
    assert.equal(p.logs.filter(l => l.previous && l.error === 'diagnostic capture unavailable').length, 2);
  }
});

test('prioritizes the observed restarted core main-container previous log', () => {
  const snapshot = fixture(); const t = transport(snapshot);
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  const first = t.calls.find(c => c.log);
  assert.equal(first.pod.name, 'crossplane-649774f96c-7cjvd');
  assert.equal(first.container, 'crossplane');
  assert.equal(first.previous, true);
});

test('refuses a live read returning a different Pod name even with the saved UID', () => {
  const snapshot = fixture(); const t = transport(snapshot); const read = t.io.read;
  t.io.read = (kind, ...args) => { const value = read(kind, ...args); if (kind === 'Pod') value.metadata.name += '-other'; return value; };
  harness.collectBootstrapDiagnostics(snapshot, t.io);
  assert.equal(t.calls.filter(c => c.log || c.event).length, 0);
});
