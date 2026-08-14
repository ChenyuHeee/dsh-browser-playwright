# dsh-browser-playwright

Playwright-powered browser capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent drives a real browser through **accessibility snapshots with stable element refs** — no CSS-selector guessing, no full-DOM dumps. One browser session per harness session, tabs, screenshots as durable image attachments, structured extraction, and gated JavaScript evaluation.

## Install

```sh
dsh plugin --profile <name> add dsh-browser-playwright
```

The bundle mounts three rows: the `ctx.browser` seam (`service`), the Playwright provider (`playwright`), and the model-facing tool family (`tool`).

### Browser binary

The provider probes `chromium` → `chrome` → `msedge` → `edge` channels automatically; any installed Chromium-family browser works with **zero download**. To use Playwright-managed Chromium instead:

```sh
npx playwright-core install chromium
# Restricted networks (e.g. mainland China):
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright-core install chromium
```

Or pin a binary: `launch.executablePath` / `launch.channel` in the plugin config.

## Tools

The default `toolPrefix` is `browser_`. Every action returns a fresh snapshot, so refs always come from the latest result.

| Tool | Purpose |
|---|---|
| `browser_navigate` | Open a URL (http/https only) and return the snapshot |
| `browser_snapshot` | Snapshot the current page: URL, title, visible elements with `ref=` ids |
| `browser_click` | Click the element with a ref from the latest snapshot |
| `browser_fill` | Replace an input's value; selects match by option label |
| `browser_press` | Press a key (Enter, Tab, Escape, ArrowDown, …) on an element |
| `browser_scroll` | Scroll the page or bring a ref into view |
| `browser_back` / `browser_forward` | History navigation |
| `browser_wait` | Wait a bounded duration for lazy content |
| `browser_tabs` / `browser_open_tab` / `browser_switch_tab` / `browser_close_tab` | Tab management |
| `browser_screenshot` | PNG capture stored as a durable image attachment the model can view |
| `browser_extract` | Structured extraction: natural-language instruction → one parsed JSON value |
| `browser_evaluate` | Run one JavaScript expression in the page (disabled by default) |
| `browser_close` | Close the session's browser; the next call opens a fresh one |

### Snapshot example

```text
URL: https://example.com/
Title: Example Domain
Refs: 12

- navigation "Main"
  - link "Home" [ref=e1] -> /
  - button "Go" [ref=e2]
- heading "Welcome" [level=1]
- textbox "Search" [ref=e3]
```

The model then calls `browser_click` with `ref: e2`. Invisible content is excluded, node and text caps bound the token cost, and truncation is flagged in the result.

## Configuration

All tunables are patchable through the profile's `cordis.patch.yml` (later layers win per row).

```yaml
- id: browser
  config:
    provider: playwright                # explicit provider selection

- id: browser-playwright
  config:
    launch:
      channel: chrome                   # or chromium / msedge / edge
      headless: true
      viewport: { width: 1280, height: 800 }
      navigationTimeoutMs: 30000
      ignoreHTTPSErrors: false
    allowedDomains: []                  # e.g. ['github.com'] restricts navigation
    idleTimeoutMs: 600000               # close idle contexts after 10 min; 0 = never
    maxSessions: 8                      # LRU eviction beyond this
    snapshot:
      maxNodes: 500                     # token budget per snapshot tree
      maxNameLength: 120
      maxTextLength: 300

- id: browser-tool
  config:
    toolPrefix: browser_                # model-facing tool name prefix
    allowEvaluate: false                # browser_evaluate gate
    maxWaitMs: 60000                    # browser_wait bound
    extract:
      provider: deepseek-official       # optional: enables browser_extract
      model: deepseek-v4-flash
      maxInputChars: 20000
      maxOutputTokens: 2000
```

`browser_extract` needs an auxiliary LLM route (`extract.provider` + `extract.model`); without one it fails with an actionable error. `browser_evaluate` stays off until `allowEvaluate: true` because it executes arbitrary page JavaScript.

## Architecture

A swappable capability seam, one package:

- `service` — `ctx.browser`: the provider registry with configured-or-auto selection semantics (a configured id must exist; one usable provider auto-selects; several require an explicit choice).
- `playwright` — the provider: one shared browser, one `BrowserContext` per calling session, LRU eviction, idle disposal, URL policy, and the injected snapshot engine.
- `tool` — the consumer: `defineTool`-built tools whose canonical values are structured JSON and whose rendered text is the snapshot tree.

Other providers (remote browsers, Browserbase, Steel, …) can register into `ctx.browser`; the tool schemas stay unchanged. Browser sessions survive across tool calls and keep cookies, storage, and login state within one harness session.

## Development

```sh
pnpm install
pnpm test          # 24 tests: engine/action integration on real Chrome, policy, rendering, schema assembly
pnpm run build     # tsc → lib/
```

From a DeepSeek Harness source checkout, load this plugin from TypeScript:

```sh
pnpm dsh web --patch ./browser-plugin/dev.cordis.yml
```

## Model Experience

### Tool schemas

The 17 tool schemas join the system-prompt assembly through `ctx.tools.register()`; each carries a one-line task-oriented description. Snapshot results are bounded: at most `maxNodes` nodes, names capped at `maxNameLength`, and the truncation flag is explicit.

#### Token effect

One tool schema block per tool (small, fixed), plus per-call result text proportional to the visible page, capped by `snapshot.maxNodes` and name/text limits. Actions return a fresh snapshot, so interactive flows cost roughly one snapshot per step.

#### KV Cache effect

Tool schemas are static per registration and keep the prompt prefix stable. Result content varies with the page, invalidating reuse after each browser tool call, as with any tool result.

### Browser state

The page state itself (DOM, cookies, storage) lives in the browser context and never enters the prompt except through snapshot or page-data results.

## Known Limitations and Deferred Work

- **Selector-free, not vision-free** — interaction is a11y-tree based; purely visual widgets (canvas, WebGL, custom-drawn controls) may expose no refs. `browser_screenshot` + an image-capable model is the fallback.
- **Cross-origin iframes** appear as leaf `(frame)` nodes without refs; same-origin frames are walked up to two levels deep.
- **Evaluate gate is config, not approval** — enabling `allowEvaluate` trusts the model with arbitrary page JavaScript; compose it with the harness approval/permission policy for stricter control.
- **Chromium family only** — Firefox/WebKit channels are not probed; providers are swappable if another engine is needed.
- **Extract needs a dedicated model route** — it does not reuse the main request's route; misconfiguration fails loudly at call time.

## License

MIT
