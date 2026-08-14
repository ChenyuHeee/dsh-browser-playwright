/**
 * Realistic end-to-end scenarios for dsh-browser-playwright, driven exactly the
 * way an agent drives the capability: snapshot → find ref → act → snapshot.
 * Each test is a scripted agent journey over the store fixture (a realistic
 * mini e-commerce app with search, cart, coupons, checkout validation, login,
 * lazy content, infinite scroll, dialogs, and popups).
 * @module dsh-browser-playwright/tests/scenarios
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'
import { BrowserError } from '../src/errors.ts'
import type { BrowserNode, BrowserSession, BrowserSnapshot } from '../src/types.ts'
import { startStoreServer, CATALOG, COUPON, totalOf, type CartItem, type StoreFixture } from './fixtures/store-server.ts'

// ---------------------------------------------------------------------------
// Fixtures and providers
// ---------------------------------------------------------------------------

function providerConfig(overrides: Partial<PlaywrightConfig> = {}): PlaywrightConfig {
  const { launch, snapshot, ...rest } = overrides
  return {
    launch: {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1280, height: 800 },
      navigationTimeoutMs: 2500,
      ignoreHTTPSErrors: false,
      ...launch,
    },
    idleTimeoutMs: 0,
    maxSessions: 6,
    snapshot: { maxNodes: 500, maxNameLength: 120, maxTextLength: 300, ...snapshot },
    ...rest,
  }
}

let store: StoreFixture
let provider: PlaywrightProvider
let policyProvider: PlaywrightProvider
let boundedProvider: PlaywrightProvider
let idleProvider: PlaywrightProvider

before(async () => {
  store = await startStoreServer()
  provider = new PlaywrightProvider(providerConfig())
  // allowedDomains pins browsing to 127.0.0.1; the storefront footer links to
  // the same server through the localhost hostname so we can exercise policy.
  policyProvider = new PlaywrightProvider(providerConfig({ allowedDomains: ['127.0.0.1'] }))
  // Tiny token budgets exercise the truncation path on real pages.
  boundedProvider = new PlaywrightProvider(providerConfig({ snapshot: { maxNodes: 60, maxNameLength: 20, maxTextLength: 60 } }))
  // A very short idle timer exercises real session disposal. In-flight
  // operations are protected by busy tracking, so no warmup is needed: even
  // a slow first navigation survives the idle window.
  idleProvider = new PlaywrightProvider(providerConfig({ idleTimeoutMs: 500 }))
})

after(async () => {
  await Promise.all([provider.dispose(), policyProvider.dispose(), boundedProvider.dispose(), idleProvider.dispose()])
  await store.close()
})

// ---------------------------------------------------------------------------
// Agent-style helpers: the same read-act loop a model performs
// ---------------------------------------------------------------------------

interface NodeMatch {
  role?: string
  name?: string
  ref?: boolean
  disabled?: boolean
}

function walk(nodes: readonly BrowserNode[], visit: (node: BrowserNode) => void): void {
  for (const node of nodes) {
    visit(node)
    walk(node.children, visit)
  }
}

function matches(node: BrowserNode, match: NodeMatch): boolean {
  if (match.role !== undefined && node.role !== match.role) return false
  if (match.name !== undefined && node.name !== match.name) return false
  if (match.ref === true && node.ref === undefined) return false
  if (match.disabled !== undefined && node.disabled !== match.disabled) return false
  return true
}

function findNode(nodes: readonly BrowserNode[], match: NodeMatch): BrowserNode | undefined {
  for (const node of nodes) {
    if (matches(node, match)) return node
    const found = findNode(node.children, match)
    if (found !== undefined) return found
  }
  return undefined
}

function countNodes(nodes: readonly BrowserNode[], match: NodeMatch): number {
  let count = 0
  walk(nodes, node => {
    if (matches(node, match)) count += 1
  })
  return count
}

function flatCount(nodes: readonly BrowserNode[]): number {
  let count = 0
  walk(nodes, () => { count += 1 })
  return count
}

/** Ref from the latest snapshot, failing loudly when the page changed. */
async function refOf(session: BrowserSession, match: NodeMatch, label: string): Promise<string> {
  const snap = await session.snapshot()
  const found = findNode(snap.nodes, match)
  assert.ok(found !== undefined, 'ref not found: ' + label + ' — page: ' + snap.url)
  assert.ok(found.ref !== undefined, 'node has no ref: ' + label)
  return found.ref
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Poll snapshots until a condition holds — the agent's wait+snapshot loop. */
async function waitFor(
  session: BrowserSession,
  condition: (snap: BrowserSnapshot) => boolean,
  label: string,
  timeoutMs = 8000,
  intervalMs = 150,
): Promise<BrowserSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last: BrowserSnapshot | undefined
  let lastError: unknown
  for (;;) {
    try {
      last = await session.snapshot()
      if (condition(last)) return last
    } catch (error) {
      // A snapshot can race an in-flight JS navigation ('Execution context
      // was destroyed'). The agent loop retries failed tool calls, so we do.
      lastError = error
    }
    if (Date.now() > deadline) {
      if (lastError !== undefined) throw lastError
      assert.fail('condition never became true: ' + label + ' — last url: ' + (last?.url ?? 'unknown'))
    }
    await sleep(intervalMs)
  }
}

