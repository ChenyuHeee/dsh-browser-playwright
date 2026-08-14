/**
 * Model-facing browser tool family: navigate, snapshot with refs, click,
 * fill, press, scroll, history, tabs, screenshot, extract, evaluate, close.
 * Every tool acquires the calling session's browser context through
 * ctx.browser, so the browser persists across calls and sessions stay
 * isolated. Outputs follow the canonical-value + pure-render contract.
 * @module dsh-browser-playwright/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-session'
// Type-only: makes the ctx.browser declaration merge visible to this module.
import type {} from './service.ts'
import { BrowserError } from './errors.ts'
import { renderSnapshot } from './snapshot-render.ts'
import type { BrowserSession, BrowserSnapshot, LoadState } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-tool'

/** The browser runtime and tool registry this plugin consumes. */
export const inject = ['browser', 'tools']

/** Configuration for the browser tool family. */
export interface ToolConfig {
  /** Tool name prefix; final names are <prefix>navigate and so on. */
  toolPrefix: string
  /** Allow browser_evaluate (arbitrary page JavaScript). Defaults to false. */
  allowEvaluate: boolean
  /** Upper bound for browser_wait in milliseconds. */
  maxWaitMs: number
  /** Default value of the snapshot tool's interactiveOnly flag. */
  interactiveOnlyDefault: boolean
  /** Auxiliary extraction configuration; omitted means browser_extract is unconfigured. */
  extract?: {
    /** Auxiliary LLM provider route for browser_extract. */
    provider?: string
    /** Auxiliary model for browser_extract. */
    model?: string
    /** Page text characters fed to the extraction model. */
    maxInputChars: number
    /** Extraction output token budget. */
    maxOutputTokens: number
  }
}

/** Schemastery validation for {@link ToolConfig}. */
export const Config: z<ToolConfig> = z.object({
  toolPrefix: z.string().default('browser_'),
  allowEvaluate: z.boolean().default(false),
  maxWaitMs: z.number().default(60000),
  interactiveOnlyDefault: z.boolean().default(false),
  extract: z.object({
    provider: z.string(),
    model: z.string(),
    maxInputChars: z.number().default(20000),
    maxOutputTokens: z.number().default(2000),
  }),
})

/** Canonical snapshot value: bounded facts plus the rendered tree. */
interface SnapshotValue {
  url: string
  title: string
  refs: number
  truncated: boolean
  tree: string
}

const SNAPSHOT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    refs: { type: 'integer' },
    truncated: { type: 'boolean' },
    tree: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Project a provider snapshot into its canonical tool value. */
function snapshotValue(snapshot: BrowserSnapshot): SnapshotValue {
  return {
    url: snapshot.url,
    title: snapshot.title,
    refs: snapshot.totalRefs,
    truncated: snapshot.truncated,
    tree: renderSnapshot(snapshot),
  }
}

/** Render a snapshot value as one text block. */
function renderSnapshotValue(_args: unknown, value: SnapshotValue): ContentBlock[] {
  return [{ type: 'text', text: value.tree }]
}

/** Canonical tab listing. */
interface TabValue {
  tabs: { index: number; url: string; title: string }[]
}

