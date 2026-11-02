# Remote Claude host contract (TEST-ONLY)

`lib/host-contract.mjs` is an unchanged snapshot of the optional
`pi-remote-claude` pi package's host contract. Its SHA-256 is
`f5644dfa67cb4768addd7e13749a38dd59e05bc27f61fd7c988f476fa5e5de26`.
The integration tests use it in an isolated test HOME to exercise the real
SDK's live session/host bindings without loading user configuration,
credentials or remote services. It is not included in the npm package and is
not the runtime source of the contract.

At runtime the contract comes from a `pi-remote-claude` package installed in
the pi agent directory's `packages/`; without it, the remote Claude provider is
simply unavailable. When the package's contract changes, explicitly review and
replace this fixture and its test digest; a passing snapshot test alone does not
establish that every installation has the same contract.