/** The whole snapshot serialized, used for content assertions. */
const text = (snap: BrowserSnapshot): string => JSON.stringify(snap)

// ---------------------------------------------------------------------------
// Scenario: guest checkout journey
// ---------------------------------------------------------------------------

test('guest checkout journey: search, variant, cart, coupon, validation, order', async () => {
  const s = await provider.acquire('guest-checkout')
  const qty = 2
  const expectedTotal = totalOf([{ id: 'coffee-set', qty, variant: 'Large' }], COUPON)

  // 1. Land on the storefront and search for coffee.
  await s.navigate(store.base + '/?nopromo=1', 'load')
  const searchRef = await refOf(s, { role: 'searchbox', name: 'Search products' }, 'storefront search box')
  const filled = await s.fill(searchRef, 'coffee')
  await s.press(searchRef, 'Enter')
  const results = await waitFor(s, snap => snap.url.includes('/search?q=coffee'), 'search results page')
  assert.match(text(results), /Found products for/)
  assert.match(text(results), /Ceramic Pour-Over Set/)

  // 2. Paginate to page 2, then back to the product we want.
  const page2 = await refOf(s, { role: 'link', name: 'Page 2' }, 'pagination link')
  const page2Snap = await s.click(page2)
  assert.match(text(page2Snap), /Burr Coffee Grinder/)
  await s.back()
  const backSnap = await waitFor(s, snap => snap.url.includes('/search?q=coffee') && !snap.url.includes('page=2'), 'back to page 1')

  // 3. Open the product, pick a variant and quantity, add to cart.
  const productRef = refFrom(backSnap, { role: 'link', name: 'Ceramic Pour-Over Set' })
  assert.ok(productRef !== undefined, 'product link on search results')
  await s.click(productRef)
  const product = await waitFor(s, snap => snap.url.includes('/product/coffee-set'), 'product page')
  assert.match(text(product), /\$34\.99/)

  const variantRef = await refOf(s, { role: 'combobox', name: 'Variant' }, 'variant select')
  await s.fill(variantRef, 'Large')
  const qtyRef = await refOf(s, { role: 'textbox', name: 'Quantity' }, 'quantity input')
  await s.fill(qtyRef, String(qty))
  const addRef = await refOf(s, { role: 'button', name: 'Add to cart' }, 'add-to-cart button')
  await s.click(addRef)
  const badge = await waitFor(s, snap => text(snap).includes('Cart (' + String(qty) + ')'), 'cart badge updates')

  // 4. Cart: the item, its variant, the line total.
  const cartLink = refFrom(badge, { role: 'link' }, node => node.name.startsWith('Cart ('))
  assert.ok(cartLink !== undefined, 'cart link in header')
  await s.click(cartLink)
  const cart = await waitFor(s, snap => snap.url.includes('/cart'), 'cart page')
  assert.match(text(cart), /Ceramic Pour-Over Set/)
  assert.match(text(cart), /\(Large\)/)
  assert.match(text(cart), /\$69\.98/) // 2 × 34.99 subtotal

  // 5. Coupon: an invalid code surfaces an alert, the valid code discounts.
  const couponRef = await refOf(s, { role: 'textbox', name: 'Coupon code' }, 'coupon input')
  await s.fill(couponRef, 'WRONG')
  const applyRef = await refOf(s, { role: 'button', name: 'Apply' }, 'apply coupon button')
  await s.click(applyRef)
  await waitFor(s, snap => text(snap).includes('Unknown coupon code.'), 'invalid coupon alert')
  await s.fill(couponRef, COUPON)
  await s.click(applyRef)
  const discounted = await waitFor(s, snap => text(snap).includes('Coupon SAVE10 applied'), 'coupon success')
  assert.match(text(discounted), new RegExp('\\$' + expectedTotal.toFixed(2)))

  // 6. Checkout: empty submit surfaces every validation error.
  const checkoutRef = await refOf(s, { role: 'link', name: 'Checkout' }, 'checkout link')
  await s.click(checkoutRef)
  await waitFor(s, snap => snap.url.includes('/checkout'), 'checkout page')
  const orderRef = await refOf(s, { role: 'button', name: 'Place order' }, 'place-order button')
  await s.click(orderRef)
  await waitFor(s, snap => text(snap).includes('Please enter your full name.'), 'name validation error')
  const emptyErrors = await s.snapshot()
  assert.match(text(emptyErrors), /Please enter a valid email address\./)
  assert.match(text(emptyErrors), /Shipping address must be at least 8 characters\./)
  assert.match(text(emptyErrors), /Card number must be exactly 16 digits\./)
  assert.match(text(emptyErrors), /Expiry must be MM\/YY\./)

  // 7. Fill the form correctly and land on the confirmation page.
  const field = async (name: string): Promise<string> => refOf(s, { role: 'textbox', name }, 'checkout field ' + name)
  await s.fill(await field('Full name'), 'Ada Lovelace')
  await s.fill(await field('Email'), 'ada@example.com')
  await s.fill(await field('Shipping address'), '1 Analytical Engine Way')
  await s.fill(await field('Card number'), '4111111111111111')
  await s.fill(await field('Expiry (MM/YY)'), '12/30')
  await s.click(await refOf(s, { role: 'button', name: 'Place order' }, 'place-order button (valid)'))
  const confirmed = await waitFor(s, snap => snap.url.includes('/order/ORD-'), 'order confirmation page')
  assert.match(text(confirmed), /Order confirmed/)
  assert.match(text(confirmed), /ORD-\d+/)
  assert.match(text(confirmed), new RegExp('\\$' + expectedTotal.toFixed(2)))
})

