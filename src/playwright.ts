/**
 * Playwright provider for the browser capability: owns the browser binary,
 * one context per owner key, idle disposal, and the snapshot engine.
 * @module dsh-browser-playwright/playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import z from '@deepseek-ai/schemastery'
import { BrowserError, launchFailed } from './errors.ts'
// Type-only: makes the ctx.browser declaration merge visible to this module.
import type {} from './service.ts'
import { SNAPSHOT_SCRIPT, type SnapshotOptions } from './injected.ts'
import type {
  BrowserNode,
  BrowserProvider,
  BrowserSession,
  BrowserSnapshot,
  LoadState,
  ScreenshotCapture,
  TabInfo,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-playwright'

/** The browser runtime this provider registers into. */
export const inject = ['browser']

/** Launch configuration for the Playwright provider. */
export interface PlaywrightConfig {
  launch: {
    /** Absolute path to a Chromium-family binary; takes precedence over channel. */
    executablePath?: string
    /** Browser channel: chromium, chrome, msedge, or edge. Omitted = auto-detect in that order. */
    channel?: string
    /** Run headless. Defaults to true. */
    headless: boolean
    viewport: { width: number; height: number }
    /** Per-action navigation/click timeout in milliseconds. */
    navigationTimeoutMs: number
    /** Ignore HTTPS certificate errors. Defaults to false. */
    ignoreHTTPSErrors: boolean
  }
  /** Host suffixes the browser may visit. Empty = any http(s) host. */
  allowedDomains?: string[]
  /** Close an idle session's browser context after this many milliseconds. 0 disables. */
  idleTimeoutMs: number
  /** Maximum concurrent browser contexts. Acquiring beyond it evicts the least recently used. */
  maxSessions: number
  snapshot: {
    /** Maximum nodes in one snapshot tree. */
    maxNodes: number
    /** Maximum characters kept per accessible name. */
    maxNameLength: number
    /** Maximum characters kept per text block. */
    maxTextLength: number
  }
}

/** Schemastery validation for {@link PlaywrightConfig}. */
export const Config: z<PlaywrightConfig> = z.object({
  launch: z.object({
    executablePath: z.string(),
    channel: z.string(),
    headless: z.boolean().default(true),
    viewport: z.object({ width: z.number().default(1280), height: z.number().default(800) }).default({ width: 1280, height: 800 }),
    navigationTimeoutMs: z.number().default(30000),
    ignoreHTTPSErrors: z.boolean().default(false),
  }),
  allowedDomains: z.array(z.string()),
  idleTimeoutMs: z.number().default(600000),
  maxSessions: z.number().default(8),
  snapshot: z.object({
    maxNodes: z.number().default(500),
    maxNameLength: z.number().default(120),
    maxTextLength: z.number().default(300),
  }).default({ maxNodes: 500, maxNameLength: 120, maxTextLength: 300 }),
})

/** Bounded page data the extraction consumer feeds to a model. */
export interface PageData {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly links: readonly { readonly text: string; readonly href: string }[]
  readonly inputs: readonly {
    readonly tag: string
    readonly type: string
    readonly name: string
    readonly value: string
    readonly label: string
    readonly checked: boolean | null
  }[]
}

/** Channels probed in order when none is configured. */
const AUTO_CHANNELS = ['chromium', 'chrome', 'msedge', 'edge'] as const

const REF_PATTERN = /^e[0-9]+$/

/** One session fleet entry owned by an owner key. */
interface FleetEntry {
  readonly context: BrowserContext
  readonly session: PlaywrightSession
  lastUsed: number
  timer: NodeJS.Timeout | undefined
}

/**
 * Register this provider on the browser runtime for the plugin's lifetime.
 * @param ctx - plugin context carrying the browser runtime.
 * @param config - launch and fleet configuration.
 */
export function apply(ctx: Context, config: PlaywrightConfig): void {
  ctx.browser.registerProvider(new PlaywrightProvider(config))
}

/** Validate one absolute URL against the navigation policy. */
export function assertAllowedUrl(raw: string, allowedDomains: readonly string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new BrowserError('URL_NOT_ALLOWED', 'invalid URL: ' + raw)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserError('URL_NOT_ALLOWED', 'only http(s) URLs can be navigated, got: ' + parsed.protocol)
  }
  if (allowedDomains.length > 0) {
    const host = parsed.hostname.toLowerCase()
    const allowed = allowedDomains.some(suffix => host === suffix || host.endsWith('.' + suffix))
    if (!allowed) {
      throw new BrowserError('URL_NOT_ALLOWED', 'host ' + parsed.hostname + ' is not in allowedDomains')
    }
  }
  return parsed
}

