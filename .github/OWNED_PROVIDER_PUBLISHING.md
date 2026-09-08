# Temporary owned provider package

`publish-owned-provider.yml` builds the released upstream v0.20.0 source at
`a211e095e2fe49c477836acec2ad4a28aa60e030` while its canonical package is unavailable.
It publishes only to `ghcr.io/devantler/provider-upjet-github`. This is an owned
bridge, not an upstream release or a commitment to maintain a downstream provider.
It does not mirror packages or change the fork's inherited publisher.

The workflow must be reviewed and present on this fork's `main` branch before a
manual dispatch can run. Leave `publish` false for the first build. That run
produces the amd64 and arm64 package artifacts without a registry or signing
token. After both build artifacts have been checked, a separate dispatch with
`publish` true rebuilds, publishes, signs and attests the resulting digest.

Each dispatch uses the same fixed runtime commit, tree and build submodule. The
publisher recipe comes from the dispatch's commit on this fork. Both identities
are recorded separately in the source attestation, along with the run, attempt,
architecture and package checksums. Tags include the run and attempt; consumers
must use the verified immutable digest, not a tag.

The build uses upstream's packaging recipe, Go 1.26.2, checksum-pinned Crossplane
CLI 2.1.3, and native Linux runners. It does not alter generated CRDs or runtime
source. Upstream's Dockerfile still resolves Alpine 3.23.4 and APK packages at
build time: this is source provenance, not a claim of bit-for-bit reproducibility.

Cosign 3.0.6 signs and verifies using its legacy signature format because
Crossplane 2.4's native verifier reads that format. The workflow explicitly
disables the newer bundle format and signing config for signing, and the newer
bundle format for verification. Certificate identity and transparency-log
verification remain enabled. The separate GitHub source attestation uses its
modern bundle format and is independently verified with GitHub CLI.

Before a production pin, independently verify the image's amd64/arm64 manifests,
embedded CRDs and source parity, anonymous registry access, and both the Cosign
signature and GitHub attestation. Require this exact workflow identity, its
reviewed commit, and the upstream commit above. Check that the consuming verifier
accepts the actual published signature. Registry visibility and provider migration
or recovery behavior are separate acceptance checks; a successful upload does
not establish either. This workflow does not change package visibility or any
cluster configuration.

Local publisher checks:

```sh
node --test .github/scripts/owned-provider-publisher.test.mjs
actionlint .github/workflows/publish-owned-provider.yml
```

For contributions, retain the repository PR template and sign off commits under
the Crossplane DCO. The Crossplane AI contribution policy applies to upstream
engagement; the contributor owns and must understand the entire proposal.