// ---------------------------------------------------------------------------
// Scenario: login, cookie persistence, logout
// ---------------------------------------------------------------------------

test('account journey: redirect, invalid login, session persistence across tabs, logout', async () => {
  const s = await provider.acquire('account-journey')

  // 1. /account redirects an anonymous visitor to the login page.
  const first = await s.navigate(store.base + '/account', 'load')
  assert.ok(first.url.includes('/login?next='), 'anonymous /account should redirect to login, got ' + first.url)
  assert.match(text(first), /Sign in/)

  // 2. Wrong credentials surface an alert without navigating away.
  const emailRef = await refOf(s, { role: 'textbox', name: 'Email' }, 'login email')
  const passwordRef = await refOf(s, { role: 'textbox', name: 'Password' }, 'login password')
  await s.fill(emailRef, 'demo@store.test')
  await s.fill(passwordRef, 'nope')
  await s.click(await refOf(s, { role: 'button', name: 'Sign in' }, 'sign-in button'))
  await waitFor(s, snap => text(snap).includes('Invalid email or password.'), 'invalid login alert')

  // 3. Correct credentials land on the account page.
  await s.fill(passwordRef, 'secret123')
  await s.click(await refOf(s, { role: 'button', name: 'Sign in' }, 'sign-in button (retry)'))
  const account = await waitFor(s, snap => snap.url.includes('/account'), 'account page')
  assert.match(text(account), /demo@store\.test/)

  // 4. The session cookie persists across pages and tabs of the same context.
  await s.navigate(store.base + '/product/sapiens', 'load')
  await s.click(await refOf(s, { role: 'link', name: 'Account' }, 'header account link'))
  await waitFor(s, snap => snap.url.includes('/account') && text(snap).includes('demo@store.test'), 'account after navigation')
  const otherTab = await s.openTab(store.base + '/account', 'load')
  assert.match(text(otherTab), /demo@store\.test/, 'session cookie shared across tabs')
  await s.closeTab(1)

  // 5. Logout clears the session; /account redirects again.
  await s.click(await refOf(s, { role: 'button', name: 'Sign out' }, 'sign-out button'))
  const signedOut = await waitFor(s, snap => text(snap).includes('You have been signed out.'), 'signed-out banner')
  const backToLogin = await s.navigate(store.base + '/account', 'load')
  assert.ok(backToLogin.url.includes('/login?next='), 'logged-out /account should redirect again')
})

