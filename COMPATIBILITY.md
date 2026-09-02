# Compatibility

## Audited runtime

- DSH: `0.1.2-alpha.5` only
- Node.js: `>=22.19.0`
- Web client platform: `web`
- Shared React / ReactDOM: `18.3.1`
- Runtime Schemastery baseline: `3.18.2`

The package declares an exact DSH engine rather than a range. Run `pnpm run verify:runtime -- <runtime-root>` before changing that declaration.

## Public contracts used

Host:

- Cordis plugin exports `name`, `inject`, `Config`, and `apply`;
- hard dependencies `settings`, `credentials`, and `webServer`;
- `settings.register(namespace, schema, { base, validate })`, `settings.get(namespace)`, and revision-fenced `settings.update(namespace, patch, expectedRevision)`;
- per-operation `credentials.resolve(ref)` plus redacted `describe(ref)`, writable `set(ref, value)`, and `unset(ref)`;
- exact `webServer.register({ kind: 'exact', path, handler })` routes whose returned disposers are owned by `ctx.effect()`.

Client:

- Client bundle injection through `dsh-api-remotes`, `dsh-client-ui-renderer`, `dsh-client-ui-settings`, and `dsh-client-ui-sidebar`;
- `ctx.remote.credentials.describe(refs)` with generated RemoteResult handling and no secret readback;
- `ctx.settingsScope.bind()` with loading/ready/unavailable snapshots and revision metadata;
- additive `sidebar.footer.action` Slot receiving the `wide` owner prop;
- additive `settings.section` Slot; the supplied `close` owner prop is intentionally unused;
- Slot renderer `data-slot` output as a narrow CSS layout anchor;
- the runtime Client module loader's injected-package materialization and revision-aware invalidation;
- the Web shell's shared React 18 runtime.

The plugin does not edit DSH Runtime files, replace root Shell slots, read Credential values in the browser, or send browser requests directly to the configured relay.

## Alpha 5 audit result

The DSH `0.1.2-alpha.5` declarations and shipped JavaScript were inspected for every contract above. No Host or Client business-logic adaptation was required from the Alpha 2 implementation. The compatibility upgrade consists of:

- pinning `engines.dsh` to the audited Alpha 5 release;
- aligning the direct Schemastery dependency with the runtime's `3.18.2` baseline;
- adding an executable runtime-contract probe;
- updating tests and installation documentation to the isolated Alpha 5 paths;
- packaging and installing a versioned tarball rather than a moving source branch.

## Verification boundary

`pnpm verify` covers generated Client drift, syntax, quota semantics, history normalization, request lifecycles, security checks, Settings/Credential behavior, routes, and package identity. The runtime probe additionally checks the installed Alpha 5 package versions and the exact public contract declarations consumed by this plugin.

Those automated checks do not start or restart DSH, call a real relay, or drive the browser. After installation, the user must restart the existing Alpha 5 DSH process and refresh `http://127.0.0.1:3082`, then confirm:

1. **Settings → 中转概览** opens and shows only the intended history/model/configuration UI;
2. the saved API key is reported as configured but is never filled back into the browser;
3. test/save, status, and 30-day history requests work against the user's trusted relay;
4. expanded and collapsed sidebar layouts render correctly;
5. load, one-minute, visibility, save, and click refresh paths still behave as documented.

Do not widen `engines.dsh` to another DSH release until the probe and these manual checks have been repeated against that exact release.