/** Wrap a Playwright op so an aborted signal rejects while the op keeps draining in the background. */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      reason => { signal.removeEventListener('abort', onAbort); reject(reason) },
    )
  })
}

/**
 * Playwright-backed {@link BrowserProvider}: one shared browser, one context
 * per owner key, LRU eviction, idle disposal, ref-based snapshot interaction.
 */
export class PlaywrightProvider implements BrowserProvider {
  readonly id = 'playwright'

  private browser: Browser | undefined
  private readonly entries = new Map<string, FleetEntry>()
  private launchError: unknown | undefined

  constructor(readonly config: PlaywrightConfig) {}

  available(): boolean {
    return true
  }

  async acquire(owner: string): Promise<BrowserSession> {
    const existing = this.entries.get(owner)
    if (existing) {
      existing.lastUsed = Date.now()
      this.armIdle(existing)
      return existing.session
    }
    const browser = await this.ensureBrowser()
    while (this.entries.size >= this.config.maxSessions) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (oldest === undefined) break
      await this.disposeOwner(oldest[0])
    }
    const context = await browser.newContext({
      viewport: this.config.launch.viewport,
      ignoreHTTPSErrors: this.config.launch.ignoreHTTPSErrors,
    })
    await context.addInitScript(SNAPSHOT_SCRIPT)
    const session = new PlaywrightSession(this, owner, context)
    const entry: FleetEntry = { context, session, lastUsed: Date.now(), timer: undefined }
    this.entries.set(owner, entry)
    this.armIdle(entry)
    void context.on('close', () => {
      if (this.entries.get(owner) === entry) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        this.entries.delete(owner)
      }
    })
    return session
  }

  async disposeOwner(owner: string): Promise<void> {
    const entry = this.entries.get(owner)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.entries.delete(owner)
    await entry.context.close().catch(() => { /* closing an already-closed context */ })
  }

  async dispose(): Promise<void> {
    const owners = [...this.entries.keys()]
    for (const owner of owners) await this.disposeOwner(owner)
    if (this.browser !== undefined) {
      await this.browser.close().catch(() => { /* already closed */ })
      this.browser = undefined
    }
  }

  /** Touch the entry's last-used clock and re-arm its idle timer. */
  touch(owner: string): void {
    const entry = this.entries.get(owner)
    if (entry === undefined) return
    entry.lastUsed = Date.now()
    this.armIdle(entry)
  }

  /** Ensure the session entry for an owner still exists. */
  isLive(owner: string): boolean {
    return this.entries.has(owner)
  }

  private armIdle(entry: FleetEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    const idle = this.config.idleTimeoutMs
    if (idle <= 0) return
    entry.timer = setTimeout(() => {
      void this.disposeOwner(entry.session.owner)
    }, idle)
    entry.timer.unref?.()
  }

  /** Launch the browser once, probing the configured or auto-detected channel. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser !== undefined) return this.browser
    const { executablePath, channel, headless } = this.config.launch
    const attempts: string[] = []
    if (executablePath !== undefined) {
      try {
        this.browser = await chromium.launch({ executablePath, headless })
        return this.browser
      } catch (error: unknown) {
        this.launchError = error
        attempts.push('executablePath ' + executablePath)
      }
    } else {
      const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS]
      for (const candidate of channels) {
        try {
          this.browser = await chromium.launch({ channel: candidate, headless })
          return this.browser
        } catch (error: unknown) {
          this.launchError = error
          attempts.push('channel ' + candidate)
        }
      }
    }
    const hint = 'Tried: ' + attempts.join(', ') + '. '
      + 'Install a Chromium-family browser, or run: npx playwright-core install chromium '
      + '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), '
      + 'or configure launch.channel / launch.executablePath.'
    if (this.launchError instanceof Error && /executable doesn't exist|not found/i.test(this.launchError.message)) {
      throw new BrowserError('NO_BROWSER', hint)
    }
    throw launchFailed(this.launchError)
  }
}

/** Serialize a Playwright timeout into a stable browser error. */
function asTimeoutError(kind: 'navigation' | 'action', cause: unknown): BrowserError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (kind === 'navigation') return new BrowserError('NAVIGATION_TIMEOUT', 'the browser operation timed out: ' + detail)
  return new BrowserError('ACTION_TIMEOUT', 'the browser action timed out: ' + detail)
}

