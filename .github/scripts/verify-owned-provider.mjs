import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const NEW = 'ghcr.io/devantler/provider-upjet-github@sha256:7bdc33e1d5b8283b2b0a3282341cd22df562ed0bbf8ef5169739a36644f66be8';
export const OLD = 'ghcr.io/crossplane-contrib/provider-upjet-github@sha256:04d509bb9f6f57eacee141de81cc7fcab630693646c3f56cbc414f6c687aa85a';
const CHILD = {
  [OLD]: 'sha256:cfb11ce092196fededec445b1f9aae3bee4faf0389327c9ef2e48004ece59e86',
  [NEW]: 'sha256:41ef53305efc5de9a90e21f1f83c01cc990cdbce95bb61ed88a2a4f76ca2ac94',
};
export const ACTIVE = [
  'repositories.repo.github.m.upbound.io', 'defaultbranches.repo.github.m.upbound.io',
  'branchprotections.repo.github.m.upbound.io', 'repositoryrulesets.repo.github.m.upbound.io',
  'issuelabels.repo.github.m.upbound.io', 'organizationrulesets.enterprise.github.m.upbound.io',
  'teams.team.github.m.upbound.io', 'teammemberships.team.github.m.upbound.io',
  'teamrepositories.team.github.m.upbound.io', 'repositorypermissions.actions.github.m.upbound.io',
];
const INVENTORY = JSON.parse(fs.readFileSync(new URL('./owned-provider-inventory.json', import.meta.url), 'utf8'));
const EXTRA = INVENTORY.added;
const CORE = 'xpkg.crossplane.io/crossplane/crossplane@sha256:c5d773aa940041475e2cf6b9adf3512cb382b1a6b889f53ed791192ed8ada75b';
const NODE = 'kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed';
const ISSUER = 'https://token.actions.githubusercontent.com';
const SUBJECT = 'https://github.com/devantler/provider-upjet-github/.github/workflows/publish-owned-provider.yml@refs/heads/main';
export const positivePolicy = () => ({ apiVersion: 'pkg.crossplane.io/v1beta1', kind: 'ImageConfig', metadata: { name: 'owned-provider-acceptance' },
  spec: { matchImages: [{ type: 'Prefix', prefix: NEW }], verification: { provider: 'Cosign', cosign: {
    authorities: [{ name: 'owned-publisher', keyless: { identities: [{ issuer: ISSUER, subject: SUBJECT }] } }],
  } } } });
const owner = (object, uid) => object.metadata?.ownerReferences?.some(r => r.uid === uid && r.controller === true);
const conditions = object => object.status?.conditions ?? [];
const currentTrue = (object, type) => conditions(object).some(c => c.type === type && c.status === 'True' && c.observedGeneration === object.metadata.generation);
const proof = (ok, message) => assert.ok(ok, `acceptance proof: ${message}`);
export function parseRenderedObjects(output) {
  const fail = ok => assert.ok(ok, 'invalid rendered JSON resource stream');
  fail(typeof output === 'string' && output.length <= 32 * 1024 * 1024);
  const whitespace = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  const objects = [];
  let offset = 0;
  // kubectl create prints one JSON document per resource, not a single List.
  // Locate complete documents without splitting on braces inside JSON strings.
  while (offset < output.length) {
    while (whitespace(output[offset])) offset++;
    if (offset === output.length) break;
    fail(output[offset] === '{' && objects.length < 4096);
    const start = offset;
    let depth = 0; let quoted = false; let escaped = false;
    for (; offset < output.length; offset++) {
      const c = output[offset];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (--depth === 0) { offset++; break; }
      }
    }
    fail(depth === 0 && !quoted);
    let object;
    try { object = JSON.parse(output.slice(start, offset)); }
    catch { throw new Error('invalid rendered JSON resource document'); } // Never quote private chart input.
    fail(typeof object.apiVersion === 'string' && object.apiVersion.trim()
      && typeof object.kind === 'string' && object.kind.trim() && object.kind !== 'List'
      && !Object.hasOwn(object, 'items'));
    objects.push(object);
  }
  fail(objects.length > 0);
  return objects;
}

export function assertRenderedObjects(objects) {
  proof(!objects.some(o => ['Provider', 'Function', 'Configuration', 'ManagedResourceActivationPolicy'].includes(o.kind)), 'unexpected bootstrap package or activation');
  const images = objects.flatMap(o => [...(o.spec?.template?.spec?.containers ?? []), ...(o.spec?.template?.spec?.initContainers ?? [])].map(c => c.image));
  proof(images.length >= 2 && images.every(image => image === CORE), 'unpinned Crossplane render');
  const managers = objects.filter(o => o.kind === 'Deployment' && o.metadata?.name === 'crossplane');
  const manager = managers[0]?.spec?.template?.spec;
  proof(managers.length === 1
    && manager.containers?.length === 1
    && JSON.stringify(manager.containers[0].args) === '["core","start","--enable-signature-verification"]'
    && manager.initContainers?.length === 1
    && JSON.stringify(manager.initContainers[0].args) === '["core","init"]', 'signature verification disabled');
}

