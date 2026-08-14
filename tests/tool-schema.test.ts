import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'
import * as browserTool from '../src/tool.ts'
import type { ToolConfig } from '../src/tool.ts'

const pwConfig: PlaywrightConfig = {
  launch: { channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 }, navigationTimeoutMs: 5000, ignoreHTTPSErrors: false },
  idleTimeoutMs: 0,
  maxSessions: 2,
  snapshot: { maxNodes: 200, maxNameLength: 120, maxTextLength: 300 },
}

const toolConfig: ToolConfig = {
  toolPrefix: 'browser_',
  allowEvaluate: false,
  maxWaitMs: 60000,
  interactiveOnlyDefault: false,
}

test('every browser tool registers with its schema in one assembled context', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(pwConfig))
  browserTool.apply(root, toolConfig)

  const names = root.tools.schemas().map(schema => schema.name).sort()
  assert.deepEqual(names, [
    'browser_back',
    'browser_click',
    'browser_close',
    'browser_close_tab',
    'browser_evaluate',
    'browser_extract',
    'browser_fill',
    'browser_forward',
    'browser_navigate',
    'browser_open_tab',
    'browser_press',
    'browser_screenshot',
    'browser_scroll',
    'browser_snapshot',
    'browser_switch_tab',
    'browser_tabs',
    'browser_wait',
  ])

  // Spot-check the wire projection of one schema.
  const navigate = root.tools.schemas().find(schema => schema.name === 'browser_navigate')
  assert.ok(navigate !== undefined)
  assert.match(navigate.description, /navigate/i)
  const params = navigate.parameters as { properties: Record<string, unknown>; required: string[] }
  assert.deepEqual(params.required, ['url'])
  assert.ok('waitFor' in params.properties)

})

test('tool names respect the configured prefix', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(pwConfig))
  browserTool.apply(root, { ...toolConfig, toolPrefix: 'web_' })
  assert.ok(root.tools.schemas().some(schema => schema.name === 'web_click'))
})

test('invalid tool prefixes fail plugin load', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  assert.throws(() => browserTool.apply(root, { ...toolConfig, toolPrefix: 'Bad-Prefix!' }), /toolPrefix/)
})
