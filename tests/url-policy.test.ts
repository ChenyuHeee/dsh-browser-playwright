import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertAllowedUrl } from '../src/playwright.ts'
import { BrowserError } from '../src/errors.ts'

test('http and https pass', () => {
  assert.equal(assertAllowedUrl('https://a.test/p', []).hostname, 'a.test')
  assert.equal(assertAllowedUrl('http://a.test/', []).protocol, 'http:')
})

test('non-http schemes fail loudly', () => {
  for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
    assert.throws(() => assertAllowedUrl(raw, []), (err: unknown) => err instanceof BrowserError && err.code === 'URL_NOT_ALLOWED')
  }
})

test('invalid URLs fail', () => {
  assert.throws(() => assertAllowedUrl('not a url', []), (err: unknown) => err instanceof BrowserError && err.code === 'URL_NOT_ALLOWED')
})

test('allowedDomains restricts hosts, subdomains included', () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://api.example.com/x', ['example.com']))
  assert.doesNotThrow(() => assertAllowedUrl('https://example.com/x', ['example.com']))
  assert.throws(() => assertAllowedUrl('https://evil.com/x', ['example.com']), (err: unknown) => err instanceof BrowserError && err.code === 'URL_NOT_ALLOWED')
})