// ---------------------------------------------------------------------------
// Scenario: multi-tab research
// ---------------------------------------------------------------------------

test('multi-tab research journey: open, list, switch, close', async () => {
  const s = await provider.acquire('multi-tab')

  await s.navigate(store.base + '/?nopromo=1', 'load')
  await s.openTab(store.base + '/news', 'load')
  await s.openTab(store.base + '/search?q=book', 'load')

  const tabs = await s.tabs()
  assert.equal(tabs.length, 3)
  assert.equal(tabs[0]?.title, 'Acme Store')
  assert.equal(tabs[1]?.title, 'Newsroom — Acme Store')
  assert.equal(tabs[2]?.title, 'Search — Acme Store')

  const storeTab = await s.switchTab(0)
  assert.match(text(storeTab), /Acme Store/)
  const searchTab = await s.switchTab(2)
  assert.match(text(searchTab), /Designing Data-Intensive Applications/)
  const newsTab = await s.switchTab(1)
  assert.match(text(newsTab), /News item 1: Launch roundup/)

  // A nonexistent tab index fails with the documented error.
  await assert.rejects(
    s.switchTab(9),
    (err: unknown) => err instanceof BrowserError && err.code === 'REF_NOT_FOUND',
  )

  await s.closeTab(2)
  assert.equal((await s.tabs()).length, 2)
  assert.equal((await s.switchTab(0)).title, 'Acme Store')
})

// ---------------------------------------------------------------------------
// Scenario: dynamic pages — slow content, stale refs, lazy loads, infinite scroll
// ---------------------------------------------------------------------------

test('slow page journey: wait for hydration, then the button becomes actionable', async () => {
  const s = await provider.acquire('slow-page')

  const early = await s.navigate(store.base + '/slow', 'load')
  assert.match(text(early), /loading/)
  const disabled = await refOf(s, { role: 'button', name: 'Wait for it', disabled: true }, 'disabled button before hydration')
  assert.ok(disabled !== undefined)

  const hydrated = await waitFor(s, snap => text(snap).includes('finally here'), 'hydrated content')
  const ready = await refOf(s, { role: 'button', name: 'Hydrated action' }, 'enabled button after hydration')
  const readyNode = findNode(hydrated.nodes, { role: 'button', name: 'Hydrated action' })
  assert.ok(readyNode !== undefined && readyNode.disabled !== true, 'the button must be enabled after hydration')
  assert.ok(hydrated.truncated === false)
})

