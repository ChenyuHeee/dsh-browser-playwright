import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Page } from 'playwright-core'
import { createBackgroundPage, isWindowMinimized } from '../src/window.ts'

test('window state gates activation and always detaches the CDP session', async () => {
  for (const state of ['minimized', 'normal', 'maximized']) {
    let detached = false
    const page = {
      context: () => ({ newCDPSession: async () => ({
        send: async (method: string) => method === 'Browser.getWindowForTarget'
          ? { windowId: 1 } : { bounds: { windowState: state } },
        detach: async () => { detached = true },
      }) }),
    } as unknown as Page
    assert.equal(await isWindowMinimized(page), state === 'minimized')
    assert.equal(detached, true)
  }
})

test('unreadable window state skips activation and releases the session', async () => {
  let detached = false
  const page = {
    context: () => ({ newCDPSession: async () => ({
      send: async () => { throw new Error('window unavailable') },
      detach: async () => { detached = true },
    }) }),
  } as unknown as Page
  assert.equal(await isWindowMinimized(page), true)
  assert.equal(detached, true)
})

test('background tabs stay in their owner context without falling back or selecting a concurrent popup', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext()
    const other = await browser.newContext()
    const anchor = await context.newPage()
    await other.newPage()
    await context.addCookies([{ name: 'owner', value: 'alice', url: 'https://example.test' }])
    const newPage = context.newPage.bind(context)
    const newCDPSession = context.newCDPSession.bind(context)
    let unrelated: Page | undefined
    let creationParameters: unknown
    context.newPage = async () => { throw new Error('unexpected foreground fallback') }
    context.newCDPSession = async page => {
      const session = await newCDPSession(page)
      const send = session.send.bind(session)
      session.send = (async (method: string, params: unknown) => {
        if (method === 'Target.createTarget') {
          creationParameters = params
          unrelated = await newPage()
        }
        return await send(method as never, params as never)
      }) as typeof session.send
      return session
    }
    const listeners = context.listenerCount('page')
    const page = await createBackgroundPage(context)
    assert.equal(page.context(), context)
    assert.notEqual(page, anchor)
    assert.notEqual(page, unrelated)
    assert.equal(context.pages().length, 3)
    assert.equal(other.pages().length, 1)
    assert.equal((await page.context().cookies('https://example.test'))[0]?.value, 'alice')
    assert.equal((await other.cookies('https://example.test')).length, 0)
    assert.equal((creationParameters as { background: boolean }).background, true)
    assert.equal(context.listenerCount('page'), listeners)
  } finally {
    await browser.close()
  }
})

test('failed background creation falls back and removes its page listener', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext()
    await context.newPage()
    const newCDPSession = context.newCDPSession.bind(context)
    context.newCDPSession = async page => {
      const session = await newCDPSession(page)
      const send = session.send.bind(session)
      session.send = (async (method: string, params: unknown) => {
        if (method === 'Target.createTarget') throw new Error('CDP creation unavailable')
        return await send(method as never, params as never)
      }) as typeof session.send
      return session
    }
    const listeners = context.listenerCount('page')
    const page = await createBackgroundPage(context)
    assert.equal(page.context(), context)
    assert.equal(context.pages().length, 2)
    assert.equal(context.listenerCount('page'), listeners)
  } finally {
    await browser.close()
  }
})

test('an empty context creates its initial page normally', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext()
    const page = await createBackgroundPage(context)
    assert.equal(page.context(), context)
    assert.equal(context.pages().length, 1)
  } finally {
    await browser.close()
  }
})
