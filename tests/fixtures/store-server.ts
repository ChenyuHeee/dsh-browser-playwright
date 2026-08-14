/**
 * Realistic web-app fixture for scenario tests: a small e-commerce store
 * served over plain node:http. Deliberately close to real production pages:
 * server-rendered catalog and cart, cookie sessions, client-side validation,
 * lazy-loaded sections, infinite scroll, a modal dialog, and popup links.
 * @module dsh-browser-playwright/tests/fixtures/store-server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

/** One catalog entry; exported so tests can compute expected totals. */
export interface Product {
  readonly id: string
  readonly name: string
  readonly price: number
  readonly category: 'Kitchen' | 'Electronics' | 'Sports' | 'Books'
  readonly blurb: string
  readonly variants?: readonly string[]
}

/** The store's catalog. */
export const CATALOG: readonly Product[] = [
  { id: 'coffee-set', name: 'Ceramic Pour-Over Set', price: 34.99, category: 'Kitchen', blurb: 'Slow-brew coffee with a ceramic dripper, glass carafe and 40 paper filters.', variants: ['Small', 'Large'] },
  { id: 'keyboard', name: 'Mechanical Keyboard', price: 89, category: 'Electronics', blurb: 'Hot-swappable 75% board with RGB backlight and a coiled cable.', variants: ['Brown Switch', 'Blue Switch'] },
  { id: 'yoga-mat', name: 'Yoga Mat Pro', price: 29.5, category: 'Sports', blurb: '6mm non-slip mat with alignment lines and a carry strap.' },
  { id: 'ddia', name: 'Designing Data-Intensive Applications', price: 42, category: 'Books', blurb: 'The classic tour of storage, replication, and distributed systems.' },
  { id: 'kettle', name: 'Gooseneck Kettle', price: 45.25, category: 'Kitchen', blurb: 'Precision-pour kettle for pour-over coffee with a built-in thermometer.', variants: ['Black', 'Silver'] },
  { id: 'monitor', name: '27" 4K Monitor', price: 299.99, category: 'Electronics', blurb: 'IPS panel, USB-C docking and a fully adjustable stand.' },
  { id: 'dumbbells', name: 'Adjustable Dumbbells', price: 129, category: 'Sports', blurb: '2-24 kg per hand with a one-twist dial.' },
  { id: 'sapiens', name: 'Sapiens', price: 18.75, category: 'Books', blurb: 'A brief history of humankind.' },
  { id: 'grinder', name: 'Burr Coffee Grinder', price: 119.5, category: 'Kitchen', blurb: '40 grind settings for espresso to cold brew.' },
  { id: 'earbuds', name: 'Wireless Earbuds', price: 59.99, category: 'Electronics', blurb: 'ANC earbuds with a wireless charging case.', variants: ['Black', 'White'] },
  { id: 'bottle', name: 'Insulated Bottle 1L', price: 24, category: 'Sports', blurb: 'Keeps drinks cold for 24 hours.' },
  { id: 'pragmatic', name: 'The Pragmatic Programmer', price: 31.5, category: 'Books', blurb: 'Your journey to mastery, 20th anniversary edition.' },
]

/** One cart line. */
export interface CartItem {
  readonly id: string
  readonly qty: number
  readonly variant: string | null
}

/** Cart cookie payload. */
interface CartState {
  readonly items: readonly CartItem[]
  readonly coupon: string | null
}

/** Running server plus its reachable base URL. */
export interface StoreFixture {
  readonly server: Server
  readonly port: number
  /** e.g. http://127.0.0.1:54321 */
  readonly base: string
  /** Same server reached through the localhost hostname (a "different host" for policy tests). */
  readonly localhostBase: string
  close(): Promise<void>
}

