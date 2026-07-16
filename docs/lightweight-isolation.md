# Lightweight research isolation

Recon and Plan commands that may execute repository code run in a private,
phase-scoped source snapshot through `@anthropic-ai/sandbox-runtime`.

## Boundary

Lightweight is an **accident-prevention process policy**, not a container, VM,
or adversarial-code boundary. On macOS it uses Seatbelt (`sandbox-exec`); on
supported Linux hosts sandbox-runtime uses bubblewrap. The trusted Maestro
controller still runs on the host.

The controller:

- lazily copies tracked and relevant current, non-ignored source into a private
  Recon→Plan workspace;
- gives commands a private home, temp directory, and caches;
- allows writes only in that phase directory and explicitly denies the real
  checkout and sandbox-runtime's broad compatibility write defaults;
- keeps broad system/repository reads for developer-tool compatibility while
  denying the host home/config hierarchy;
- disables network access because hostname-only proxy approval cannot safely
  prevent DNS rebinding/private-address resolution; blocks local binding and
  allows no Unix control sockets;
- constructs an allowlisted child environment without Maestro RPC/session,
  tmux, SSH/GPG agent, or obvious secret variables;
- supervises the detached process group and kills it on cancellation, timeout,
  mode exit, or session shutdown. This is best-effort process cleanup, not a
  VM/cgroup guarantee; use Strong for adversarial code.

There is no copy-back. Entering Auto or Hack ends the epoch. Recon→Plan shares
the same private workspace so generated research artifacts remain available.

## Failure and tier behavior

Isolation never retries directly by itself. A setup failure is visible and
obeys the selected fallback policy. Fail-closed offers only cancellation;
confirmation-enabled fallback may offer direct-once, None-for-session, or Hack,
and every weaker choice requires explicit confirmation. Configured `None` likewise confirms
host execution in protected modes. `Strong` is a reserved backend contract and
reports unavailable until a VM/container provider is installed.

Use Strong, when available, for untrusted or intentionally adversarial code.
Use Hack only as explicit authorization for direct host execution.