export function assertBootstrap(s) {
  const check = (ok) => assert.ok(ok, 'bootstrap proof requires both owned ready runtimes and all pinned container identities');
  const identity = object => {
    check(object.metadata.name && object.metadata.uid && !object.metadata.deletionTimestamp && object.metadata.namespace === 'crossplane-system'
      && Number.isSafeInteger(object.metadata.generation) && object.metadata.generation > 0);
    return { name: object.metadata.name, uid: object.metadata.uid, generation: object.metadata.generation };
  };
  const timestamp = value => {
    check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
    return Date.parse(value);
  };
  const identities = [];
  check(s.deployments.length === 2 && s.activations.length === 0 && s.pods.length === 2);
  check(JSON.stringify(s.deployments.map(d => d.metadata.name).sort()) === '["crossplane","crossplane-rbac-manager"]');
  for (const d of s.deployments) {
    check(d.metadata.uid && d.spec.replicas === 1 && d.status.observedGeneration === d.metadata.generation
      && ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'].every(k => d.status[k] === 1));
    const sets = s.replicaSets.filter(rs => owner(rs, d.metadata.uid));
    const pods = s.pods.filter(p => !p.metadata.deletionTimestamp && sets.some(rs => owner(p, rs.metadata.uid)));
    check(pods.length === 1);
    const pod = pods[0];
    check(pod.status.phase === 'Running' && ['Ready', 'Initialized'].every(type => conditions(pod).some(c => c.type === type && c.status === 'True')));
    const item = { deployment: identity(d), replicaSets: sets.map(identity).sort((a, b) => a.name.localeCompare(b.name)), pod: identity(pod), containers: [] };
    for (const [specKey, statusKey] of [['containers', 'containerStatuses'], ['initContainers', 'initContainerStatuses']]) {
      const declared = d.spec.template.spec[specKey] ?? []; const actual = pod.spec[specKey] ?? []; const states = pod.status[statusKey] ?? [];
      check(declared.length === 1 && actual.length === 1 && states.length === 1);
      check(declared[0].image === CORE && actual[0].image === CORE && declared[0].name === actual[0].name && states[0].name === actual[0].name);
      if (d.metadata.name === 'crossplane') {
        const expectedArgs = specKey === 'containers' ? ['core', 'start', '--enable-signature-verification'] : ['core', 'init'];
        check(JSON.stringify(declared[0].args) === JSON.stringify(expectedArgs) && JSON.stringify(actual[0].args) === JSON.stringify(expectedArgs));
      }
      const state = states[0];
      check(Number.isSafeInteger(state.restartCount) && state.restartCount >= 0
        && typeof state.containerID === 'string' && /^[a-z0-9-]+:\/\/[^\s]+$/.test(state.containerID));
      if (specKey === 'containers') {
        check(state.ready === true && Object.keys(state.state ?? {}).join() === 'running');
        timestamp(state.state.running.startedAt);
      } else {
        check(declared[0].restartPolicy !== 'Always' && actual[0].restartPolicy !== 'Always'
          && Object.keys(state.state ?? {}).join() === 'terminated' && state.state.terminated.exitCode === 0);
        const terminated = state.state.terminated;
        check(terminated.containerID === state.containerID && timestamp(terminated.startedAt) <= timestamp(terminated.finishedAt)
          && timestamp(terminated.finishedAt) <= timestamp(pod.status.containerStatuses[0].state.running.startedAt));
      }
      check([CORE.split('@')[1], 'sha256:520767ddca99c7c7a3a33039d15cbd867ca6658097cee5c01394ca33c299d1b3'].some(digest => states[0].imageID === digest || states[0].imageID?.endsWith(`@${digest}`)));
      item.containers.push({ name: state.name, containerID: state.containerID, imageID: state.imageID, restartCount: state.restartCount, state: state.state });
    }
    identities.push(item);
  }
  return identities.sort((a, b) => a.deployment.name.localeCompare(b.deployment.name));
}

export async function waitForBootstrap(observe, save, { now = () => performance.now(), sleep = delay } = {}) {
  let previousTime = -Infinity;
  const clock = () => {
    const value = now();
    proof(Number.isFinite(value) && value >= previousTime, 'bootstrap monotonic clock');
    previousTime = value;
    return value;
  };
  const started = clock();
  let baseline; let firstAt; let lastAt; let lastSnapshot; let lastFailure;
  const samples = [];
  try {
    // The same six-minute overall budget includes readiness and the stable minute.
    // The attempt cap also refuses a stuck injected clock; no baseline is reset.
    for (let attempt = 0; attempt < 73; attempt++) {
      proof(clock() - started <= 360_000, 'bootstrap overall deadline');
      let value; let identities; let error;
      try { value = observe(); lastSnapshot = value; identities = assertBootstrap(value); }
      catch (caught) { error = caught; }
      const at = clock();
      proof(at - started <= 360_000, 'bootstrap overall deadline');
      if (baseline) {
        if (error) throw error;
        proof(at - lastAt <= 15_000, 'bootstrap observation gap');
        assert.deepEqual(identities, baseline, 'bootstrap runtime changed after the stability baseline');
      } else if (!error) {
        baseline = structuredClone(identities); firstAt = at;
        save('crossplane-first-observation', value);
      } else lastFailure = error;
      if (baseline) {
        lastAt = at;
        samples.push({ elapsedMilliseconds: at - firstAt, identities });
        save('crossplane-stability', { elapsedMilliseconds: at - firstAt, samples });
        if (at - firstAt >= 60_000 && samples.length >= 5) {
          save('crossplane', value);
          return value;
        }
      }
      proof(clock() - started <= 355_000, 'bootstrap overall deadline');
      await sleep(5000);
    }
    throw new Error(`bootstrap overall deadline: ${lastFailure?.message ?? 'stable observation window incomplete'}`);
  } catch (error) {
    try { if (lastSnapshot) save('crossplane-last-observation', lastSnapshot); }
    catch { /* Diagnostic persistence must not replace the primary failure. */ }
    throw error;
  }
}

export function collectBootstrapDiagnostics(snapshot, io) {
  const scope = ok => assert.ok(ok, 'diagnostic scope requires exact owned Crossplane runtimes');
  const namespace = 'crossplane-system';
  const deadline = Date.now() + 45_000;
  const options = (maxBuffer = 262144) => {
    const remaining = deadline - Date.now();
    scope(remaining > 0);
    return { timeout: Math.min(3000, remaining), maxBuffer };
  };
  const identity = object => {
    scope(object?.metadata?.namespace === namespace && typeof object.metadata.uid === 'string' && object.metadata.uid.length > 0
      && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(object.metadata.name));
  };
  const validate = (d, rs, pod) => {
    for (const o of [d, rs, pod]) identity(o);
    scope(owner(rs, d.metadata.uid) && owner(pod, rs.metadata.uid));
    scope(rs.metadata.name.startsWith(`${d.metadata.name}-`) && pod.metadata.name.startsWith(`${rs.metadata.name}-`));
    for (const [key, statusKey, name] of [['containers', 'containerStatuses', 'crossplane'], ['initContainers', 'initContainerStatuses', 'crossplane-init']]) {
      const declared = d.spec?.template?.spec?.[key]; const actual = pod.spec?.[key]; const states = pod.status?.[statusKey];
      scope(declared?.length === 1 && actual?.length === 1 && states?.length === 1);
      scope(declared[0].name === name && actual[0].name === name && states[0].name === name
        && declared[0].image === CORE && actual[0].image === CORE);
      scope([CORE.split('@')[1], 'sha256:520767ddca99c7c7a3a33039d15cbd867ca6658097cee5c01394ca33c299d1b3']
        .some(digest => states[0].imageID === digest || states[0].imageID?.endsWith(`@${digest}`)));
    }
  };
  // Validate both targets before any log/event read. Readiness and restarts are
  // deliberately not prerequisites for diagnostics; their acceptance guards remain unchanged.
  const targets = ['crossplane', 'crossplane-rbac-manager'].map(name => {
    const ds = snapshot?.deployments?.filter(d => d.metadata.name === name); scope(ds?.length === 1);
    const d = ds[0]; const sets = snapshot.replicaSets.filter(r => owner(r, d.metadata.uid));
    const pods = snapshot.pods.filter(p => sets.some(r => owner(p, r.metadata.uid)));
    scope(pods.length === 1);
    const pod = pods[0]; const rs = sets.find(r => owner(pod, r.metadata.uid));
    validate(d, rs, pod);
    return { d, rs, pod };
  });
  const results = [];
  for (const target of targets) {
    const result = { name: target.pod.metadata.name, uid: target.pod.metadata.uid, namespace, logs: [] };
    const refresh = () => {
      const objects = ['Deployment', 'ReplicaSet', 'Pod'].map((kind, i) => {
        const expected = [target.d, target.rs, target.pod][i];
        const actual = io.read(kind, expected.metadata.name, options());
        scope(actual.metadata.name === expected.metadata.name && actual.metadata.uid === expected.metadata.uid
          && actual.metadata.generation === expected.metadata.generation);
        return actual;
      });
      validate(...objects); return objects[2];
    };
    try {
      refresh();
      for (const container of ['crossplane', 'crossplane-init']) for (const previous of (
        container === 'crossplane' && target.pod.status.containerStatuses[0].restartCount > 0 ? [true, false] : [false, true])) {
        const log = { container, previous };
        try {
          const before = refresh();
          const text = io.logs(result, container, previous, options(32768));
          const after = refresh();
          const states = p => [...p.status.containerStatuses, ...p.status.initContainerStatuses].find(c => c.name === container);
          scope(states(before).containerID === states(after).containerID && states(before).restartCount === states(after).restartCount);
          scope(typeof text === 'string' && Buffer.byteLength(text) <= 16384 && text.replace(/\n$/, '').split('\n').length <= 100);
          log.text = text;
        } catch { log.error = 'diagnostic capture unavailable'; }
        result.logs.push(log);
      }
      try {
        refresh();
        const events = io.events(result, options(65536));
        refresh();
        scope(Array.isArray(events) && events.length <= 50);
        result.events = events.map(e => {
          const ref = e.involvedObject;
          scope(ref?.kind === 'Pod' && ref.namespace === namespace && ref.uid === result.uid && ref.name === result.name);
          return { type: e.type, reason: e.reason, message: String(e.message ?? '').slice(0, 2048), count: e.count,
            firstTimestamp: e.firstTimestamp, lastTimestamp: e.lastTimestamp };
        });
      } catch { result.eventError = 'diagnostic capture unavailable'; }
    } catch { result.error = 'diagnostic capture unavailable'; }
    results.push(result);
  }
  io.save('bootstrap-diagnostics', { namespace, pods: results });
}

export function finishResult(primaryError, cleanup, save, details, diagnose = () => {}) {
  let error = primaryError;
  if (error) {
    try { diagnose(); }
    catch { try { save('diagnostic-failure', { message: 'diagnostic capture unavailable' }); } catch { /* Preserve primary error and cleanup. */ } }
  }
  try { cleanup(); } catch (cleanupError) { save('cleanup-failure', { message: cleanupError.message }); error ??= cleanupError; }
  save('result', { ...details, passed: !error, ...(error ? { failure: error.message } : {}) });
  if (error) throw error;
}
export function assertPolicy(policy) { assert.deepEqual(policy.spec, positivePolicy().spec, 'signature policy must select the exact digest and sole strict identity'); }

export function assertContext(env) {
  const fixed = { GITHUB_REPOSITORY: 'devantler/provider-upjet-github', GITHUB_REPOSITORY_ID: '1278532211',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  for (const [key, value] of Object.entries(fixed)) assert.equal(env[key], value, `acceptance context: ${key}`);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/, `acceptance context: ${key}`);
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'acceptance context: source SHA');
  assert.ok(path.isAbsolute(env.RUNNER_TEMP ?? '') && path.resolve(env.RUNNER_TEMP) !== '/', 'acceptance context: private temporary directory');
  return { root: path.join(env.RUNNER_TEMP, 'provider-acceptance'), cluster: `provider-acceptance-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` };
}

