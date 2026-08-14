/**
 * dsh-browser-playwright: Playwright-powered browser capability for
 * DeepSeek Harness. Snapshot-first interaction with stable element refs,
 * session-scoped browser contexts, screenshots as attachments.
 * @module dsh-browser-playwright
 */

export { BrowserError, launchFailed } from './errors.ts'
export type { BrowserErrorCode } from './errors.ts'
export { SNAPSHOT_SCRIPT } from './injected.ts'
export type { SnapshotOptions, PageDataOptions } from './injected.ts'
export { default as BrowserRuntime } from './service.ts'
export type { BrowserRuntimeConfig } from './service.ts'
export { PlaywrightProvider, assertAllowedUrl, Config as PlaywrightConfigSchema } from './playwright.ts'
export type { PlaywrightConfig, PageData } from './playwright.ts'
export type {
  BrowserNode,
  BrowserProvider,
  BrowserSession,
  BrowserSnapshot,
  LoadState,
  ScreenshotCapture,
  TabInfo,
} from './types.ts'
export type { ToolConfig } from './tool.ts'