test('stale-ref journey: filter re-render invalidates refs; a fresh snapshot recovers', async () => {
  const s = await provider.acquire('stale-ref')

  await s.navigate(store.base + '/?nopromo=1', 'load')
  const keyboardRef = await refOf(s, { role: 'link', name: 'Mechanical Keyboard' }, 'electronics product link')

  // Re-render the grid with a category filter: old refs die with the old DOM.
  await s.click(await refOf(s, { role: 'button', name: 'Kitchen' }, 'kitchen filter'))
  await waitFor(s, snap => countNodes(snap.nodes, { role: 'link', name: 'Mechanical Keyboard' }) === 0, 'filtered grid')

  // Ref numbers are unique per snapshot (a nonce prefixes every ref), so
  // after the re-render the stale ref matches nothing and fails fast with
  // REF_NOT_FOUND instead of silently acting on a different element.
  await assert.rejects(
    s.click(keyboardRef),
    (err: unknown) => err instanceof BrowserError && err.code === 'REF_NOT_FOUND',
    'stale refs must fail fast with REF_NOT_FOUND',
  )

  // The failed click left the page untouched; a fresh snapshot recovers.
  const grinderRef = await refOf(s, { role: 'link', name: 'Burr Coffee Grinder' }, 'kitchen product after filter')
  const grinder = await s.click(grinderRef)
  await waitFor(s, snap => snap.url.includes('/product/grinder'), 'grinder product page')
  assert.match(text(grinder), /\$119\.50/)

  // A fabricated ref number fails the same fast way.
  const snapshot = await s.snapshot()
  const highRef = 'e' + String(snapshot.totalRefs + 50)
  await assert.rejects(
    s.click(highRef),
    (err: unknown) => err instanceof BrowserError && err.code === 'REF_NOT_FOUND',
    'refs with no current element must fail rather than click something',
  )
})

test('lazy-load journey: recently-viewed section and product reviews arrive late', async () => {
  const s = await provider.acquire('lazy-load')

  // The storefront fetches "Recently viewed" 200ms after load; before that it
  // shows a loading placeholder and the grid has the same product name once.
  const early = await s.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal(countNodes(early.nodes, { role: 'link', name: 'Ceramic Pour-Over Set' }), 1)
  await waitFor(s, snap => countNodes(snap.nodes, { role: 'link', name: 'Ceramic Pour-Over Set' }) >= 2, 'recently-viewed section loaded')

  // Reviews are fetched with a server-side delay on the product page.
  const product = await s.navigate(store.base + '/product/coffee-set', 'load')
  assert.doesNotMatch(text(product), /Exactly as described/)
  await waitFor(s, snap => text(snap).includes('Exactly as described'), 'reviews loaded')
})

test('infinite-scroll journey: news loads in batches until exhausted', async () => {
  const s = await provider.acquire('infinite-scroll')

  const first = await s.navigate(store.base + '/news', 'load')
  assert.equal(countNodes(first.nodes, { role: 'article' }), 10)

  await s.scroll('down', 1600, undefined)
  await waitFor(s, snap => countNodes(snap.nodes, { role: 'article' }) >= 20, 'second news batch')

  await s.scroll('down', 1600, undefined)
  await waitFor(s, snap => countNodes(snap.nodes, { role: 'article' }) >= 30, 'third news batch')

  let end = await s.snapshot()
  if (!text(end).includes('No more news')) {
    await s.scroll('down', 1600, undefined)
    end = await waitFor(s, snap => text(snap).includes('No more news'), 'news exhausted marker')
  }
  assert.equal(countNodes(end.nodes, { role: 'article' }), 30)
})

// ---------------------------------------------------------------------------
// Scenario: modal dialog
// ---------------------------------------------------------------------------

test('promo dialog journey: dismiss the newsletter modal and continue browsing', async () => {
  const s = await provider.acquire('promo-dialog')

  const withModal = await s.navigate(store.base + '/', 'load')
  const modal = findNode(withModal.nodes, { role: 'dialog', name: 'Newsletter promo' })
  assert.ok(modal !== undefined, 'storefront should open the promo dialog')
  assert.ok(findNode(modal.children, { role: 'button', name: 'No thanks' }) !== undefined)

  await s.click(await refOf(s, { role: 'button', name: 'No thanks' }, 'dismiss button'))
  const closed = await s.snapshot()
  assert.equal(findNode(closed.nodes, { role: 'dialog' }), undefined, 'dialog should be gone after dismissal')
})

// ---------------------------------------------------------------------------
// Scenario: popup tab via target=_blank
// ---------------------------------------------------------------------------

