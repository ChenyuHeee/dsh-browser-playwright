/**
 * Pure snapshot rendering: model-facing tree text. No I/O, no clock — these
 * functions run on live calls and on session replay alike.
 * @module dsh-browser-playwright/snapshot-render
 */

import type { BrowserNode, BrowserSnapshot } from './types.ts'

/** Render one node line into the accumulating line list. */
function renderNode(node: BrowserNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth)
  let line = indent + '- ' + node.role
  if (node.name !== '') line += ' "' + node.name + '"'
  const flags: string[] = []
  if (node.level !== undefined) flags.push('level=' + String(node.level))
  if (node.checked === true) flags.push('checked')
  if (node.selected === true) flags.push('selected')
  if (node.disabled === true) flags.push('disabled')
  if (node.ref !== undefined) flags.push('ref=' + node.ref)
  if (flags.length > 0) line += ' [' + flags.join(', ') + ']'
  if (node.href !== undefined) line += ' -> ' + node.href
  lines.push(line)
  for (const child of node.children) renderNode(child, depth + 1, lines)
}

/**
 * Render a node tree as indented lines, one element per line.
 * @param nodes - the snapshot's root nodes.
 * @returns the rendered tree text.
 */
export function renderSnapshotTree(nodes: readonly BrowserNode[]): string {
  const lines: string[] = []
  for (const node of nodes) renderNode(node, 0, lines)
  return lines.join('\n')
}

/**
 * Render a complete snapshot: header facts plus the tree.
 * @param snapshot - the bounded accessibility snapshot.
 * @returns the model-facing snapshot text.
 */
export function renderSnapshot(snapshot: BrowserSnapshot): string {
  const tree = renderSnapshotTree(snapshot.nodes)
  const header = 'URL: ' + snapshot.url + '\n'
    + 'Title: ' + snapshot.title + '\n'
    + 'Refs: ' + String(snapshot.totalRefs) + (snapshot.truncated ? ' (truncated)' : '')
  return header + '\n\n' + (tree === '' ? '(no visible elements)' : tree)
}
