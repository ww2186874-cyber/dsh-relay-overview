# dsh-nbapi-balance

Permanent, local DSH Web Profile plugin that shows the configured NB Codex relay balance in the public list Slot `sidebar.footer.action`.

## Installation and Profile registration

The plugin directory belongs under the active Web Profile workspace, for example:

```text
profiles/web/packages/dsh-nbapi-balance
```

The Web Profile registers it as a workspace package:

```json
{
  "dependencies": {
    "dsh-nbapi-balance": "workspace:*"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-nbapi-balance"]
    }
  }
}
```

`pnpm-workspace.yaml` must include `packages/*`. The package's `cordis.patch.yml` inserts exactly one Host row with id `nbapi-balance`.

## Data source and quota calculation

The Host reads `llm-pi-ai.providers.nbcodex` from DSH `settings`, obtaining only the configured `baseURL` and `apiKeyEnv`. On **every** balance operation it calls `credentials.resolve(apiKeyEnv)`, then queries `<baseURL>/usage`. Only HTTPS base URLs are accepted.

Total quota is calculated as:

```text
total = remaining + usage.total.actual_cost
```

The Host exposes the same-origin, read-only route `/nbapi-balance/status`. It rejects non-GET and cross-site browser requests and sends `no-store` responses.

## Security boundary

- The API key is resolved and used only by the Host. The browser never receives the API key, credential reference, Authorization header, provider configuration, or upstream response body.
- The Client bundle contains only the local route `/nbapi-balance/status`; it never calls the relay directly.
- Upstream requests use `redirect: 'error'`, preventing an authenticated balance request from following a redirect. Responses still marked `redirected` or carrying a 3xx status are rejected defensively. A fetch implementation that reports rejection only as a generic network `TypeError` is safely classified as `upstream-unavailable`; the plugin does not depend on implementation-private redirect error fields.
- Upstream response bodies are limited to 1 MiB by declared `Content-Length` and by actual streamed byte count. Oversized streams are cancelled immediately and UTF-8 is decoded safely across chunks.
- Public errors are fixed/sanitized and never include credentials or upstream response bodies.
- No credentials, runtime data, or Provider configuration belong in this repository. Tests use only explicit non-secret placeholders.

## UI behavior

- Expanded sidebar (`wide: true`): remaining amount, calculated total, percentage, and progress bar.
- Collapsed sidebar (`wide: false`): compact circular percentage indicator.
- Refreshes on load, once per minute while visible, when the page becomes visible, and on click.
- Concurrent refresh triggers share one request.
- Component cleanup aborts the active browser request; cancellation is not shown as a balance error.
- Keeps the last successful value with a warning marker after a temporary non-cancellation error.
- Green above 30%, yellow from 10% through 30%, red below 10%.

## DSH compatibility surface

The package intentionally depends only on these public interfaces:

### Host

- injected service `settings`, method `settings.get`
- injected service `credentials`, method `credentials.resolve`
- injected service `webServer`, method `webServer.register`

### Client

- injected service `slots`
- `ctx.slots.inject('sidebar.footer.action', ...)`
- `ctx.slots.register(...)`
- public list Slot `sidebar.footer.action`
- Slot owner prop `wide: boolean`

Both faces retain explicit compatibility checks for the methods they call. The Client does not access private Sidebar state.

### Layout compatibility note

The component itself uses the public `wide` prop and owns its wide/rail dimensions. DSH rc.8 renders list-slot entries through a `display: contents` element carrying `data-slot="sidebar.footer.action"`; keeping the existing full-row and vertical-rail arrangement therefore still requires two narrowly scoped `:has()` compatibility rules against that public `data-slot` marker. The selectors do not use built/hash CSS class names and no longer assume a particular parent element tag.

After a DSH upgrade, visually confirm that:

1. expanded NBAPI remains a complete first footer row, with Cordis below it;
2. collapsed NBAPI, Cordis, and Settings remain vertically arranged;
3. click, minute, and visibility refresh still work.

If the renderer changes, inspect the live `sidebar.footer.action` Slot contract and owner props before adjusting these selectors.

## Development, build, and tests

Run commands from this package directory:

```powershell
pnpm bundle
pnpm check
pnpm test
pnpm verify
```

- Source of truth: `src/client-module.js`
- Generated Client artifact tracked by Git: `lib/client.js`
- Host implementation: `lib/index.js`
- Generator: `scripts/build-client.js`

`pnpm verify` rebuilds `lib/client.js`, checks all JavaScript syntax, and runs the full automated suite. The suite also computes the expected artifact with the generator's exact rule and requires byte-for-byte equality.

## Applying changes and validating after a DSH update

Host or Client package changes require restarting the existing DSH Web process, then refreshing `http://127.0.0.1:3080`. Do not start a replacement Vite server: the Web shell depends on the existing `dsh web` boot payload. This plugin does **not** claim HMR; automatic Client rebuilding is available only while `pnpm run dev:web` is actually running from the matching DSH checkout.

After updating DSH:

```powershell
pnpm verify
pnpm.cmd exec dsh --profile web --dump-config
```

Then restart the existing DSH Web process, refresh the GUI, inspect the layout checklist above, and verify:

- `GET /nbapi-balance/status` returns only the documented balance fields;
- a cross-site request returns 403;
- POST returns 405;
- the composed config contains exactly one `nbapi-balance` row.

## Rollback

After the repository has at least one commit, use Git from this package directory to inspect or restore a known-good version:

```powershell
git log --oneline
git restore --source=<known-good-commit> -- .
pnpm verify
```

Restart the existing DSH Web process after restoring. Do not roll back by editing DSH core files or the real Provider configuration.