test('popup journey: a target=_blank link opens a new tab', async () => {
  const s = await provider.acquire('popup')

  await s.navigate(store.base + '/product/coffee-set', 'load')
  await s.click(await refOf(s, { role: 'link', name: 'Open specs in new tab' }, 'specs popup link'))

  // The popup opens asynchronously; the agent lists tabs until it appears.
  let tabs = await s.tabs()
  for (let attempt = 0; attempt < 20 && tabs.length < 2; attempt += 1) {
    await sleep(100)
    tabs = await s.tabs()
  }
  assert.equal(tabs.length, 2)
  const specs = await s.switchTab(1)
  assert.ok(specs.url.includes('tab=specs'))
  assert.match(text(specs), /Specifications/)
  await s.closeTab(1)
  assert.equal((await s.tabs()).length, 1)
})

// ---------------------------------------------------------------------------
// Scenario: screenshots and gated evaluation
// ---------------------------------------------------------------------------

test('screenshot-and-evaluate journey: element capture, full-page capture, page facts', async () => {
  const s = await provider.acquire('screenshot')

  await s.navigate(store.base + '/product/coffee-set', 'load')
  await waitFor(s, snap => text(snap).includes('Exactly as described'), 'reviews loaded')

  // The product-info card carries a forced ref (a11y-invisible container).
  const infoRef = await refOf(s, { ref: true, name: '' }, 'product info card')
  const elementShot = await s.screenshot({ ref: infoRef })
  assert.equal(elementShot.mime, 'image/png')
  assert.ok(elementShot.bytes.length > 200)
  assert.equal(elementShot.bytes[0], 0x89)
  assert.equal(elementShot.bytes[1], 0x50)

  const fullShot = await s.screenshot({ fullPage: true })
  assert.ok(fullShot.bytes.length >= elementShot.bytes.length, 'full-page capture should not be smaller')

  // Gated evaluation reads structured facts straight from the page.
  assert.equal(await s.evaluate('document.querySelector(".price").textContent'), '$34.99')
  assert.equal(await s.evaluate('document.querySelectorAll("article.review").length'), 2)
  assert.equal(await s.evaluate('location.pathname'), '/product/coffee-set')

  // History: back and forward between search results and the product.
  await s.navigate(store.base + '/search?q=coffee', 'load')
  await s.click(await refOf(s, { role: 'link', name: 'Ceramic Pour-Over Set' }, 'product link'))
  await waitFor(s, snap => snap.url.includes('/product/coffee-set'), 'product via search')
  const back = await s.back()
  assert.equal(back.title, 'Search — Acme Store')
  const forward = await s.forward()
  assert.ok(forward.url.includes('/product/coffee-set'))
})

// ---------------------------------------------------------------------------
// Scenario: navigation policy
// ---------------------------------------------------------------------------

test('policy journey: allowedDomains blocks both navigation and link clicks', async () => {
  const s = await policyProvider.acquire('policy')

  // 127.0.0.1 is allowed…
  const ok = await s.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal(ok.title, 'Acme Store')

  // …but the same server reached as "localhost" is not.
  await assert.rejects(
    s.navigate(store.localhostBase + '/', 'load'),
    (err: unknown) => err instanceof BrowserError && err.code === 'URL_NOT_ALLOWED',
  )

  // Link clicks are checked against the policy at click time too.
  const snap = await s.snapshot()
  const docsRef = refFrom(snap, { role: 'link', name: 'External docs' })
  assert.ok(docsRef !== undefined, 'external docs footer link')
  await assert.rejects(
    s.click(docsRef),
    (err: unknown) => err instanceof BrowserError && err.code === 'URL_NOT_ALLOWED',
    'clicking a link to a disallowed host must be rejected',
  )
  // The rejected click left the page on the allowed host.
  const after = await s.snapshot()
  assert.ok(after.url.startsWith('http://127.0.0.1:'), 'the page must stay on the allowed host')
})

// ---------------------------------------------------------------------------
// Scenario: owner isolation under concurrency
// ---------------------------------------------------------------------------