export function assertKubeconfig(config, context) {
  const fail = (ok) => assert.ok(ok, 'kubeconfig must contain only the owned local TLS context and static local credentials');
  fail(config['current-context'] === context && config.contexts?.length === 1 && config.clusters?.length === 1 && config.users?.length === 1);
  const selected = config.contexts[0];
  const cluster = config.clusters[0]; const user = config.users[0];
  fail(selected.name === context && selected.context.cluster === cluster.name && selected.context.user === user.name);
  fail(/^https:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(cluster.cluster.server));
  fail(Boolean(cluster.cluster['certificate-authority-data']) && !cluster.cluster['insecure-skip-tls-verify'] && !cluster.cluster['tls-server-name']);
  fail(Boolean(user.user['client-certificate-data']) && Boolean(user.user['client-key-data']) && !user.user.exec && !user.user['auth-provider'] && !user.user.token && !user.user.tokenFile);
  fail(!cluster.cluster['certificate-authority'] && !cluster.cluster['proxy-url'] && !user.user['client-certificate'] && !user.user['client-key']);
}

export function assertNegative(snapshot, variant) {
  const fail = (ok) => assert.ok(ok, 'signature rejection must be explicit and precede revision, definition and runtime installation');
  fail(variant === 'issuer' || variant === 'subject');
  fail(snapshot.provider?.spec.package === NEW);
  fail(conditions(snapshot.provider).some(c => c.type === 'Healthy' && c.status === 'False'
    // Crossplane runtime 2.4.0 validate.go wraps Cosign's certificate-identity error with this exact authority.
    && (c.message ?? '').includes(`authority "acceptance-reject-${variant}": signature verification failed with `)
    && /none of the expected identities matched what was in the certificate/.test(c.message)));
  for (const key of ['revisions', 'deployments', 'pods', 'definitions']) fail(Array.isArray(snapshot[key]) && snapshot[key].length === 0);
}

