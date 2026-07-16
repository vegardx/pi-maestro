# Strong research isolation with Apple container

The optional Strong backend runs Recon and Plan repository code in one
phase-scoped Apple `container` VM. It is available only on Apple-silicon macOS
26 or newer with Apple container 0.6.0 or newer and all required probes passing.
Unsupported choices remain visible and report what the operator must fix.

## Immutable image policy

The production image is a reviewed, arm64 OCI manifest, referenced only by
its immutable digest in `APPLE_CONTAINER_RESEARCH_IMAGE`:

```text
docker.io/library/node@sha256:63c7334e154f369954e1d59c0299a4eb24f4f8e197d197fba8c7de259e69302b
```

This is the linux/arm64 manifest of the Node 22 Bookworm image selected for the
initial policy. It supplies Bash, Node/npm and common Debian userland without
including project files or credentials. Updating the image requires a source
change and review. Verify the replacement manifest's architecture and digest,
update tests/documentation together, and treat it as a dependency update.

The runtime **never pulls or builds an image**. A trusted operator prepares it
before entering a research phase:

```sh
container system start
container image pull docker.io/library/node@sha256:63c7334e154f369954e1d59c0299a4eb24f4f8e197d197fba8c7de259e69302b
container image inspect docker.io/library/node@sha256:63c7334e154f369954e1d59c0299a4eb24f4f8e197d197fba8c7de259e69302b
```

These are operator/setup commands, not model-generated commands. Registry
credentials remain on the trusted controller and are never copied or passed to
the guest. Image absence fails closed with the exact pre-pull instruction.

## Capability probe

Preparation is lazy. Before any requested command can start, the backend checks:

- Darwin, arm64, and macOS 26+;
- parseable Apple container version 0.6.0+;
- explicit service readiness (`container system status`), without auto-start;
- create flags for `--network none`, `--no-dns`, capability dropping,
  read-only root, tmpfs, CPU and memory limits;
- `cp`, `exec`, `stop`, force-delete, list, and JSON-list behavior;
- local availability of the exact pinned image.

A failed probe throws `IsolationUnavailableError` before command execution, so
the existing explicit fallback UX can offer Cancel, direct once, None for the
session, or Hack. There is no silent fallback and no silent service start.

## Workspace and guest policy

The controller creates the same private tracked plus non-ignored-untracked
snapshot used by Lightweight. It creates a VM with **no bind mounts**, starts
it, and copies that snapshot into `/workspace` using `container cp`. No guest
path references the real checkout. Nothing is copied back.

The VM policy includes:

- `--network none --no-dns` (not an internal/host-only network);
- `--cap-drop ALL`;
- read-only image root with private tmpfs for `/workspace`, `/tmp`, and home;
- two CPUs, 2 GiB memory, 1024 file descriptors, and 256 processes;
- a private, allowlisted environment with no Maestro, SSH/GPG, registry,
  cloud, proxy, container-control, token, password, or credential variables;
- no host home, repository, SSH agent, Docker socket, Apple-container service
  endpoint, or other host/control socket mounts;
- one VM shared by the Recon→Plan epoch so generated files survive commands.

`container exec` maps the source-relative cwd into `/workspace`. Output streams
through Pi's normal Bash rendering. Pi's timeout and cancellation terminate the
attached CLI and taint the VM; the backend then stops and force-deletes it so
background guest processes cannot survive.

## Cleanup and crash recovery

Every VM has both an extension-owned name prefix and ownership/epoch labels.
Before creating a new VM, the backend lists all containers and force-deletes
stale extension-owned instances from previous crashes. Reset, transition to
Auto/Hack, abort, timeout, execution transport failure, and session shutdown
all perform idempotent stop + force-delete + absence verification.

Lifecycle invalidation is synchronous before asynchronous teardown begins. Once
a requested `container exec` may have started, errors are ordinary execution
errors rather than `IsolationUnavailableError`; this prevents fallback UX from
replaying a potentially side-effecting command on the host.

## Optional host integration probe

Adapter tests use an injected fake CLI and never launch infrastructure. On a
supported, explicitly prepared machine, run the opt-in probe with:

```sh
PI_MAESTRO_APPLE_CONTAINER_INTEGRATION=1 npm test -- test/apple-container.integration.test.ts
```

The probe uses the same digest and validates workspace copy-in, offline network,
environment isolation, limits, abort cleanup, and stale reconciliation. It is
skipped everywhere else.
