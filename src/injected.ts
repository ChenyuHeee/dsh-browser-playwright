/**
 * Injected page-context snapshot engine, installed through addInitScript.
 * It is plain JavaScript: it runs inside the page, never in Node. Each
 * snapshot call assigns stable data-dsh-ref attributes to actionable
 * elements in document order and returns a pruned role/name tree.
 * @module dsh-browser-playwright/injected
 */

/** Options passed from the provider into one snapshot call. */
export interface SnapshotOptions {
  /** Include only actionable (ref-carrying) elements. */
  readonly interactiveOnly?: boolean
  /** Maximum nodes in the returned tree. */
  readonly maxNodes?: number
  /** Maximum characters kept per accessible name. */
  readonly maxNameLength?: number
  /** Maximum characters kept per text block. */
  readonly maxTextLength?: number
}

/** Options for the bounded page-data extraction. */
export interface PageDataOptions {
  readonly maxTextChars?: number
  readonly maxLinks?: number
  readonly maxInputs?: number
}

/**
 * The browser-side snapshot script. Installed with page.addInitScript and
 * invoked as window.__dshSnapshot(opts). The returned value crosses the
 * evaluate boundary as plain JSON.
 */
export const SNAPSHOT_SCRIPT: string = String.raw`
;(() => {
  if (window.__dshSnapshot) return // one install per document
  let lastRefs = []

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'svg'])
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'combobox', 'listbox', 'option', 'textbox', 'searchbox', 'slider', 'spinbutton', 'row', 'gridcell'])
  const ROLE_BY_TAG = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textarea', img: 'img',
    nav: 'navigation', main: 'main', footer: 'contentinfo', header: 'banner',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    ul: 'list', ol: 'list', li: 'listitem', option: 'option', table: 'table', tr: 'row', td: 'cell',
    th: 'columnheader', form: 'form', dialog: 'dialog', article: 'article',
    aside: 'complementary', figure: 'figure', iframe: 'iframe', summary: 'summary',
    section: 'region', p: 'paragraph',
  }
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', hidden: null }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit && explicit.trim()) return explicit.trim().toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox'
    return ROLE_BY_TAG[tag] || 'generic'
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false
    if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  function isActionable(el, role) {
    if (el.getAttribute('data-dsh-force-ref') !== null) return true
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'option' || tag === 'summary') return true
    if (tag === 'input' && role !== null) return true
    if (INTERACTIVE_ROLES.has(role)) return true
    if (el.hasAttribute('tabindex') || el.hasAttribute('contenteditable')) return true
    return false
  }

  function clip(text, max) {
    return text.length > max ? text.slice(0, max) + '…' : text
  }

  function ownText(el, maxText) {
    let out = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent
      else if (node.nodeType === 1 && node.tagName.toLowerCase() === 'br') out += ' '
    }
    const flat = out.replace(/\s+/g, ' ').trim()
    return flat.length > maxText ? flat.slice(0, maxText) + '…' : flat
  }

  function nameOf(el, maxName, maxText) {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return clip(aria.trim(), maxName)
    if (el.id) {
      try {
        const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        if (labelEl) {
          const t = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
          if (t) return clip(t, maxName)
        }
      } catch (_) { /* invalid id selector */ }
    }
    const labelEl = el.closest('label')
    if (labelEl) {
      const t = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
      if (t) return clip(t, maxName)
    }
    const alt = el.getAttribute('alt')
    if (alt && alt.trim()) return clip(alt.trim(), maxName)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder && placeholder.trim()) return clip(placeholder.trim(), maxName)
    const title = el.getAttribute('title')
    if (title && title.trim()) return clip(title.trim(), maxName)
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'button') {
      const value = el.getAttribute('value')
      if (value && value.trim()) return clip(value.trim(), maxName)
    }
    // Non-interactive content elements carry their own direct text as the name.
    return clip(ownText(el, maxText), maxName)
  }

  function assignRef(el) {
    const ref = 'e' + String(lastRefs.length + 1)
    lastRefs.push(el)
    try { el.setAttribute('data-dsh-ref', ref) } catch (_) { /* foreign objects */ }
    return ref
  }

  function buildNode(el, opts, state) {
    const role = roleOf(el) || 'generic'
    const actionable = isActionable(el, role)
    if (opts.interactiveOnly && !actionable) {
      const kids = []
      for (const child of el.children) {
        if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
        if (!isVisible(child)) continue
        const node = buildNode(child, opts, state)
        if (node) kids.push(node)
      }
      return kids.length ? { role: 'generic', name: '', children: kids } : null
    }
    state.count += 1
    if (state.count > opts.maxNodes) {
      state.truncated = true
      return null
    }
    const node = { role, name: nameOf(el, opts.maxNameLength, opts.maxTextLength) }
    if (actionable) node.ref = assignRef(el)
    if (role === 'heading') {
      const m = /^h([1-6])$/.exec(el.tagName.toLowerCase())
      if (m) node.level = Number(m[1])
    }
    if (el.tagName.toLowerCase() === 'input' && (role === 'checkbox' || role === 'radio')) node.checked = !!el.checked
    if (role === 'option') node.selected = !!el.selected
    if (el.disabled) node.disabled = true
    if (role === 'link') {
      const href = el.getAttribute('href')
      if (href && href.trim() && href.indexOf('javascript:') !== 0) node.href = href
    }
    if (role === 'iframe') {
      try {
        if (el.contentDocument && el.contentDocument.body && state.depth < 2) {
          state.depth += 1
          const kids = []
          for (const child of el.contentDocument.body.children) {
            if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
            const sub = buildNode(child, opts, state)
            if (sub) kids.push(sub)
          }
          state.depth -= 1
          node.children = kids
          return node
        }
      } catch (_) { /* cross-origin frame */ }
      node.children = []
      if (!node.name) node.name = '(frame)'
      return node
    }
    const kids = []
    for (const child of el.children) {
      if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
      // Collapsed native <select> options have zero layout rects but stay
      // part of the element's accessibility tree: include them regardless.
      const isOption = child.tagName.toLowerCase() === 'option' && el.tagName.toLowerCase() === 'select'
      if (!isOption && !isVisible(child)) continue
      const sub = buildNode(child, opts, state)
      if (sub) kids.push(sub)
    }
    node.children = kids
    if (!actionable && !node.name && !kids.length && !node.checked && !node.selected && !node.disabled) return null
    return node
  }

  window.__dshSnapshot = (opts) => {
    for (const el of lastRefs) {
      try { el.removeAttribute('data-dsh-ref') } catch (_) { /* ignore */ }
    }
    lastRefs = []
    const o = {
      interactiveOnly: !!opts.interactiveOnly,
      maxNodes: opts.maxNodes || 500,
      maxNameLength: opts.maxNameLength || 120,
      maxTextLength: opts.maxTextLength || 300,
    }
    const state = { count: 0, truncated: false, depth: 0 }
    const nodes = []
    if (document.body) {
      for (const child of document.body.children) {
        if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
        if (!isVisible(child)) continue
        const node = buildNode(child, o, state)
        if (node) nodes.push(node)
      }
    }
    return { nodes, truncated: state.truncated, totalRefs: lastRefs.length }
  }

  window.__dshPageData = (opts) => {
    const o = { maxTextChars: opts.maxTextChars || 30000, maxLinks: opts.maxLinks || 300, maxInputs: opts.maxInputs || 200 }
    const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim()
    const links = []
    for (const a of document.querySelectorAll('a[href]')) {
      if (links.length >= o.maxLinks) break
      const label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      links.push({ text: label, href: a.getAttribute('href') })
    }
    const inputs = []
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (inputs.length >= o.maxInputs) break
      const tag = el.tagName.toLowerCase()
      let label = ''
      if (el.id) {
        try {
          const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
          if (labelEl) label = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
        } catch (_) { /* ignore */ }
      }
      if (!label) {
        const labelEl = el.closest('label')
        if (labelEl) label = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
      }
      let value = el.value || ''
      if (tag === 'select' && el.selectedOptions && el.selectedOptions[0]) value = el.selectedOptions[0].textContent
      inputs.push({ tag, type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', value, label: label.slice(0, 200), checked: tag === 'input' ? !!el.checked : null })
    }
    return {
      url: location.href,
      title: document.title,
      text: text.length > o.maxTextChars ? text.slice(0, o.maxTextChars) + '…' : text,
      truncated: text.length > o.maxTextChars,
      links,
      inputs,
    }
  }
})();
`