export function assertPolicyManagerReload(before, after) {
  const fail = ok => assert.ok(ok, 'policy synchronization requires a newly ready package-manager runtime and an unchanged RBAC manager');
  let previous; let current;
  try {
    previous = assertBootstrap(before);
    current = assertBootstrap(after);
  } catch {
    fail(false);
  }
  const previousManager = previous.find(item => item.deployment.name === 'crossplane');
  const currentManager = current.find(item => item.deployment.name === 'crossplane');
  const previousRBAC = previous.find(item => item.deployment.name === 'crossplane-rbac-manager');
  const currentRBAC = current.find(item => item.deployment.name === 'crossplane-rbac-manager');
  fail(previousManager && currentManager && previousRBAC && currentRBAC);
  fail(currentManager.deployment.uid === previousManager.deployment.uid
    && currentManager.deployment.generation > previousManager.deployment.generation
    && currentManager.pod.uid !== previousManager.pod.uid);
  const previousSets = new Set(previousManager.replicaSets.map(item => item.uid));
  const currentPod = after.pods.find(item => item.metadata.uid === currentManager.pod.uid);
  const currentPodOwner = currentPod?.metadata.ownerReferences?.find(item => item.controller === true && item.kind === 'ReplicaSet');
  fail(currentPodOwner && !previousSets.has(currentPodOwner.uid)
    && currentManager.replicaSets.some(item => item.uid === currentPodOwner.uid));
  assert.deepEqual(currentRBAC, previousRBAC,
    'policy synchronization requires a newly ready package-manager runtime and an unchanged RBAC manager');
}

export const packageManagerRestartCommand = (kubeconfig, context, cacheDir) => ({
  executable: 'kubectl',
  args: ['rollout', 'restart', 'deployment/crossplane', '--namespace', 'crossplane-system',
    '--kubeconfig', kubeconfig, '--context', context, '--request-timeout=20s', '--cache-dir', cacheDir],
});