/** Live session over one browser context owned by one caller. */
class PlaywrightSession implements BrowserSession {
  private currentIndex = 0
  private closed = false

  constructor(
    private readonly provider: PlaywrightProvider,
    readonly owner: string,
    private readonly context: BrowserContext,
  ) {}

  async navigate(url: string, waitUntil: LoadState, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const target = assertAllowedUrl(url, this.provider.config.allowedDomains ?? [])
    const page = await this.ensurePage()
    try {
      await withAbort(page.goto(target.toString(), { waitUntil, timeout: this.timeoutMs() }), signal)
    } catch (error: unknown) {
      if (isAbortError(error) || (signal?.aborted === true)) throw error
      throw asTimeoutError('navigation', error)
    }
    return this.snapshot()
  }

  async snapshot(opts?: { readonly interactiveOnly?: boolean }): Promise<BrowserSnapshot> {
    this.assertLive()
    const page = await this.ensurePage()
    this.provider.touch(this.owner)
    const o: SnapshotOptions = {
      ...(opts?.interactiveOnly !== undefined ? { interactiveOnly: opts.interactiveOnly } : {}),
      maxNodes: this.provider.config.snapshot.maxNodes,
      maxNameLength: this.provider.config.snapshot.maxNameLength,
      maxTextLength: this.provider.config.snapshot.maxTextLength,
    }
    const raw = await page.evaluate((options: SnapshotOptions) => {
      const fn = (window as unknown as { __dshSnapshot?: (o: unknown) => unknown }).__dshSnapshot
      if (typeof fn !== 'function') return { nodes: [], truncated: false, totalRefs: 0, missing: true }
      return fn(options)
    }, o) as { nodes: BrowserNode[]; truncated: boolean; totalRefs: number; missing?: boolean }
    return {
      url: page.url(),
      title: await page.title(),
      nodes: raw.nodes ?? [],
      totalRefs: raw.totalRefs ?? 0,
      truncated: raw.truncated ?? false,
    }
  }

