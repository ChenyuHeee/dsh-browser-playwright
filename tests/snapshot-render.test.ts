import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshot, renderSnapshotTree } from '../src/snapshot-render.ts'
import type { BrowserNode, BrowserSnapshot } from '../src/types.ts'

test('renderSnapshotTree prints roles, names, flags, and refs', () => {
  const nodes: BrowserNode[] = [
    {
      role: 'navigation', name: 'Main', children: [
        { role: 'link', name: 'Home', ref: 'e1', href: '/', children: [] },
        { role: 'button', name: 'Go', ref: 'e2', disabled: true, children: [] },
      ],
    },
    { role: 'heading', name: 'Title', level: 1, children: [] },
    { role: 'checkbox', name: 'Agree', ref: 'e3', checked: true, children: [] },
  ]
  const text = renderSnapshotTree(nodes)
  assert.equal(text, [
    '- navigation "Main"',
    '  - link "Home" [ref=e1] -> /',
    '  - button "Go" [disabled, ref=e2]',
    '- heading "Title" [level=1]',
    '- checkbox "Agree" [checked, ref=e3]',
  ].join('\n'))
})

test('renderSnapshot includes the header facts and an empty marker', () => {
  const snap: BrowserSnapshot = { url: 'https://x.test/', title: 'X', nodes: [], totalRefs: 0, truncated: false }
  assert.equal(renderSnapshot(snap), 'URL: https://x.test/\nTitle: X\nRefs: 0\n\n(no visible elements)')
})

test('renderSnapshot marks truncation', () => {
  const snap: BrowserSnapshot = { url: 'u', title: 't', nodes: [], totalRefs: 7, truncated: true }
  assert.match(renderSnapshot(snap), /Refs: 7 \(truncated\)/)
})