const TABS_SCHEMA = {
  type: 'object',
  properties: {
    tabs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const

function renderTabsValue(_args: unknown, value: TabValue): ContentBlock[] {
  if (value.tabs.length === 0) return [{ type: 'text', text: 'No open tabs.' }]
  const lines = value.tabs.map(tab => String(tab.index) + '. ' + (tab.title || tab.url))
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Canonical screenshot value: the durable attachment facts. */
interface ScreenshotValue {
  attachmentId: string
  bytes: number
  width: number
  height: number
  url: string
}

const SCREENSHOT_SCHEMA = {
  type: 'object',
  properties: {
    attachmentId: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    url: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Render a screenshot as its summary plus the image block itself. */
function renderScreenshotValue(_args: unknown, value: ScreenshotValue): ContentBlock[] {
  const summary = 'Screenshot of ' + value.url + ': '
    + value.width + 'x' + value.height + ' px, ' + value.bytes + ' bytes (PNG attachment).'
  return [
    { type: 'text', text: summary },
    {
      type: 'image',
      attachment: {
        attachmentId: value.attachmentId as ImageAttachmentRef['attachmentId'],
        mediaType: 'image/png' as const,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
        name: 'browser-screenshot.png',
      },
    },
  ]
}

/** The attachments-service face consumed at execution time. */
interface AttachmentServiceLike {
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
}

/** The llm-service face consumed at execution time. */
interface LlmServiceLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Optional service faces consumed at execution time. */
interface OptionalServices {
  attachments?: AttachmentServiceLike
  llm?: LlmServiceLike
}

/** Strip markdown fences and whitespace, then parse one JSON document. */
function parseJsonText(raw: string): unknown {
  let text = raw.trim()
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text)
  if (fenced !== null) {
    const inner = fenced[1]
    if (inner !== undefined) text = inner.trim()
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('browser_extract: the model output is not valid JSON: ' + text.slice(0, 500))
  }
}

/** Prompt template for structured page extraction. */
function extractionPrompt(instruction: string, data: unknown): string {
  return 'Extract the following from the page data according to the instruction. '
    + 'Answer with ONLY one valid JSON value (object, array, or scalar), no prose, no markdown fences.\n\n'
    + 'Instruction: ' + instruction + '\n\n'
    + 'Page data (JSON):\n' + JSON.stringify(data)
}

/**
 * Register the browser tool family on ctx.tools.
 * @param ctx - plugin context carrying browser, tools, and the optional services.
 * @param config - tool naming and safety configuration.
 */
export function apply(ctx: Context, config: ToolConfig): void {
  if (!/^[a-z][a-z0-9_]*$/.test(config.toolPrefix)) {
    throw new Error('browser-tool: toolPrefix must match [a-z][a-z0-9_]*')
  }
  const p = (base: string): string => config.toolPrefix + base

  /** Resolve the calling session's browser owner key. */
  const ownerFor = (exec: ToolExecution): string => {
    const id = exec.agent?.session.id
    return id === undefined ? 'anonymous' : String(id)
  }

  /** Acquire the calling session's live browser session. */
  const acquire = (exec: ToolExecution): Promise<BrowserSession> =>
    ctx.browser.acquire(ownerFor(exec), exec.signal)

  const services = (): OptionalServices => {
    const out: OptionalServices = {}
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    if (attachments !== undefined) out.attachments = attachments as unknown as AttachmentServiceLike
    if (llm !== undefined) out.llm = llm as unknown as LlmServiceLike
    return out
  }

  ctx.tools.register(defineTool({
    name: p('navigate'),
    description: 'Navigate the persistent browser to a URL and return the new page snapshot. '
      + 'The snapshot lists visible elements with stable ref= identifiers for later click/fill calls.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      waitFor: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Load condition to wait for. Defaults to load.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      const waitUntil: LoadState = args.waitFor ?? 'load'
      return snapshotValue(await session.navigate(args.url, waitUntil, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('snapshot'),
    description: 'Return the current page snapshot: URL, title, and visible elements with stable ref= identifiers. '
      + 'Use this after dynamic content changes to refresh refs before clicking.',
    parameters: {
      interactiveOnly: { type: 'boolean', description: 'Return only actionable elements. Defaults to ' + String(config.interactiveOnlyDefault) + '.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      const interactiveOnly = args.interactiveOnly ?? config.interactiveOnlyDefault
      return snapshotValue(await session.snapshot({ interactiveOnly }))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('click'),
    description: 'Click the element with the given ref from the latest snapshot and return the new snapshot. '
      + 'Refs go stale after navigation or DOM changes: call ' + p('snapshot') + ' again if a ref fails.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Element ref (e.g. e12) from the latest snapshot.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      return snapshotValue(await session.click(args.ref, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('fill'),
    description: 'Replace the value of the input or select referenced by the latest snapshot. '
      + 'For <select> elements the text selects the matching option label.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Input or select ref (e.g. e7) from the latest snapshot.' },
      text: { type: 'string', required: true, description: 'Exact value to fill, or option label for selects.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      return snapshotValue(await session.fill(args.ref, args.text, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('press'),
    description: 'Press a keyboard key (e.g. Enter, Tab, ArrowDown, Escape) on the referenced element.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Element ref from the latest snapshot.' },
      key: { type: 'string', required: true, description: 'Key name to press, e.g. Enter, Escape, ArrowDown.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      return snapshotValue(await session.press(args.ref, args.key, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('scroll'),
    description: 'Scroll the page (or bring the referenced element into view) and return the new snapshot.',
    parameters: {
      direction: { type: 'string', enum: ['up', 'down'], required: true, description: 'Scroll direction.' },
      amount: { type: 'integer', description: 'Scroll distance in pixels. Defaults to 600.' },
      ref: { type: 'string', description: 'Optional element ref to scroll into view first.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      const amount = args.amount ?? 600
      return snapshotValue(await session.scroll(args.direction, amount, args.ref, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('back'),
    description: 'Navigate history back and return the new snapshot.',
    parameters: {},
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(_args, exec) {
      const session = await acquire(exec)
      return snapshotValue(await session.back(exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('forward'),
    description: 'Navigate history forward and return the new snapshot.',
    parameters: {},
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(_args, exec) {
      const session = await acquire(exec)
      return snapshotValue(await session.forward(exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('wait'),
    description: 'Wait a fixed duration for slow pages or lazy content to settle.',
    parameters: {
      ms: { type: 'integer', required: true, description: 'Milliseconds to wait, up to ' + String(config.maxWaitMs) + '.' },
    },
    output: { schema: { type: 'null' }, render: (_args, _value) => [{ type: 'text', text: 'Waited.' }] },
    async execute(args, exec) {
      if (!Number.isSafeInteger(args.ms) || args.ms <= 0 || args.ms > config.maxWaitMs) {
        throw new Error('browser_wait: ms must be a positive integer no larger than ' + String(config.maxWaitMs))
      }
      const session = await acquire(exec)
      await session.wait(args.ms, exec.signal)
      return null
    },
  }))

  ctx.tools.register(defineTool({
    name: p('tabs'),
    description: 'List the open tabs of this session with their indexes, URLs, and titles.',
    parameters: {},
    output: { schema: TABS_SCHEMA, render: renderTabsValue },
    async execute(_args, exec) {
      const session = await acquire(exec)
      const tabs = await session.tabs()
      return { tabs: tabs.map(tab => ({ index: tab.index, url: tab.url, title: tab.title })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: p('switch_tab'),
    description: 'Activate the tab at the given index and return its snapshot.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Tab index from ' + p('tabs') + '.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      return snapshotValue(await session.switchTab(args.index, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('open_tab'),
    description: 'Open a new tab at the given URL and return its snapshot.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open in the new tab.' },
      waitFor: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Load condition to wait for. Defaults to load.' },
    },
    output: { schema: SNAPSHOT_SCHEMA, render: renderSnapshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      const waitUntil: LoadState = args.waitFor ?? 'load'
      return snapshotValue(await session.openTab(args.url, waitUntil, exec.signal))
    },
  }))

  ctx.tools.register(defineTool({
    name: p('close_tab'),
    description: 'Close the tab at the given index. Closing the last tab resets it to a blank page.',
    parameters: {
      index: { type: 'integer', required: true, description: 'Tab index from ' + p('tabs') + '.' },
    },
    output: { schema: { type: 'null' }, render: (_args, _value) => [{ type: 'text', text: 'Tab closed.' }] },
    async execute(args, exec) {
      const session = await acquire(exec)
      await session.closeTab(args.index, exec.signal)
      return null
    },
  }))

  ctx.tools.register(defineTool({
    name: p('screenshot'),
    description: 'Capture a PNG screenshot of the current page (or the referenced element) and store it '
      + 'as a durable image attachment the model can view.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
      ref: { type: 'string', description: 'Optional element ref to capture instead of the page.' },
    },
    output: { schema: SCREENSHOT_SCHEMA, render: renderScreenshotValue },
    async execute(args, exec) {
      const session = await acquire(exec)
      const capture = await session.screenshot({
        fullPage: args.fullPage ?? false,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      }, exec.signal)
      const attachments = services().attachments
      if (attachments === undefined) {
        throw new Error('browser_screenshot needs the attachments service; mount @deepseek-ai/dsh-attachment with a provider such as @deepseek-ai/dsh-attachment-local')
      }
      const ref = await attachments.saveImage({
        data: capture.bytes,
        mediaType: 'image/png',
        name: 'browser-screenshot.png',
      })
      const url = (await session.snapshot()).url
      return {
        attachmentId: String(ref.attachmentId),
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        url,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: p('extract'),
    description: 'Extract structured data from the current page: describe what you want in plain language, '
      + 'and the tool returns one parsed JSON value built from the page content. Requires the extract '
      + 'provider/model configuration.',
    parameters: {
      instruction: { type: 'string', required: true, description: 'What to extract, e.g. "all product names and prices as {name, price} objects".' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const extract = config.extract ?? { maxInputChars: 20000, maxOutputTokens: 2000 }
      const { provider, model } = extract
      if (provider === undefined || model === undefined) {
        throw new Error('browser_extract is not configured: set extract.provider and extract.model in the browser-tool plugin config')
      }
      const llm = services().llm
      if (llm === undefined) {
        throw new Error('browser_extract needs the llm service; the harness composition must mount @deepseek-ai/dsh-llm')
      }
      const session = await acquire(exec)
      const data = await session.pageData()
      const options: GenerateOptions = {
        provider,
        model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: extractionPrompt(args.instruction, data) }],
          source: { kind: 'plugin', plugin: name },
        })],
        system: 'You are a structured data extraction engine. Respond with exactly one JSON value and nothing else.',
        temperature: 0,
        maxTokens: extract.maxOutputTokens,
        signal: exec.signal,
      }
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      const finish = assembler.finish
      if (finish !== undefined && (finish as { kind?: unknown }).kind !== 'stop') {
        throw new Error('browser_extract: extraction ended with finish reason ' + String((finish as { kind?: unknown }).kind))
      }
      const blocks = assembler.blocks()
      const text = blocks
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(' ')
      return parseJsonText(text) as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: p('evaluate'),
    description: 'Evaluate one JavaScript expression in the page and return its JSON-serializable result. '
      + 'Disabled by default; the deployment must enable allowEvaluate.',
    parameters: {
      expression: { type: 'string', required: true, description: 'Single JavaScript expression, e.g. document.title or Array.from(document.querySelectorAll("h2")).map(e => e.textContent).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!config.allowEvaluate) {
        throw new BrowserError('EVALUATE_DISABLED', 'browser_evaluate is disabled; set allowEvaluate: true on the browser-tool plugin to enable arbitrary page JavaScript')
      }
      const session = await acquire(exec)
      return await session.evaluate(args.expression, exec.signal) as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: p('close'),
    description: 'Close this session\'s browser (all tabs and cookies). The next browser call starts a fresh session.',
    parameters: {},
    output: { schema: { type: 'null' }, render: (_args, _value) => [{ type: 'text', text: 'Browser session closed.' }] },
    async execute(_args, exec) {
      const session = await acquire(exec)
      await session.close()
      return null
    },
  }))
}