test('isolation journey: two owners shop independently on one shared browser', async () => {
  const a = await provider.acquire('iso-a')
  const b = await provider.acquire('iso-b')

  // Owner A adds a product; owner B's context stays untouched.
  await a.navigate(store.base + '/product/coffee-set', 'load')
  await a.click(await refOf(a, { role: 'button', name: 'Add to cart' }, 'add-to-cart (A)'))
  await waitFor(a, snap => text(snap).includes('Cart (1)'), 'A cart badge')

  await b.navigate(store.base + '/cart', 'load')
  assert.match(text(await b.snapshot()), /Your cart is empty\./, 'B must not see A\'s cart')

  await a.navigate(store.base + '/cart', 'load')
  assert.match(text(await a.snapshot()), /Ceramic Pour-Over Set/, 'A sees their own cart')

  // Closing B does not disturb A.
  await b.close()
  const aAfter = await a.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal(aAfter.title, 'Acme Store')
  await a.close()
})

// ---------------------------------------------------------------------------
// Scenario: idle disposal
// ---------------------------------------------------------------------------

test('idle journey: an untouched session is disposed and transparently recreated', async () => {
  const s = await idleProvider.acquire('idle-1')
  await s.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal((await s.snapshot()).title, 'Acme Store')

  // Idle longer than the configured 500ms without touching the session.
  await sleep(1000)
  await assert.rejects(
    s.snapshot(),
    (err: unknown) => err instanceof BrowserError && err.code === 'SESSION_CLOSED',
    'idle sessions must be disposed',
  )

  // The next acquire for the same owner starts a fresh, usable session.
  const again = await idleProvider.acquire('idle-1')
  assert.equal((await again.snapshot()).url, 'about:blank')
  const fresh = await again.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal(fresh.title, 'Acme Store')
})

test('idle safety: a navigation slower than the idle window completes normally', async () => {
  // Busy tracking defers idle disposal while an operation is in flight, so a
  // slow navigation (600ms response) outlives the 500ms idle window instead
  // of being killed mid-flight.
  const s = await idleProvider.acquire('idle-slow')
  const snap = await s.navigate(store.base + '/slow-load', 'load')
  assert.equal(snap.title, 'Slow load')
  assert.match(text(snap), /Loaded eventually/)
})

// ---------------------------------------------------------------------------
// Scenario: snapshot token budgets
// ---------------------------------------------------------------------------

test('bounds journey: maxNodes truncates real pages and maxNameLength clips names', async () => {
  const s = await boundedProvider.acquire('bounds')
  const snap = await s.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal(snap.truncated, true, 'a full storefront must exceed the node budget')
  assert.ok(flatCount(snap.nodes) <= 60, 'node count respects maxNodes')
  walk(snap.nodes, node => {
    assert.ok(node.name.length <= 21, 'names respect maxNameLength: ' + JSON.stringify(node.name))
  })

  // On a page that fits the budget, long names are clipped with an ellipsis.
  const searchSnap = await s.navigate(store.base + '/search?q=book', 'load')
  assert.equal(searchSnap.truncated, false)
  let clipped = 0
  walk(searchSnap.nodes, node => {
    if (node.name.endsWith('…')) clipped += 1
  })
  assert.ok(clipped > 0, 'long names must be clipped rather than dropped')

  const full = await provider.acquire('bounds-full')
  const unrestricted = await full.navigate(store.base + '/?nopromo=1', 'load')
  assert.equal(unrestricted.truncated, false)
  assert.ok(flatCount(unrestricted.nodes) > 50)

  // interactiveOnly prunes non-actionable roles entirely.
  const interactive = await full.snapshot({ interactiveOnly: true })
  assert.equal(findNode(interactive.nodes, { role: 'heading' }), undefined)
  assert.ok(countNodes(interactive.nodes, { role: 'link' }) > 5)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a node in a snapshot and return its ref when it carries one. */
function refFrom(
  snap: BrowserSnapshot,
  match: NodeMatch,
  extra: (node: BrowserNode) => boolean = () => true,
): string | undefined {
  let found: string | undefined
  walk(snap.nodes, node => {
    if (found === undefined && matches(node, match) && extra(node) && node.ref !== undefined) found = node.ref
  })
  return found
}
