import type { BrowserContext, CDPSession, Page } from 'playwright-core'

/**
 * Avoid activating a minimized window. If its state cannot be read, leave it
 * alone; the session can still operate on the selected Page without activation.
 */
export async function isWindowMinimized(page: Page): Promise<boolean> {
  let session: CDPSession | undefined
  try {
    session = await page.context().newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget')
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId })
    return bounds.windowState === 'minimized'
  } catch {
    return true
  } finally {
    await session?.detach().catch(() => {})
  }
}

/**
 * Create a background tab in the caller's browser context. Navigation stays with
 * the caller so URL policy, timeouts and abort handling still apply. An empty
 * context, or a CDP failure, falls back to ordinary page creation.
 */
export async function createBackgroundPage(context: BrowserContext): Promise<Page> {
  const anchor = context.pages()[0]
  if (anchor === undefined) return await context.newPage()
  let session: CDPSession | undefined
  let cleanup = () => {}
  try {
    session = await context.newCDPSession(anchor)
    const { targetInfo } = await session.send('Target.getTargetInfo')
    if (targetInfo.browserContextId === undefined) return await context.newPage()
    // Arm the listener before sending: Playwright attaches as soon as the target
    // exists, which can happen before createTarget resolves.
    let identifyTarget!: (id: string | undefined) => void
    const targetId = new Promise<string | undefined>(resolve => { identifyTarget = resolve })
    const attached = new Promise<Page>((resolve, reject) => {
      const onPage = (page: Page) => {
        void (async () => {
          const expected = await targetId
          if (expected === undefined) return
          const pageSession = await context.newCDPSession(page)
          try {
            const info = await pageSession.send('Target.getTargetInfo')
            if (info.targetInfo.targetId === expected) resolve(page)
          } finally {
            await pageSession.detach().catch(() => {})
          }
        })().catch(reject)
      }
      const timer = setTimeout(() => reject(new Error('background page attachment timed out')), 10000)
      context.on('page', onPage)
      cleanup = () => {
        clearTimeout(timer)
        context.off('page', onPage)
        identifyTarget(undefined)
      }
    })
    // A failed CDP command must not leave an unhandled event-wait rejection.
    void attached.catch(() => {})
    const created = await session.send('Target.createTarget', {
      url: 'about:blank', background: true, browserContextId: targetInfo.browserContextId,
    })
    identifyTarget(created.targetId)
    return await attached
  } catch {
    cleanup()
    return await context.newPage()
  } finally {
    cleanup()
    await session?.detach().catch(() => {})
  }
}