  async click(ref: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const locator = this.refLocator(ref)
    try {
      await withAbort(locator.click({ timeout: this.timeoutMs() }), signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('action', error)
    }
    return this.snapshot()
  }

  async fill(ref: string, text: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const locator = this.refLocator(ref)
    try {
      const tag = await locator.evaluate(el => el.tagName.toLowerCase())
      if (tag === 'select') {
        await withAbort(locator.selectOption({ label: text }, { timeout: this.timeoutMs() }), signal)
      } else {
        await withAbort(locator.fill(text, { timeout: this.timeoutMs() }), signal)
      }
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('action', error)
    }
    return this.snapshot()
  }

  async press(ref: string, key: string, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const locator = this.refLocator(ref)
    try {
      await withAbort(locator.press(key, { timeout: this.timeoutMs() }), signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('action', error)
    }
    return this.snapshot()
  }

  async scroll(direction: 'up' | 'down', amount: number, ref: string | undefined, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const page = await this.ensurePage()
    try {
      if (ref !== undefined) {
        await withAbort(this.refLocator(ref).scrollIntoViewIfNeeded({ timeout: this.timeoutMs() }), signal)
      }
      const delta = direction === 'down' ? amount : -amount
      await withAbort(page.mouse.wheel(0, delta), signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('action', error)
    }
    return this.snapshot()
  }

  async back(signal?: AbortSignal): Promise<BrowserSnapshot> {
    const page = await this.ensurePage()
    try {
      await withAbort(page.goBack({ timeout: this.timeoutMs() }), signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('navigation', error)
    }
    return this.snapshot()
  }

  async forward(signal?: AbortSignal): Promise<BrowserSnapshot> {
    const page = await this.ensurePage()
    try {
      await withAbort(page.goForward({ timeout: this.timeoutMs() }), signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('navigation', error)
    }
    return this.snapshot()
  }

  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    this.provider.touch(this.owner)
    await withAbort(new Promise<void>(resolve => setTimeout(resolve, ms)), signal)
  }

  async tabs(): Promise<readonly TabInfo[]> {
    this.assertLive()
    this.provider.touch(this.owner)
    const pages = this.context.pages()
    const out: TabInfo[] = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      if (page === undefined) continue
      out.push({ index, url: page.url(), title: await page.title() })
    }
    return out
  }

  async switchTab(index: number, signal?: AbortSignal): Promise<BrowserSnapshot> {
    this.assertLive()
    const page = this.pageAt(index)
    if (page === undefined) throw new BrowserError('REF_NOT_FOUND', 'no tab at index ' + String(index))
    this.currentIndex = index
    await withAbort(page.bringToFront(), signal)
    return this.snapshot()
  }

  async openTab(url: string, waitUntil: LoadState, signal?: AbortSignal): Promise<BrowserSnapshot> {
    this.assertLive()
    const target = assertAllowedUrl(url, this.provider.config.allowedDomains ?? [])
    const page = await this.context.newPage()
    this.currentIndex = this.context.pages().length - 1
    try {
      await withAbort(page.goto(target.toString(), { waitUntil, timeout: this.timeoutMs() }), signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw asTimeoutError('navigation', error)
    }
    return this.snapshot()
  }

  async closeTab(index: number, signal?: AbortSignal): Promise<void> {
    this.assertLive()
    const pages = this.context.pages()
    const page = pages[index]
    if (page === undefined) throw new BrowserError('REF_NOT_FOUND', 'no tab at index ' + String(index))
    if (pages.length <= 1) {
      await withAbort(page.goto('about:blank'), signal)
      return
    }
    await withAbort(page.close(), signal)
    this.currentIndex = Math.min(this.currentIndex, this.context.pages().length - 1)
  }

  async screenshot(opts: { readonly fullPage?: boolean; readonly ref?: string } | undefined, signal?: AbortSignal): Promise<ScreenshotCapture> {
    this.assertLive()
    this.provider.touch(this.owner)
    const page = await this.ensurePage()
    if (opts?.ref !== undefined) {
      const bytes = await withAbort(this.refLocator(opts.ref).screenshot({ type: 'png', timeout: this.timeoutMs() }), signal)
      return { mime: 'image/png', bytes }
    }
    const bytes = await withAbort(page.screenshot({ type: 'png', fullPage: opts?.fullPage ?? false, animations: 'disabled', caret: 'hide', timeout: this.timeoutMs() }), signal)
    return { mime: 'image/png', bytes }
  }

  async pageData(): Promise<PageData> {
    this.assertLive()
    this.provider.touch(this.owner)
    const page = await this.ensurePage()
    const data = await page.evaluate(() => {
      const fn = (window as unknown as { __dshPageData?: (o: unknown) => unknown }).__dshPageData
      if (typeof fn !== 'function') return { url: location.href, title: document.title, text: '', truncated: false, links: [], inputs: [] }
      return fn({ maxTextChars: 30000, maxLinks: 300, maxInputs: 200 })
    })
    return data as PageData
  }

  async evaluate(expression: string, signal?: AbortSignal): Promise<unknown> {
    this.assertLive()
    this.provider.touch(this.owner)
    const page = await this.ensurePage()
    const fn = new Function('return (' + expression + ')') as () => unknown
    return withAbort(page.evaluate(fn), signal)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.provider.disposeOwner(this.owner)
  }

  private timeoutMs(): number {
    return this.provider.config.launch.navigationTimeoutMs
  }

  private async ensurePage(): Promise<Page> {
    this.assertLive()
    const pages = this.context.pages()
    if (pages.length === 0) {
      const created = await this.context.newPage()
      this.currentIndex = 0
      return created
    }
    this.currentIndex = Math.min(this.currentIndex, pages.length - 1)
    const page = pages[this.currentIndex] ?? pages[0]
    if (page === undefined) {
      const created = await this.context.newPage()
      this.currentIndex = 0
      return created
    }
    return page
  }

  private pageAt(index: number): Page | undefined {
    return this.context.pages()[index]
  }

  private refLocator(ref: string): import('playwright-core').Locator {
    this.assertLive()
    if (!REF_PATTERN.test(ref)) {
      throw new BrowserError('REF_NOT_FOUND', 'invalid ref ' + JSON.stringify(ref) + ': use a ref from the latest browser_snapshot')
    }
    return this.currentPageSync().locator('[data-dsh-ref="' + ref + '"]').first()
  }

  private currentPageSync(): Page {
    const pages = this.context.pages()
    const page = pages[Math.min(this.currentIndex, Math.max(0, pages.length - 1))]
    if (page === undefined) throw new BrowserError('SESSION_CLOSED', 'the browser session has no open page')
    return page
  }

  private assertLive(): void {
    if (this.closed || !this.provider.isLive(this.owner)) {
      throw new BrowserError('SESSION_CLOSED', 'the browser session is closed; the next browser call opens a fresh one')
    }
  }
}

/** Whether an error is a caller-initiated abort, which must propagate untouched. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