export function assertHealthy(s, ref, generation, baseline) {
  proof(ref === OLD || ref === NEW, 'unapproved package');
  const p = s.provider;
  proof(p?.metadata.uid && p.metadata.generation === generation && p.spec.package === ref && p.status.currentIdentifier === ref, 'current Provider identity/source');
  proof(currentTrue(p, 'Healthy') && currentTrue(p, 'Installed'), 'current Provider health');
  proof(s.providerConfigs?.length === 0, 'credential configuration exists');
  proof(JSON.stringify([...s.activation.spec.activate].sort()) === JSON.stringify([...ACTIVE].sort()), 'activation scope changed');
  if (ref === NEW) proof(p.status.appliedImageConfigRefs?.some(c => c.name === 'owned-provider-acceptance' && c.reason === 'VerifyImage'), 'strict signature policy not selected');
  const active = s.revisions.filter(r => r.spec.desiredState === 'Active');
  proof(active.length === 1, 'exactly one active revision required');
  const r = active[0];
  proof(r.metadata.name === p.status.currentRevision && owner(r, p.metadata.uid) && r.spec.image === ref
    && ['RevisionHealthy', 'RuntimeHealthy', 'RuntimeActive'].every(type => currentTrue(r, type)), 'current active revision/source/health');
  const deployments = s.deployments.filter(d => owner(d, r.metadata.uid));
  proof(deployments.length === 1, 'current revision Deployment ownership');
  const d = deployments[0]; const count = d.spec.replicas ?? 1;
  proof(count > 0 && d.status.observedGeneration === d.metadata.generation
    && ['replicas', 'updatedReplicas', 'readyReplicas', 'availableReplicas'].every(k => d.status[k] === count), 'current Deployment not ready');
  proof(d.spec.template.spec.containers.length === 1 && d.spec.template.spec.containers[0].image === ref, 'Deployment image override');
  proof((d.spec.template.spec.initContainers ?? []).length === 0, 'unreviewed provider init container');
  const sets = s.replicaSets.filter(rs => owner(rs, d.metadata.uid));
  const pods = s.pods.filter(pod => !pod.metadata.deletionTimestamp && sets.some(rs => owner(pod, rs.metadata.uid)));
  proof(pods.length === count, 'current runtime Pod ownership/count');
  for (const pod of pods) {
    proof(pod.status.phase === 'Running' && conditions(pod).some(c => c.type === 'Ready' && c.status === 'True'), 'Pod not ready');
    proof(pod.spec.containers.length === 1 && pod.spec.containers[0].image === ref, 'Pod image override');
    proof((pod.spec.initContainers ?? []).length === 0, 'unreviewed provider Pod init container');
    const states = pod.status.containerStatuses ?? [];
    proof(states.length === 1 && states[0].ready && states[0].restartCount === 0, 'runtime container state');
    const id = states[0].imageID ?? '';
    proof([ref.split('@')[1], CHILD[ref]].some(digest => id === digest || id.endsWith(`@${digest}`)), 'runtime image identity');
  }
  const refs = r.status.objectRefs ?? [];
  proof(refs.length === (ref === NEW ? 79 : 77) && new Set(refs.map(x => x.name)).size === refs.length, 'package definition inventory');
  const expected = [...INVENTORY.old, ...(ref === NEW ? INVENTORY.added : [])].sort();
  proof(JSON.stringify(refs.map(x => x.name).sort()) === JSON.stringify(expected), 'unexpected package definition names');
  for (const item of refs) {
    proof(item.kind === (INVENTORY.configuration.includes(item.name) ? 'CustomResourceDefinition' : 'ManagedResourceDefinition'), 'definition kind changed');
    const object = s.definitions.find(o => o.kind === item.kind && o.metadata.name === item.name);
    proof(object?.metadata.uid && object.metadata.uid === item.uid && owner(object, r.metadata.uid), `definition identity/ownership: ${item.name}`);
  }
  for (const name of ACTIVE) {
    const crd = s.crds.find(c => c.metadata.name === name);
    const definition = s.definitions.find(c => c.metadata.name === name);
    proof(crd?.metadata.uid && conditions(crd).some(c => c.type === 'Established' && c.status === 'True') && definition?.spec.state === 'Active'
      && owner(crd, definition.metadata.uid), `active definition not established: ${name}`);
  }
  for (const definition of s.definitions.filter(d => d.kind === 'ManagedResourceDefinition')) {
    proof(definition.spec.state === (ACTIVE.includes(definition.metadata.name) ? 'Active' : 'Inactive'), 'unexpected managed definition activation');
  }
  proof(JSON.stringify(s.crds.map(c => c.metadata.name).sort()) === JSON.stringify([...ACTIVE, ...INVENTORY.configuration].sort()), 'unexpected established API inventory');
  for (const name of EXTRA) {
    const definition = s.definitions.find(c => c.metadata.name === name);
    if (ref === NEW) proof(Boolean(definition), `new definition missing: ${name}`);
    proof(!definition || definition.spec.state === 'Inactive', 'new kind unexpectedly activated');
    proof(!s.crds.some(c => c.metadata.name === name), 'new kind CRD unexpectedly present');
  }
  const f = s.fixture;
  if (f) {
    proof(f.metadata.uid && f.metadata.annotations?.['crossplane.io/paused'] === 'true'
      && f.metadata.annotations['crossplane.io/external-name'] === 'synthetic-repository'
      && f.spec.forProvider.branch === 'main' && !Object.hasOwn(f.spec.forProvider, 'repository')
      && JSON.stringify(f.spec.managementPolicies) === '["Observe"]'
      && f.spec.providerConfigRef.name === 'absent' && f.spec.providerConfigRef.kind === 'ClusterProviderConfig', 'fixture isolation or external identity changed');
    proof(conditions(f).some(c => c.reason === 'ReconcilePaused'), 'fixture pause not observed');
  }
  if (baseline) {
    proof(p.metadata.uid === baseline.provider.metadata.uid && f?.metadata.uid === baseline.fixture?.metadata.uid, 'Provider or fixture recreated');
    proof(JSON.stringify(f.spec) === JSON.stringify(baseline.fixture.spec), 'fixture spec changed');
    for (const previous of baseline.crds) proof(s.crds.some(c => c.metadata.name === previous.metadata.name && c.metadata.uid === previous.metadata.uid), `CRD recreated: ${previous.metadata.name}`);
    for (const previous of baseline.definitions) proof(s.definitions.some(c => c.metadata.name === previous.metadata.name && c.metadata.uid === previous.metadata.uid), `definition recreated: ${previous.metadata.name}`);
  }
}

