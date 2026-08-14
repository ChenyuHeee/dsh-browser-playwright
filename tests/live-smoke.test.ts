/**
 * Opt-in smoke tests against the real internet. Skipped unless the runner
 * sets DSH_BROWSER_LIVE=1:
 *
 *   DSH_BROWSER_LIVE=1 pnpm test:live
 *
 * Real sites change independently of this repository, so these tests assert
 * only stable facts (status pages, titles, PNG structure) and are meant as
 * a manual gate before releases, not as part of CI.
 * @module dsh-browser-playwright/tests/live-smoke
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'

const LIVE = process.env.DSH_BROWSER_LIVE === '1'

const config: PlaywrightConfig = {
  launch: { channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 }, navigationTimeoutMs: 30000, ignoreHTTPSErrors: false },
  idleTimeoutMs: 0,
  maxSessions: 2,
  snapshot: { maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
}

let provider: PlaywrightProvider | undefined

before(async () => {
  if (!LIVE) return
  provider = new PlaywrightProvider(config)
})

after(async () => {
  await provider?.dispose()
})

test('live: example.com renders, snapshots, and screenshots', { skip: !LIVE }, async () => {
  assert.ok(provider !== undefined)
  const s = await provider.acquire('live-example')
  const snap = await s.navigate('https://example.com/', 'load')
  assert.equal(snap.title, 'Example Domain')
  assert.ok(JSON.stringify(snap).includes('Example Domain'))
  assert.ok(snap.totalRefs >= 1, 'the page should expose at least one ref')

  const shot = await s.screenshot({})
  assert.equal(shot.mime, 'image/png')
  assert.equal(shot.bytes[0], 0x89)
  assert.equal(shot.bytes[1], 0x50)
  assert.ok(shot.bytes.length > 500)
})

test('live: wikipedia REST summary parses through evaluate', { skip: !LIVE }, async () => {
  assert.ok(provider !== undefined)
  const s = await provider.acquire('live-wikipedia')
  await s.navigate('https://en.wikipedia.org/api/rest_v1/page/summary/DeepSeek', 'load')
  // The API returns raw JSON in the document body; evaluate reads it back.
  const summary = await s.evaluate('JSON.parse(document.body.innerText)') as { title?: string; extract?: string }
  assert.equal(summary.title, 'DeepSeek')
  assert.ok(typeof summary.extract === 'string' && summary.extract.length > 20)
})

test('live: example.com rejects disallowed schemes consistently', { skip: !LIVE }, async () => {
  assert.ok(provider !== undefined)
  const s = await provider.acquire('live-policy')
  await assert.rejects(
    s.navigate('data:text/html,<h1>no</h1>', 'load'),
    (err: unknown) => err instanceof Error && String(err.message).includes('http'),
  )
})
