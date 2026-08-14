import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'
import { BrowserError } from '../src/errors.ts'
import type { BrowserNode } from '../src/types.ts'

const config: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 2500,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 4,
  snapshot: { maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
}

let server: Server
let base: string
let provider: PlaywrightProvider

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><head><title>Page A</title></head><body><h1>Page A</h1><button>On A</button></body></html>')
      return
    }
    const body = await readFile(new URL('./fixtures/page.html', import.meta.url), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = 'http://127.0.0.1:' + String(address.port)
  provider = new PlaywrightProvider(config)
})

after(async () => {
  await provider.dispose()
  await new Promise<void>((resolve, reject) => server.close(err => err === undefined ? resolve() : reject(err)))
})

test('snapshot captures roles, names, and refs and hides invisible nodes', async () => {
  const s = await provider.acquire('t-snapshot')
  const snap = await s.navigate(base + '/page.html', 'load')
  assert.equal(snap.title, 'Fixture Store')
  assert.ok(snap.totalRefs >= 5)
  const text = JSON.stringify(snap)
  assert.match(text, /heading/)
  assert.match(text, /Fixture Store/)
  assert.doesNotMatch(text, /invisible secret/)
  assert.ok(snap.nodes.some(node => node.role === 'heading' && node.name === 'Fixture Store'))
})

test('click by ref updates the page and the next snapshot', async () => {
  const s = await provider.acquire('t-click')
  await s.navigate(base + '/page.html', 'load')
  const snap1 = await s.snapshot()
  const button = findRef(snap1.nodes, (node) => node.role === 'button' && node.name === 'Count clicks')
  assert.ok(button !== undefined, 'count button ref missing')
  const snap2 = await s.click(button)
  assert.match(JSON.stringify(snap2), /clicks: 1/)
})

test('fill, then click submit, carries the typed value', async () => {
  const s = await provider.acquire('t-fill')
  await s.navigate(base + '/page.html', 'load')
  const input = findRef((await s.snapshot()).nodes, (node) => node.role === 'textbox')
  assert.ok(input !== undefined)
  await s.fill(input, 'hello dsh')
  const submit = findRef((await s.snapshot()).nodes, (node) => node.role === 'button' && node.name === 'Go')
  assert.ok(submit !== undefined)
  const snap = await s.click(submit)
  assert.match(JSON.stringify(snap), /submitted: hello dsh/)
})

test('select fill picks the option label', async () => {
  const s = await provider.acquire('t-select')
  await s.navigate(base + '/page.html', 'load')
  const combo = findRef((await s.snapshot()).nodes, (node) => node.role === 'combobox')
  assert.ok(combo !== undefined)
  await s.fill(combo, 'Chinese')
  const snap = await s.snapshot({ interactiveOnly: true })
  assert.match(JSON.stringify(snap), /"selected":true/)
  assert.match(JSON.stringify(snap), /Chinese/)
})

test('checkbox click toggles the checked flag', async () => {
  const s = await provider.acquire('t-checkbox')
  await s.navigate(base + '/page.html', 'load')
  const box = findRef((await s.snapshot()).nodes, (node) => node.role === 'checkbox')
  assert.ok(box !== undefined)
  const after = await s.click(box)
  assert.match(JSON.stringify(after), /"checked":true/)
})

test('history back returns to the previous page', async () => {
  const s = await provider.acquire('t-history')
  await s.navigate(base + '/page.html', 'load')
  await s.navigate(base + '/a', 'load')
  assert.equal((await s.snapshot()).title, 'Page A')
  const back = await s.back()
  assert.equal(back.title, 'Fixture Store')
})

test('screenshot returns PNG bytes', async () => {
  const s = await provider.acquire('t-shot')
  await s.navigate(base + '/page.html', 'load')
  const shot = await s.screenshot({})
  assert.equal(shot.mime, 'image/png')
  assert.ok(shot.bytes.length > 100)
  assert.equal(shot.bytes[0], 0x89)
  assert.equal(shot.bytes[1], 0x50)
})

test('tabs: open, list, switch, close', async () => {
  const s = await provider.acquire('t-tabs')
  await s.navigate(base + '/page.html', 'load')
  await s.openTab(base + '/a', 'load')
  const tabs = await s.tabs()
  assert.equal(tabs.length, 2)
  assert.equal(tabs[1]?.title, 'Page A')
  const switched = await s.switchTab(0)
  assert.equal(switched.title, 'Fixture Store')
  await s.closeTab(1)
  assert.equal((await s.tabs()).length, 1)
})

test('pageData collects text, links, and inputs', async () => {
  const s = await provider.acquire('t-data')
  await s.navigate(base + '/page.html', 'load')
  const data = await s.pageData()
  const d = data as { text: string; links: { text: string }[]; inputs: { name: string }[] }
  assert.match(d.text, /Fixture Store/)
  assert.ok(d.links.some(link => link.text === 'Page A'))
  assert.ok(d.inputs.some(input => input.name === 'q'))
})

test('evaluate runs one expression and returns JSON', async () => {
  const s = await provider.acquire('t-eval')
  await s.navigate(base + '/page.html', 'load')
  assert.equal(await s.evaluate('document.title'), 'Fixture Store')
  assert.equal(await s.evaluate('document.querySelectorAll("li").length'), 3)
})

test('wait resolves within the bound', async () => {
  const s = await provider.acquire('t-wait')
  await s.navigate(base + '/page.html', 'load')
  const started = Date.now()
  await s.wait(60)
  assert.ok(Date.now() - started >= 50)
})

test('navigation policy rejects non-http URLs', async () => {
  const s = await provider.acquire('t-policy')
  await assert.rejects(
    s.navigate('file:///etc/hosts', 'load'),
    (err: unknown) => err instanceof BrowserError && err.code === 'URL_NOT_ALLOWED',
  )
})

test('invalid refs fail fast with REF_NOT_FOUND', async () => {
  const s = await provider.acquire('t-ref')
  await s.navigate(base + '/page.html', 'load')
  await assert.rejects(
    s.click('x42'),
    (err: unknown) => err instanceof BrowserError && err.code === 'REF_NOT_FOUND',
  )
})

test('sessions are isolated per owner and disposal forgets the context', async () => {
  const a = await provider.acquire('t-iso-a')
  await a.navigate(base + '/page.html', 'load')
  const b = await provider.acquire('t-iso-b')
  assert.equal((await b.snapshot()).url, 'about:blank')
  await a.close()
  await assert.rejects(
    a.snapshot(),
    (err: unknown) => err instanceof BrowserError && err.code === 'SESSION_CLOSED',
  )
  // A fresh acquire starts a new blank session.
  const a2 = await provider.acquire('t-iso-a')
  assert.equal((await a2.snapshot()).url, 'about:blank')
  await a2.close()
})

/** Depth-first search for the first node matching the predicate, returning its ref. */
function findRef(nodes: readonly BrowserNode[], match: (node: BrowserNode) => boolean): string | undefined {
  for (const node of nodes) {
    if (match(node) && node.ref !== undefined) return node.ref
    const found = findRef(node.children, match)
    if (found !== undefined) return found
  }
  return undefined
}
