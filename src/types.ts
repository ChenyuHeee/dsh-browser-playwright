/**
 * Domain types for the browser capability: snapshots, sessions, providers.
 * @module dsh-browser-playwright/types
 */

/** Page load condition a navigation waits for. */
export type LoadState = 'load' | 'domcontentloaded' | 'networkidle'

/** One snapshot element. Refs identify actionable elements for later calls. */
export interface BrowserNode {
  /** Accessible role, e.g. link, button, textbox, heading. */
  readonly role: string
  /** Accessible-ish name; empty when the element has none. */
  readonly name: string
  /** Stable per-snapshot reference; present only on actionable elements. */
  readonly ref?: string
  /** Heading level (1-6); present only for headings. */
  readonly level?: number
  /** Whether a checkbox/radio is checked. */
  readonly checked?: boolean
  /** Whether an option is selected. */
  readonly selected?: boolean
  /** Whether the element is disabled. */
  readonly disabled?: boolean
  /** Href for links; present when the page is same-origin. */
  readonly href?: string
  readonly children: readonly BrowserNode[]
}

/** Bounded accessibility snapshot of the current page. */
export interface BrowserSnapshot {
  readonly url: string
  readonly title: string
  readonly nodes: readonly BrowserNode[]
  /** Total refs assigned before any truncation. */
  readonly totalRefs: number
  /** True when node or text caps cut the tree short. */
  readonly truncated: boolean
}

/** One open tab in the browser session. */
export interface TabInfo {
  readonly index: number
  readonly url: string
  readonly title: string
}

/** PNG capture of a page or element. */
export interface ScreenshotCapture {
  readonly mime: 'image/png'
  readonly bytes: Uint8Array
}

/**
 * Live browser session owned by one caller (a harness session id).
 * Providers manage the underlying browser contexts; callers only drive.
 */
export interface BrowserSession {
  /** Opaque owner key supplied at acquisition. */
  readonly owner: string
  /** Navigate the active page and return the post-navigation snapshot. */
  navigate(url: string, waitUntil: LoadState, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Snapshot the active page without changing it. */
  snapshot(opts?: { readonly interactiveOnly?: boolean }): Promise<BrowserSnapshot>
  /** Click the element referenced by the latest snapshot. */
  click(ref: string, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Replace the referenced input's value and return the new snapshot. */
  fill(ref: string, text: string, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Press a keyboard key on the referenced element. */
  press(ref: string, key: string, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Scroll the page, or the referenced scrollable, by the given amount. */
  scroll(direction: 'up' | 'down', amount: number, ref: string | undefined, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** History back. */
  back(signal?: AbortSignal): Promise<BrowserSnapshot>
  /** History forward. */
  forward(signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Wait a bounded duration, letting lazy content arrive. */
  wait(ms: number, signal?: AbortSignal): Promise<void>
  /** List open tabs. */
  tabs(): Promise<readonly TabInfo[]>
  /** Activate the tab at the given index. */
  switchTab(index: number, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Open a new tab and navigate it. */
  openTab(url: string, waitUntil: LoadState, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Close the tab at the given index; the last tab resets to a blank page. */
  closeTab(index: number, signal?: AbortSignal): Promise<void>
  /** Capture a PNG of the page or referenced element. */
  screenshot(opts: { readonly fullPage?: boolean; readonly ref?: string } | undefined, signal?: AbortSignal): Promise<ScreenshotCapture>
  /** Extract the page's bounded data: text, links, forms, frames. */
  pageData(): Promise<unknown>
  /** Evaluate one JavaScript expression and return its JSON result. */
  evaluate(expression: string, signal?: AbortSignal): Promise<unknown>
  /** Close the session; the provider forgets its browser context. */
  close(): Promise<void>
}

/**
 * One browser-capability implementation. Providers own browser binaries,
 * context fleets, and lifecycle; the runtime selects exactly one.
 */
export interface BrowserProvider {
  /** Stable unique provider id. */
  readonly id: string
  /** Whether this provider can currently serve sessions. */
  available(): boolean
  /** Acquire or reuse the session owned by the owner key. */
  acquire(owner: string, signal?: AbortSignal): Promise<BrowserSession>
  /** Release the session owned by the owner key and its browser resources. */
  disposeOwner(owner: string): Promise<void>
  /** Release every session and the browser itself. */
  dispose(): Promise<void>
}