// No credential-bearing environment is forwarded to Docker, Helm, KSail or kubectl.
// The workflow's separate provenance step alone receives its read-only GitHub token.
export function runtimeEnvironment(env, root) {
  return { PATH: env.PATH, HOME: env.HOME, LANG: 'C.UTF-8', TMPDIR: root,
    KUBECONFIG: path.join(root, 'kubeconfig'), DOCKER_CONFIG: path.join(root, 'docker'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'), XDG_CACHE_HOME: path.join(root, 'cache') };
}

function runner(env) {
  const identity = assertContext(env); // Must precede every filesystem or subprocess mutation.
  const { root, cluster } = identity;
  const tools = path.join(env.RUNNER_TEMP, 'provider-acceptance-tools');
  const project = path.join(root, 'project');
  const kubeconfig = path.join(root, 'kubeconfig');
  const context = `kind-${cluster}`;
  const config = path.join(project, 'ksail.yaml');
  const evidence = path.join(root, 'evidence');
  const runtimeEnv = runtimeEnvironment(env, root);
  const marker = { ...identity, sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
  const executable = name => ['ksail', 'helm', 'kubectl'].includes(name) ? path.join(tools, name) : name;
  const command = (name, args, { input, privateInput = false, timeout = 60_000, maxBuffer = 32 * 1024 * 1024, cwd = root } = {}) => {
    const result = spawnSync(executable(name), args, { env: runtimeEnv, cwd, input, encoding: 'utf8', timeout, maxBuffer });
    if (result.error || result.status !== 0) throw new Error(`${name} ${args[0]} failed: ${privateInput ? 'private chart input withheld' : (result.error?.message ?? result.stderr ?? '').slice(-5000)}`);
    return result.stdout;
  };
  const save = (name, data) => fs.writeFileSync(path.join(evidence, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  const kubeGuard = options => assertKubeconfig(JSON.parse(command('kubectl', ['config', 'view', '--raw', '--kubeconfig', kubeconfig, '-o', 'json'], options)), context);
  const k = (args, options) => {
    kubeGuard();
    return command('ksail', ['workload', ...args, '--kubeconfig', kubeconfig, '--context', context, '--request-timeout=20s', '--cache-dir', path.join(root, 'discovery')], options);
  };
  const get = (resource, ...args) => JSON.parse(k(['get', resource, ...args, '-o', 'json']));
  const list = (resource, ...args) => get(resource, ...args).items;
  const apply = object => k(['apply', '-f', '-'], { input: JSON.stringify(object) });
  const brief = o => ({ apiVersion: o.apiVersion, kind: o.kind, metadata: {
    name: o.metadata.name, namespace: o.metadata.namespace, uid: o.metadata.uid,
    generation: o.metadata.generation, resourceVersion: o.metadata.resourceVersion,
    ownerReferences: o.metadata.ownerReferences, annotations: o.kind === 'DefaultBranch' ? o.metadata.annotations : undefined,
    deletionTimestamp: o.metadata.deletionTimestamp,
  }, spec: o.kind === 'CustomResourceDefinition' ? undefined : o.kind === 'ManagedResourceDefinition' ? { state: o.spec.state } : o.spec, status: o.status });
  const packageObjects = objects => objects.filter(o => o.metadata.name.endsWith('.github.upbound.io') || o.metadata.name.endsWith('.github.m.upbound.io'));
  const providerName = 'github-acceptance';
  const provider = ref => ({ apiVersion: 'pkg.crossplane.io/v1', kind: 'Provider', metadata: { name: providerName },
    spec: { package: ref, packagePullPolicy: 'IfNotPresent', revisionActivationPolicy: 'Automatic', revisionHistoryLimit: 1 } });
  let lastSnapshot;
  // Bounded local API observations inside this single disposable job, not remote CI polling.
  const until = async (phase, observe, check, milliseconds = 360_000) => {
    const deadline = Date.now() + milliseconds;
    let failure;
    do {
      try { const value = observe(); lastSnapshot = value; check(value); save(phase, value); return value; }
      catch (error) { failure = error; }
      await delay(5000);
    } while (Date.now() < deadline);
    if (lastSnapshot) save(`${phase}-last-observation`, lastSnapshot);
    throw new Error(`${phase} did not establish its assertions: ${failure?.message}`);
  };
  const definitions = () => [...packageObjects(list('managedresourcedefinitions.apiextensions.crossplane.io')), ...packageObjects(list('customresourcedefinitions.apiextensions.k8s.io'))];
  const snapshot = (withFixture = true) => {
    const all = definitions();
    // CRDs generated by MRDs are not package references. Keep the two inventories separate.
    const defs = all.filter(o => o.kind === 'ManagedResourceDefinition' || INVENTORY.configuration.includes(o.metadata.name));
    return {
      provider: brief(get('providers.pkg.crossplane.io', providerName)),
      revisions: list('providerrevisions.pkg.crossplane.io').map(brief),
      deployments: list('deployments.apps', '-n', 'crossplane-system').map(brief),
      replicaSets: list('replicasets.apps', '-n', 'crossplane-system').map(brief),
      pods: list('pods', '-n', 'crossplane-system').map(brief),
      definitions: defs.map(brief), crds: all.filter(o => o.kind === 'CustomResourceDefinition').map(brief),
      providerConfigs: ['providerconfigs.github.upbound.io', 'providerconfigs.github.m.upbound.io', 'clusterproviderconfigs.github.m.upbound.io'].flatMap(r => list(r, '--all-namespaces').map(brief)),
      activation: brief(get('managedresourceactivationpolicies.apiextensions.crossplane.io', 'acceptance')),
      ...(withFixture ? { fixture: brief(get('defaultbranches.repo.github.m.upbound.io', 'preserved', '-n', 'provider-acceptance')) } : {}),
    };
  };
  const negativeSnapshot = () => ({ provider: brief(get('providers.pkg.crossplane.io', providerName)),
    revisions: list('providerrevisions.pkg.crossplane.io').map(brief), definitions: definitions().map(brief),
    deployments: list('deployments.apps', '-n', 'crossplane-system').filter(d => !['crossplane', 'crossplane-rbac-manager'].includes(d.metadata.name)).map(brief),
    pods: list('pods', '-n', 'crossplane-system').filter(p => !['crossplane', 'crossplane-rbac-manager'].includes(p.metadata.labels?.app)).map(brief) });
  const ownedContainers = () => command('docker', ['ps', '--all', '--filter', `label=io.x-k8s.kind.cluster=${cluster}`, '--format', '{{.Names}}']).trim().split('\n').filter(Boolean);

  const cleanup = () => {
    if (!fs.existsSync(path.join(root, 'ownership.json'))) return;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8')), marker, 'cleanup ownership differs from this run');
    const names = ownedContainers();
    assert.ok(names.every(name => name === `${cluster}-control-plane`), 'cleanup found an unexpected owned container');
    if (names.length) command('ksail', ['cluster', 'delete', '--name', cluster, '--provider', 'Docker', '--kubeconfig', kubeconfig, '--config', config, '--force'], { cwd: project, timeout: 180_000 });
    assert.deepEqual(ownedContainers(), [], 'owned cluster remains after cleanup');
    save('cleanup', { cluster, remainingOwnedContainers: 0 });
    fs.unlinkSync(path.join(root, 'ownership.json')); // The always() step is then a no-op after successful cleanup.
  };
  const run = async () => {
    assert.ok(!fs.existsSync(root), 'acceptance directory already exists');
    fs.mkdirSync(root, { mode: 0o700 });
    for (const directory of [evidence, runtimeEnv.DOCKER_CONFIG, runtimeEnv.XDG_CONFIG_HOME, runtimeEnv.XDG_CACHE_HOME]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const disk = fs.statfsSync(root);
    assert.ok(os.cpus().length >= 2 && disk.bavail * disk.bsize >= 20 * 1024 ** 3, 'insufficient hosted capacity');
    const docker = JSON.parse(command('docker', ['info', '--format', '{{json .}}']));
    assert.ok(docker.NCPU >= 2 && docker.MemTotal >= 6 * 1024 ** 3, 'insufficient Docker capacity');
    command('docker', ['system', 'df']); // Fails on corrupt containerd storage; never repairs or prunes it.
    assert.deepEqual(ownedContainers(), [], 'cluster already exists');
    const flags = ['--name', cluster, '--distribution', 'Vanilla', '--provider', 'Docker', '--cni', 'Default', '--csi', 'Disabled', '--load-balancer', 'Disabled',
      '--metrics-server', 'Disabled', '--cert-manager', 'Disabled', '--policy-engine', 'None', '--gitops-engine', 'None', '--control-planes', '1', '--workers', '0',
      '--mirror-registry=', '--local-registry=', '--kubeconfig', kubeconfig];
    command('ksail', ['project', 'init', '--output', project, ...flags, '--no-devcontainer']);
    // Exact scaffold and explicit Kind configuration prevent hidden mirrors, mounts or cloud settings.
    const scaffold = fs.readFileSync(config, 'utf8').split('\n').filter(line => !line.startsWith('#')).join('\n').trim();
    assert.equal(scaffold, `apiVersion: ksail.io/v1alpha1\nkind: Cluster\nmetadata:\n  name: ${cluster}\nspec:\n  cluster:\n    connection:\n      kubeconfig: ${kubeconfig}\n    csi: Disabled\n    loadBalancer: Disabled\n    metricsServer: Disabled`);
    assert.deepEqual(fs.readdirSync(project).sort(), ['k8s', 'kind.yaml', 'ksail.yaml']);
    fs.writeFileSync(path.join(project, 'kind.yaml'), JSON.stringify({ apiVersion: 'kind.x-k8s.io/v1alpha4', kind: 'Cluster', name: cluster,
      networking: { apiServerAddress: '127.0.0.1' }, nodes: [{ role: 'control-plane', image: NODE }] }));
    fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify(marker), { mode: 0o600 });
    let baseline; let primaryError; let bootstrapSnapshot;
    try {
      command('ksail', ['cluster', 'create', '--config', config, ...flags], { cwd: project, timeout: 480_000 });
      kubeGuard();
      const values = { image: { repository: CORE, ignoreTag: true, pullPolicy: 'IfNotPresent' }, args: ['--enable-signature-verification'], provider: { packages: [], defaultActivations: [] }, configuration: { packages: [] }, function: { packages: [] },
        resourcesCrossplane: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } },
        resourcesRBACManager: { requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '128Mi' } } };
      const valuesPath = path.join(root, 'crossplane-values.json');
      fs.writeFileSync(valuesPath, JSON.stringify(values));
      const chart = path.join(tools, 'crossplane-2.4.0.tgz');
      const render = command('helm', ['template', 'crossplane', chart, '--namespace', 'crossplane-system', '--values', valuesPath]);
      // Read render via the real API client's local parser; no apply and no Secret output.
      const objects = parseRenderedObjects(command('kubectl', ['create', '--dry-run=client', '--validate=false', '--kubeconfig', kubeconfig, '--context', context, '-f', '-', '-o', 'json'], { input: render, privateInput: true }));
      assertRenderedObjects(objects);
      command('helm', ['upgrade', '--install', 'crossplane', chart, '--namespace', 'crossplane-system', '--create-namespace', '--values', valuesPath,
        '--kubeconfig', kubeconfig, '--kube-context', context, '--wait', '--timeout', '5m'], { timeout: 330_000 });
      const observeBootstrap = () => ({ deployments: list('deployments.apps', '-n', 'crossplane-system').map(brief),
        replicaSets: list('replicasets.apps', '-n', 'crossplane-system').map(brief), pods: list('pods', '-n', 'crossplane-system').map(brief),
        activations: list('managedresourceactivationpolicies.apiextensions.crossplane.io') });
      await waitForBootstrap(() => (bootstrapSnapshot = observeBootstrap()), save);
      const synchronizePolicy = async (policy, phase) => {
        const before = observeBootstrap();
        assertBootstrap(before);
        apply(policy);
        assert.deepEqual(get('imageconfigs.pkg.crossplane.io', policy.metadata.name).spec, policy.spec, 'image policy not stored exactly');
        // Kubernetes readiness follows cache synchronization during controller startup. Replacing the
        // package-manager Pod after the write closes the informer race before a Provider can exist.
        kubeGuard();
        const restart = packageManagerRestartCommand(kubeconfig, context, path.join(root, 'discovery'));
        command(restart.executable, restart.args);
        bootstrapSnapshot = await until(`policy-${phase}-loaded`, observeBootstrap,
          after => assertPolicyManagerReload(before, after), 120_000);
      };
      for (const field of ['issuer', 'subject']) {
        const policy = positivePolicy();
        policy.spec.verification.cosign.authorities[0].name = `acceptance-reject-${field}`;
        policy.spec.verification.cosign.authorities[0].keyless.identities[0][field] = `https://invalid.example/${field}`;
        await synchronizePolicy(policy, `reject-${field}`);
        apply(provider(NEW));
        await until(`reject-${field}`, negativeSnapshot, s => assertNegative(s, field), 120_000);
        k(['delete', 'providers.pkg.crossplane.io', providerName, '--wait=true', '--timeout=60s'], { timeout: 80_000 });
      }
      await synchronizePolicy(positivePolicy(), 'accept');
      assertPolicy(get('imageconfigs.pkg.crossplane.io', 'owned-provider-acceptance'));
      apply({ apiVersion: 'apiextensions.crossplane.io/v1alpha1', kind: 'ManagedResourceActivationPolicy', metadata: { name: 'acceptance' }, spec: { activate: ACTIVE } });
      apply(provider(OLD));
      const initialGeneration = get('providers.pkg.crossplane.io', providerName).metadata.generation;
      await until('old-installed', () => snapshot(false), s => assertHealthy(s, OLD, initialGeneration));
      apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'provider-acceptance' } });
      apply({ apiVersion: 'repo.github.m.upbound.io/v1alpha1', kind: 'DefaultBranch', metadata: { name: 'preserved', namespace: 'provider-acceptance',
        annotations: { 'crossplane.io/paused': 'true', 'crossplane.io/external-name': 'synthetic-repository' } },
      // Upjet maps the repository from external-name; it is not a served forProvider field.
      spec: { forProvider: { branch: 'main' }, managementPolicies: ['Observe'], providerConfigRef: { name: 'absent', kind: 'ClusterProviderConfig' } } });
      baseline = await until('old-baseline', snapshot, s => assertHealthy(s, OLD, initialGeneration));
      for (const [phase, ref] of [['new-installed', NEW], ['old-restored', OLD]]) {
        assertPolicy(get('imageconfigs.pkg.crossplane.io', 'owned-provider-acceptance'));
        // The same declarative Provider changes only spec.package. The API assigns a new generation/revision.
        apply(provider(ref));
        const generation = get('providers.pkg.crossplane.io', providerName).metadata.generation;
        await until(phase, snapshot, s => assertHealthy(s, ref, generation, baseline));
      }
    } catch (error) {
      primaryError = error;
      save('failure', { message: error.message, ...marker });
      if (baseline) {
        try {
          assertPolicy(get('imageconfigs.pkg.crossplane.io', 'owned-provider-acceptance'));
          apply(provider(OLD)); const generation = get('providers.pkg.crossplane.io', providerName).metadata.generation;
          await until('failure-return-to-old', snapshot, s => assertHealthy(s, OLD, generation, baseline), 240_000);
        } catch (recoveryError) { save('recovery-failure', { message: recoveryError.message }); }
      }
    }
    finishResult(primaryError, cleanup, save, { ...marker, old: OLD, new: NEW, oldTrust: 'digest-only baseline; no legacy signature claim',
      nativeTrust: 'new digest prefix, strict issuer and subject; publisher SHA verified separately', fixture: 'paused and credential-free; external reconciliation is not exercised' }, () => {
      kubeGuard({ timeout: 3000, maxBuffer: 65536 });
      const diagnostic = (args, options) => command('kubectl', [...args, '--namespace', 'crossplane-system', '--kubeconfig', kubeconfig,
        '--context', context, '--request-timeout=2s', '--cache-dir', path.join(root, 'discovery')], { ...options, privateInput: true });
      collectBootstrapDiagnostics(bootstrapSnapshot, {
        read: (kind, name, options) => JSON.parse(diagnostic(['get', kind, name, '-o', 'json'], options)),
        logs: (pod, container, previous, options) => diagnostic(['logs', pod.name, '--container', container, `--previous=${previous}`,
          '--tail=100', '--limit-bytes=16384', '--timestamps=true', '--pod-running-timeout=2s'], options),
        events: (pod, options) => JSON.parse(diagnostic(['get', 'events', '--field-selector', `involvedObject.uid=${pod.uid}`, '-o', 'json'], options)).items,
        save,
      });
    });
  };
  return { run, cleanup };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv[2] === 'context') assertContext(process.env);
    else if (process.argv[2] === 'run') await runner(process.env).run();
    else if (process.argv[2] === 'cleanup') runner(process.env).cleanup();
    else throw new Error('expected context, run or cleanup');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