/** Run the store on an ephemeral 127.0.0.1 port. */
export async function startStoreServer(): Promise<StoreFixture> {
  const orders = new Map<string, number>()

  const server = createServer((req, res) => {
    void handle(req, res, orders).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('store fixture failure: ' + detail)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('store server failed to bind')
  const port = address.port
  const base = 'http://127.0.0.1:' + String(port)
  return {
    server,
    port,
    base,
    localhostBase: 'http://localhost:' + String(port),
    close: () => new Promise<void>((resolve, reject) => server.close(err => err === undefined ? resolve() : reject(err))),
  }
}

/** Line total and discount helpers shared with tests. */
export function subtotalOf(items: readonly CartItem[]): number {
  let total = 0
  for (const item of items) {
    const product = CATALOG.find(p => p.id === item.id)
    if (product !== undefined) total += product.price * item.qty
  }
  return total
}

/** The one supported coupon code. */
export const COUPON = 'SAVE10'

export function totalOf(items: readonly CartItem[], coupon: string | null): number {
  const subtotal = subtotalOf(items)
  return coupon === COUPON ? subtotal * 0.9 : subtotal
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const HTML = 'text/html; charset=utf-8'

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function money(amount: number): string {
  return '$' + amount.toFixed(2)
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

function cookiesOf(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>()
  const header = req.headers.cookie
  if (header === undefined) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return out
}

function cartOf(req: IncomingMessage): CartState {
  const raw = cookiesOf(req).get('cart')
  if (raw === undefined) return { items: [], coupon: null }
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as CartState
    if (!Array.isArray(parsed.items)) return { items: [], coupon: null }
    return { items: parsed.items, coupon: typeof parsed.coupon === 'string' ? parsed.coupon : null }
  } catch {
    return { items: [], coupon: null }
  }
}

function setCart(res: ServerResponse, state: CartState): void {
  const encoded = encodeURIComponent(JSON.stringify(state))
  res.setHeader('set-cookie', 'cart=' + encoded + '; Path=/; SameSite=Lax')
}

function emailOf(req: IncomingMessage): string | null {
  const raw = cookiesOf(req).get('session')
  if (raw === undefined) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as { email?: unknown }
    return typeof parsed.email === 'string' ? parsed.email : null
  } catch {
    return null
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  if (body === '') return {}
  return JSON.parse(body) as unknown
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, orders: Map<string, number>): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://store.local')
  const path = url.pathname
  const method = (req.method ?? 'GET').toUpperCase()

  // -- JSON APIs -------------------------------------------------------------
  if (path === '/api/recent') {
    await delay(200)
    sendJson(res, 200, { products: CATALOG.slice(0, 4).map(p => ({ id: p.id, name: p.name })) })
    return
  }
  if (path.startsWith('/api/reviews/')) {
    const id = path.slice('/api/reviews/'.length)
    const product = CATALOG.find(p => p.id === id)
    await delay(400)
    sendJson(res, 200, {
      reviews: [
        { author: 'Alex', rating: 5, text: 'Exactly as described, shipping was fast.' },
        { author: 'Jamie', rating: 4, text: 'Good quality for the price.' },
      ].map(review => ({ ...review, product: product?.name ?? id })),
    })
    return
  }
  if (path === '/api/news') {
    const after = Number(url.searchParams.get('after') ?? '0')
    const all = Array.from({ length: 30 }, (_, i) => ({
      id: 'n' + String(i + 1),
      title: 'News item ' + String(i + 1) + ': ' + ['Launch', 'Funding', 'Research', 'Partnership', 'Award'][i % 5] + ' roundup',
      summary: 'Summary of news item ' + String(i + 1) + '.',
    }))
    sendJson(res, 200, { items: all.slice(after, after + 10) })
    return
  }
  if (path === '/api/cart/add' && method === 'POST') {
    const body = await readJson(req) as { id?: unknown; qty?: unknown; variant?: unknown }
    const id = typeof body.id === 'string' ? body.id : ''
    const product = CATALOG.find(p => p.id === id)
    if (product === undefined) {
      sendJson(res, 404, { error: 'Unknown product.' })
      return
    }
    const qty = Math.max(1, Math.min(99, Number(body.qty) || 1))
    const variant = typeof body.variant === 'string' && body.variant !== '' ? body.variant : null
    const cart = cartOf(req)
    const existing = cart.items.find(item => item.id === id && item.variant === variant)
    const items = existing === undefined
      ? [...cart.items, { id, qty, variant }]
      : cart.items.map(item => item.id === id && item.variant === variant ? { ...item, qty: item.qty + qty } : item)
    setCart(res, { items, coupon: cart.coupon })
    sendJson(res, 200, { count: items.reduce((sum, item) => sum + item.qty, 0) })
    return
  }
  if (path === '/api/cart/remove' && method === 'POST') {
    const body = await readJson(req) as { id?: unknown }
    const cart = cartOf(req)
    setCart(res, { items: cart.items.filter(item => item.id !== String(body.id ?? '')), coupon: cart.coupon })
    sendJson(res, 200, { ok: true })
    return
  }
  if (path === '/api/cart/coupon' && method === 'POST') {
    const body = await readJson(req) as { code?: unknown }
    const code = String(body.code ?? '').trim().toUpperCase()
    const cart = cartOf(req)
    if (code !== COUPON) {
      sendJson(res, 400, { error: 'Unknown coupon code.' })
      return
    }
    setCart(res, { ...cart, coupon: code })
    sendJson(res, 200, { ok: true, code })
    return
  }
  if (path === '/api/login' && method === 'POST') {
    const body = await readJson(req) as { email?: unknown; password?: unknown }
    if (body.email !== 'demo@store.test' || body.password !== 'secret123') {
      sendJson(res, 401, { error: 'Invalid email or password.' })
      return
    }
    res.setHeader('set-cookie', 'session=' + encodeURIComponent(JSON.stringify({ email: 'demo@store.test' })) + '; Path=/; HttpOnly; SameSite=Lax')
    sendJson(res, 200, { ok: true, email: 'demo@store.test' })
    return
  }
  if (path === '/api/logout' && method === 'POST') {
    res.setHeader('set-cookie', 'session=; Path=/; Max-Age=0')
    sendJson(res, 200, { ok: true })
    return
  }
  if (path === '/api/checkout' && method === 'POST') {
    const cart = cartOf(req)
    if (cart.items.length === 0) {
      sendJson(res, 400, { errors: [{ field: 'cart', message: 'Your cart is empty.' }] })
      return
    }
    const body = await readJson(req) as Record<string, unknown>
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim()
    const address = String(body.address ?? '').trim()
    const card = String(body.card ?? '').replace(/s+/g, '')
    const expiry = String(body.expiry ?? '').trim()
    const errors: { field: string; message: string }[] = []
    if (name === '') errors.push({ field: 'name', message: 'Please enter your full name.' })
    if (!/^\S+@\S+\.\S+$/.test(email)) errors.push({ field: 'email', message: 'Please enter a valid email address.' })
    if (address.length < 8) errors.push({ field: 'address', message: 'Shipping address must be at least 8 characters.' })
    if (!/^\d{16}$/.test(card)) errors.push({ field: 'card', message: 'Card number must be exactly 16 digits.' })
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) errors.push({ field: 'expiry', message: 'Expiry must be MM/YY.' })
    if (errors.length > 0) {
      sendJson(res, 400, { errors })
      return
    }
    const total = totalOf(cart.items, cart.coupon)
    const orderId = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 9000 + 1000)
    orders.set(orderId, total)
    setCart(res, { items: [], coupon: null })
    sendJson(res, 200, { orderId })
    return
  }

  // -- Pages ---------------------------------------------------------------
  const email = emailOf(req)
  const cart = cartOf(req)

  if (path === '/login') {
    const next = url.searchParams.get('next') ?? '/account'
    send(res, 200, HTML, pageShell('Sign in — Acme Store', loginPage(next)))
    return
  }
  if (path === '/account') {
    if (email === null) {
      res.writeHead(302, { location: '/login?next=' + encodeURIComponent('/account') })
      res.end()
      return
    }
    send(res, 200, HTML, pageShell('Your account — Acme Store', accountPage(email)))
    return
  }
  if (path.startsWith('/product/') && method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/product/'.length))
    const product = CATALOG.find(p => p.id === id)
    if (product === undefined) {
      send(res, 404, HTML, pageShell('Not found — Acme Store', '<h1>Not found</h1>'))
      return
    }
    const specs = url.searchParams.get('tab') === 'specs'
    send(res, 200, HTML, pageShell(product.name + ' — Acme Store', productPage(product, specs, email)))
    return
  }
  if (path === '/cart') {
    send(res, 200, HTML, pageShell('Your Cart — Acme Store', cartPage(cart, email)))
    return
  }
  if (path === '/checkout') {
    send(res, 200, HTML, pageShell('Checkout — Acme Store', checkoutPage(cart, email)))
    return
  }
  if (path.startsWith('/order/')) {
    const id = decodeURIComponent(path.slice('/order/'.length))
    const total = orders.get(id)
    if (total === undefined) {
      send(res, 404, HTML, pageShell('Order not found — Acme Store', '<h1>Order not found</h1>'))
      return
    }
    send(res, 200, HTML, pageShell('Order confirmed — Acme Store', orderPage(id, total)))
    return
  }
  if (path === '/search') {
    const q = (url.searchParams.get('q') ?? '').trim()
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    send(res, 200, HTML, pageShell('Search — Acme Store', searchPage(q, page)))
    return
  }
  if (path === '/news') {
    send(res, 200, HTML, pageShell('Newsroom — Acme Store', newsPage()))
    return
  }
  if (path === '/slow') {
    send(res, 200, HTML, pageShell('Slow page', slowPage()))
    return
  }
  if (path === '/slow-load') {
    // Delays the response itself: the page LOAD event fires late. Used by the
    // idle-hazard scenario, where the idle window outlives the navigation.
    await delay(600)
    send(res, 200, HTML, pageShell('Slow load', '<main><h1>Slow load</h1><p>Loaded eventually.</p></main>'))
    return
  }
  if (path === '/terms') {
    send(res, 200, HTML, pageShell('Terms of Service', termsPage()))
    return
  }
  if (path === '/docs') {
    send(res, 200, HTML, pageShell('Docs', '<main><h1>Docs</h1><p>External documentation placeholder.</p></main>'))
    return
  }
  if (path === '/') {
    const promo = url.searchParams.get('nopromo') !== '1'
    const signedOut = url.searchParams.get('signed_out') === '1'
    // The footer links to the same server through the localhost hostname, so
    // policy tests can treat it as an "external" host distinct from 127.0.0.1.
    const externalDocs = 'http://' + (req.headers.host ?? '127.0.0.1').replace(/^127\.0\.0\.1/, 'localhost') + '/docs'
    send(res, 200, HTML, pageShell('Acme Store', storefrontPage(cart, email, promo, signedOut, externalDocs)))
    return
  }
  send(res, 404, HTML, pageShell('Not found', '<h1>Not found</h1>'))
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function pageShell(title: string, body: string, extraHead = ''): string {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' + esc(title) + '</title>\n'
    + '<style>body{font-family:sans-serif;margin:0;color:#222}header.site{display:flex;gap:1rem;align-items:center;padding:.75rem 1.5rem;border-bottom:1px solid #ddd}header.site .brand{font-weight:700;text-decoration:none;color:#222}header.site form{display:flex;gap:.5rem;flex:1}header.site input{flex:1;padding:.4rem}main{padding:1.5rem;max-width:960px;margin:0 auto}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem}.card{border:1px solid #ddd;border-radius:6px;padding:1rem}.card h3{margin:.2rem 0}.filters{display:flex;gap:.5rem;margin:1rem 0}.price{font-weight:700}.error,.alert-error{color:#b00020;background:#fdecea;border:1px solid #f5c6cb;padding:.5rem;border-radius:4px}.success{color:#1e7d32;background:#e8f5e9;padding:.5rem;border-radius:4px}label{display:block;margin-top:.75rem;font-size:.9rem}input,select,button{padding:.45rem;font-size:1rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #eee}.muted{color:#666;font-size:.85rem}.promo-box{max-width:420px}footer{padding:1.5rem;border-top:1px solid #ddd;margin-top:2rem}</style>\n'
    + extraHead + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n'
}

function siteHeader(cart: CartState, email: string | null): string {
  const count = cart.items.reduce((sum, item) => sum + item.qty, 0)
  return '<header class="site">\n'
    + '<a class="brand" href="/">Acme Store</a>\n'
    + '<form action="/search" method="get" role="search">\n'
    + '<label for="q" class="muted">Search products</label>\n'
    + '<input id="q" name="q" type="search" placeholder="e.g. coffee">\n'
    + '<button type="submit">Search</button>\n'
    + '</form>\n'
    + '<a id="cart-link" href="/cart">Cart (' + String(count) + ')</a>\n'
    + '<a href="/account">' + (email === null ? 'Sign in' : 'Account') + '</a>\n'
    + '</header>\n'
}

function storefrontPage(cart: CartState, email: string | null, promo: boolean, signedOut: boolean, externalDocs: string): string {
  const cards = CATALOG.map(product =>
    '<article class="card" data-category="' + esc(product.category) + '">\n'
    + '<h3><a href="/product/' + esc(product.id) + '">' + esc(product.name) + '</a></h3>\n'
    + '<p class="price">' + money(product.price) + '</p>\n'
    + '<p class="muted">' + esc(product.category) + '</p>\n'
    + '</article>\n',
  ).join('')
  const signedOutBanner = signedOut
    ? '<p class="success" role="status">You have been signed out.</p>\n'
    : ''
  const promoHtml = promo
    ? '<dialog id="promo" aria-label="Newsletter promo" class="promo-box">\n'
    + '<h2>Get 10% off your first order</h2>\n'
    + '<p>Join the newsletter and we will email you a code.</p>\n'
    + '<button id="promo-close">No thanks</button>\n'
    + '</dialog>\n'
    + '<script>\n'
    + 'if (!sessionStorage.getItem("promo-seen")) {\n'
    + '  sessionStorage.setItem("promo-seen", "1")\n'
    + '  document.getElementById("promo").showModal()\n'
    + '}\n'
    + 'document.getElementById("promo-close").onclick = function () { document.getElementById("promo").close() }\n'
    + '</script>\n'
    : ''
  return siteHeader(cart, email) + '\n<main>\n'
    + signedOutBanner
    + '<h1>Acme Store</h1>\n'
    + '<p class="muted">Everything you need, delivered tomorrow.</p>\n'
    + '<div class="filters" aria-label="Category filters">\n'
    + '<button class="filter" data-cat="All">All</button>\n'
    + '<button class="filter" data-cat="Kitchen">Kitchen</button>\n'
    + '<button class="filter" data-cat="Electronics">Electronics</button>\n'
    + '<button class="filter" data-cat="Sports">Sports</button>\n'
    + '<button class="filter" data-cat="Books">Books</button>\n'
    + '</div>\n'
    + '<section id="product-grid" class="grid" aria-label="Products">\n' + cards + '</section>\n'
    + '<section id="recent" aria-label="Recently viewed"><h2>Recently viewed</h2><p class="muted">Loading…</p></section>\n'
    + promoHtml
    + '</main>\n'
    + '<footer><a href="' + externalDocs + '">External docs</a></footer>\n'
    + '<script>\n'
    + 'const PRODUCTS = ' + JSON.stringify(CATALOG) + '\n'
    + 'const grid = document.getElementById("product-grid")\n'
    + 'for (const button of document.querySelectorAll("button.filter")) {\n'
    + '  button.onclick = function () {\n'
    + '    grid.innerHTML = PRODUCTS\n'
    + '      .filter(function (p) { return button.dataset.cat === "All" || p.category === button.dataset.cat })\n'
    + '      .map(function (p) {\n'
    + '        return "<article class=\\"card\\" data-category=\\"" + p.category + "\\"><h3><a href=\\"/product/" + p.id + "\\">" + p.name + "</a></h3><p class=\\"price\\">$" + p.price.toFixed(2) + "</p><p class=\\"muted\\">" + p.category + "</p></article>"\n'
    + '      }).join("")\n'
    + '  }\n'
    + '}\n'
    + 'setTimeout(function () {\n'
    + '  fetch("/api/recent").then(function (r) { return r.json() }).then(function (data) {\n'
    + '    document.getElementById("recent").innerHTML = "<h2>Recently viewed</h2><ul>" +\n'
    + '      data.products.map(function (p) { return "<li><a href=\\"/product/" + p.id + "\\">" + p.name + "</a></li>" }).join("") + "</ul>"\n'
    + '  })\n'
    + '}, 200)\n'
    + '</script>\n'
}

function productPage(product: Product, specs: boolean, email: string | null): string {
  const variants = product.variants !== undefined && product.variants.length > 0
    ? '<label for="variant">Variant</label>\n<select id="variant" aria-label="Variant">\n'
    + product.variants.map(v => '<option>' + esc(v) + '</option>').join('\n') + '\n</select>\n'
    : ''
  const specsHtml = specs
    ? '<section id="specs" aria-label="Specifications"><h2>Specifications</h2><ul><li>Weight: 1.2 kg</li><li>Warranty: 24 months</li></ul></section>\n'
    : ''
  const related = CATALOG.filter(p => p.id !== product.id).slice(0, 3).map(p =>
    '<li><a href="/product/' + esc(p.id) + '">' + esc(p.name) + '</a></li>').join('')
  return siteHeader({ items: [], coupon: null }, email) + '\n<main>\n'
    + '<p class="muted"><a href="/">Store</a> / ' + esc(product.category) + '</p>\n'
    + '<div class="card product-info" data-dsh-force-ref>\n'
    + '<h1>' + esc(product.name) + '</h1>\n'
    + '<p class="price">' + money(product.price) + '</p>\n'
    + '<p>' + esc(product.blurb) + '</p>\n'
    + '<p class="muted">In stock, ships tomorrow.</p>\n'
    + variants
    + '<label for="qty">Quantity</label>\n'
    + '<input id="qty" type="number" value="1" min="1" max="99">\n'
    + '<p><button id="add-to-cart">Add to cart</button></p>\n'
    + '<p><a href="/product/' + esc(product.id) + '?tab=specs" target="_blank" rel="noopener">Open specs in new tab</a></p>\n'
    + '</div>\n'
    + specsHtml
    + '<section id="reviews" aria-label="Reviews"><h2>Reviews</h2><p class="muted">Loading reviews…</p></section>\n'
    + '<section aria-label="Related products"><h2>Related products</h2><ul>' + related + '</ul></section>\n'
    + '</main>\n'
    + '<script>\n'
    + 'const cartBadge = document.getElementById("cart-link")\n'
    + 'document.getElementById("add-to-cart").onclick = function () {\n'
    + '  fetch("/api/cart/add", {\n'
    + '    method: "POST",\n'
    + '    headers: { "content-type": "application/json" },\n'
    + '    body: JSON.stringify({ id: ' + JSON.stringify(product.id) + ', qty: Number(document.getElementById("qty").value), variant: ' + (product.variants !== undefined ? 'document.getElementById("variant").value' : 'null') + ' })\n'
    + '  }).then(function (r) { return r.json() }).then(function (data) {\n'
    + '    cartBadge.textContent = "Cart (" + data.count + ")"\n'
    + '  })\n'
    + '}\n'
    + 'setTimeout(function () {\n'
    + '  fetch("/api/reviews/' + esc(product.id) + '").then(function (r) { return r.json() }).then(function (data) {\n'
    + '    document.getElementById("reviews").innerHTML = "<h2>Reviews</h2>" +\n'
    + '      data.reviews.map(function (review) { return "<article class=\\"card review\\"><p>" + "★".repeat(review.rating) + "</p><p>" + review.text + "</p><p class=\\"muted\\">— " + review.author + "</p></article>" }).join("")\n'
    + '  })\n'
    + '}, 300)\n'
    + '</script>\n'
}

function cartPage(cart: CartState, email: string | null): string {
  if (cart.items.length === 0) {
    return siteHeader(cart, email) + '\n<main>\n<h1>Your Cart</h1>\n<p>Your cart is empty.</p>\n<p><a href="/">Browse products</a></p>\n</main>\n'
  }
  const subtotal = subtotalOf(cart.items)
  const total = totalOf(cart.items, cart.coupon)
  const rows = cart.items.map(item => {
    const product = CATALOG.find(p => p.id === item.id)
    if (product === undefined) return ''
    return '<tr>\n<td>' + esc(product.name) + (item.variant !== null ? ' <span class="muted">(' + esc(item.variant) + ')</span>' : '') + '</td>\n'
      + '<td>' + String(item.qty) + '</td>\n'
      + '<td>' + money(product.price) + '</td>\n'
      + '<td>' + money(product.price * item.qty) + '</td>\n'
      + '<td><button class="remove" data-id="' + esc(product.id) + '" data-variant="' + esc(item.variant ?? '') + '">Remove</button></td>\n'
      + '</tr>\n'
  }).join('')
  const couponState = cart.coupon === COUPON
    ? '<p class="success">Coupon SAVE10 applied — 10% off.</p>\n'
    : ''
  return siteHeader(cart, email) + '\n<main>\n<h1>Your Cart</h1>\n'
    + '<table aria-label="Cart items">\n<thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Line total</th><th></th></tr></thead>\n<tbody>\n' + rows + '</tbody>\n</table>\n'
    + '<section id="coupon" aria-label="Coupon">\n<h2>Coupon</h2>\n'
    + '<label for="coupon-code">Coupon code</label>\n'
    + '<input id="coupon-code" name="code" placeholder="SAVE10">\n'
    + '<button id="apply-coupon">Apply</button>\n'
    + '<div id="coupon-result">' + couponState + '</div>\n'
    + '</section>\n'
    + '<p>Subtotal: <strong>' + money(subtotal) + '</strong></p>\n'
    + (cart.coupon === COUPON ? '<p>Discount (10%): <strong>-' + money(subtotal * 0.1) + '</strong></p>\n' : '')
    + '<p>Total: <strong id="cart-total">' + money(total) + '</strong></p>\n'
    + '<p><a id="checkout-link" href="/checkout">Checkout</a></p>\n'
    + '</main>\n'
    + '<script>\n'
    + 'document.getElementById("apply-coupon").onclick = function () {\n'
    + '  const code = document.getElementById("coupon-code").value\n'
    + '  const box = document.getElementById("coupon-result")\n'
    + '  fetch("/api/cart/coupon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code }) })\n'
    + '    .then(function (r) {\n'
    + '      if (!r.ok) {\n'
    + '        return r.json().then(function (data) { box.innerHTML = "<p role=\\"alert\\" class=\\"alert-error\\">" + data.error + "</p>" })\n'
    + '      }\n'
    + '      location.reload()\n'
    + '    })\n'
    + '}\n'
    + 'for (const button of document.querySelectorAll("button.remove")) {\n'
    + '  button.onclick = function () {\n'
    + '    fetch("/api/cart/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: button.dataset.id }) })\n'
    + '      .then(function () { location.reload() })\n'
    + '  }\n'
    + '}\n'
    + '</script>\n'
}

function checkoutPage(cart: CartState, email: string | null): string {
  if (cart.items.length === 0) {
    return siteHeader(cart, email) + '\n<main>\n<h1>Checkout</h1>\n<p>Your cart is empty — nothing to check out.</p>\n<p><a href="/">Browse products</a></p>\n</main>\n'
  }
  const count = cart.items.reduce((sum, item) => sum + item.qty, 0)
  return siteHeader(cart, email) + '\n<main>\n'
    + '<h1>Checkout</h1>\n'
    + '<p class="muted">' + String(count) + ' item(s) — ' + money(totalOf(cart.items, cart.coupon)) + '</p>\n'
    + '<div id="checkout-errors"></div>\n'
    + '<form id="checkout-form">\n'
    + '<label for="name">Full name</label>\n<input id="name" name="name" autocomplete="name">\n'
    + '<label for="email">Email</label>\n<input id="email" name="email" type="email" autocomplete="email">\n'
    + '<label for="address">Shipping address</label>\n<input id="address" name="address" autocomplete="street-address">\n'
    + '<label for="card">Card number</label>\n<input id="card" name="card" inputmode="numeric" autocomplete="cc-number">\n'
    + '<label for="expiry">Expiry (MM/YY)</label>\n<input id="expiry" name="expiry" placeholder="12/30" autocomplete="cc-exp">\n'
    + '<p><button id="place-order" type="submit">Place order</button></p>\n'
    + '</form>\n'
    + '</main>\n'
    + '<script>\n'
    + 'document.getElementById("checkout-form").onsubmit = function (event) {\n'
    + '  event.preventDefault()\n'
    + '  const box = document.getElementById("checkout-errors")\n'
    + '  box.innerHTML = ""\n'
    + '  fetch("/api/checkout", {\n'
    + '    method: "POST",\n'
    + '    headers: { "content-type": "application/json" },\n'
    + '    body: JSON.stringify({\n'
    + '      name: document.getElementById("name").value,\n'
    + '      email: document.getElementById("email").value,\n'
    + '      address: document.getElementById("address").value,\n'
    + '      card: document.getElementById("card").value,\n'
    + '      expiry: document.getElementById("expiry").value\n'
    + '    })\n'
    + '  }).then(function (r) {\n'
    + '    if (!r.ok) {\n'
    + '      return r.json().then(function (data) {\n'
    + '        box.innerHTML = data.errors.map(function (e) { return "<p role=\\"alert\\" class=\\"alert-error\\">" + e.message + "</p>" }).join("")\n'
    + '      })\n'
    + '    }\n'
    + '    return r.json().then(function (data) { location.href = "/order/" + data.orderId })\n'
    + '  })\n'
    + '  return false\n'
    + '}\n'
    + '</script>\n'
}

function loginPage(next: string): string {
  return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n'
    + '<h1>Sign in</h1>\n'
    + '<div id="login-error"></div>\n'
    + '<form id="login-form">\n'
    + '<input type="hidden" id="next" value="' + esc(next) + '">\n'
    + '<label for="login-email">Email</label>\n<input id="login-email" type="email" autocomplete="email">\n'
    + '<label for="login-password">Password</label>\n<input id="login-password" type="password" autocomplete="current-password">\n'
    + '<p><button id="sign-in" type="submit">Sign in</button></p>\n'
    + '<p class="muted">Demo account: demo@store.test / secret123</p>\n'
    + '</form>\n'
    + '</main>\n'
    + '<script>\n'
    + 'document.getElementById("login-form").onsubmit = function (event) {\n'
    + '  event.preventDefault()\n'
    + '  fetch("/api/login", {\n'
    + '    method: "POST",\n'
    + '    headers: { "content-type": "application/json" },\n'
    + '    body: JSON.stringify({ email: document.getElementById("login-email").value, password: document.getElementById("login-password").value })\n'
    + '  }).then(function (r) {\n'
    + '    if (!r.ok) {\n'
    + '      return r.json().then(function (data) { document.getElementById("login-error").innerHTML = "<p role=\\"alert\\" class=\\"alert-error\\">" + data.error + "</p>" })\n'
    + '    }\n'
    + '    location.href = document.getElementById("next").value\n'
    + '  })\n'
    + '  return false\n'
    + '}\n'
    + '</script>\n'
}

function accountPage(email: string): string {
  return siteHeader({ items: [], coupon: null }, email) + '\n<main>\n'
    + '<h1>Your account</h1>\n'
    + '<p>Signed in as <strong id="account-email">' + esc(email) + '</strong></p>\n'
    + '<p><button id="sign-out">Sign out</button></p>\n'
    + '</main>\n'
    + '<script>\n'
    + 'document.getElementById("sign-out").onclick = function () {\n'
    + '  fetch("/api/logout", { method: "POST" }).then(function () { location.href = "/?signed_out=1" })\n'
    + '}\n'
    + '</script>\n'
}

function searchPage(q: string, page: number): string {
  const pageSize = 2
  if (q === '') {
    return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n<h1>Search</h1>\n<p>Type something to search.</p>\n</main>\n'
  }
  const needle = q.toLowerCase()
  const matches = CATALOG.filter(p =>
    p.name.toLowerCase().includes(needle) || p.blurb.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle))
  if (matches.length === 0) {
    return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n<h1>Search</h1>\n<p>No products match "' + esc(q) + '".</p>\n</main>\n'
  }
  const pages = Math.ceil(matches.length / pageSize)
  const shown = matches.slice((page - 1) * pageSize, page * pageSize)
  const cards = shown.map(product =>
    '<article class="card">\n<h3><a href="/product/' + esc(product.id) + '">' + esc(product.name) + '</a></h3>\n'
    + '<p class="price">' + money(product.price) + '</p>\n<p class="muted">' + esc(product.category) + '</p>\n</article>\n').join('')
  const pager = Array.from({ length: pages }, (_, i) => {
    const n = i + 1
    return n === page
      ? '<span aria-current="page">' + String(n) + '</span> '
      : '<a href="/search?q=' + encodeURIComponent(q) + '&page=' + String(n) + '">Page ' + String(n) + '</a> '
  }).join('')
  return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n'
    + '<h1>Search</h1>\n'
    + '<p>Found <strong>' + String(matches.length) + '</strong> products for "' + esc(q) + '".</p>\n'
    + '<section class="grid" aria-label="Search results">\n' + cards + '</section>\n'
    + '<nav class="filters" aria-label="Pagination">' + pager + '</nav>\n'
    + '</main>\n'
}

function newsPage(): string {
  const initial = Array.from({ length: 10 }, (_, i) => newsItem(i))
  return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n'
    + '<h1>Newsroom</h1>\n'
    + '<section id="news-list" aria-label="News">\n' + initial + '</section>\n'
    + '<div id="sentinel"></div>\n'
    + '<p id="news-end" class="muted"></p>\n'
    + '</main>\n'
    + '<script>\n'
    + 'let after = 10\n'
    + 'const sentinel = document.getElementById("sentinel")\n'
    + 'const observer = new IntersectionObserver(function (entries) {\n'
    + '  if (!entries.some(function (e) { return e.isIntersecting })) return\n'
    + '  observer.disconnect()\n'
    + '  fetch("/api/news?after=" + after).then(function (r) { return r.json() }).then(function (data) {\n'
    + '    const list = document.getElementById("news-list")\n'
    + '    for (const item of data.items) {\n'
    + '      list.insertAdjacentHTML("beforeend", "<article class=\\"card news-item\\"><h2>" + item.title + "</h2><p class=\\"muted\\">" + item.summary + "</p></article>")\n'
    + '    }\n'
    + '    after += data.items.length\n'
    + '    if (data.items.length === 0) {\n'
    + '      document.getElementById("news-end").textContent = "No more news"\n'
    + '      return\n'
    + '    }\n'
    + '    observer.observe(sentinel)\n'
    + '  })\n'
    + '}, { rootMargin: "200px" })\n'
    + 'observer.observe(sentinel)\n'
    + '</script>\n'
}

function newsItem(index: number): string {
  const title = 'News item ' + String(index + 1) + ': ' + ['Launch', 'Funding', 'Research', 'Partnership', 'Award'][index % 5] + ' roundup'
  return '<article class="card news-item"><h2>' + title + '</h2><p class="muted">Summary of news item ' + String(index + 1) + '.</p></article>\n'
}

function orderPage(id: string, total: number): string {
  return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n'
    + '<h1>Order confirmed</h1>\n'
    + '<p role="status">Thank you for your order.</p>\n'
    + '<p>Order number: <strong id="order-id">' + esc(id) + '</strong></p>\n'
    + '<p>Total: <strong>' + money(total) + '</strong></p>\n'
    + '<p><a href="/">Back to store</a></p>\n'
    + '</main>\n'
}

function slowPage(): string {
  return '<main>\n'
    + '<h1>Slow page</h1>\n'
    + '<p id="status">loading…</p>\n'
    + '<button id="hydrated-btn" disabled>Wait for it</button>\n'
    + '</main>\n'
    + '<script>\n'
    + 'setTimeout(function () {\n'
    + '  document.getElementById("status").textContent = "finally here"\n'
    + '  const button = document.getElementById("hydrated-btn")\n'
    + '  button.disabled = false\n'
    + '  button.textContent = "Hydrated action"\n'
    + '}, 800)\n'
    + '</script>\n'
}

function termsPage(): string {
  const paragraphs = Array.from({ length: 14 }, (_, i) => '<p>Clause ' + String(i + 1) + ': The parties agree to behave reasonably, store data securely, and settle disputes over tea. This clause is intentionally verbose so the page requires scrolling.</p>').join('\n')
  return siteHeader({ items: [], coupon: null }, null) + '\n<main>\n'
    + '<h1>Terms of Service</h1>\n'
    + paragraphs
    + '<p id="terms-status"></p>\n'
    + '<button id="accept-terms">Accept terms</button>\n'
    + '</main>\n'
    + '<script>document.getElementById("accept-terms").onclick = function () { document.getElementById("terms-status").textContent = "Accepted" }</script>\n'
}
