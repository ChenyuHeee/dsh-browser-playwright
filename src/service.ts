/**
 * Browser capability seam: the provider registry and selection service.
 * Providers implement browser backends; consumers acquire sessions through
 * ctx.browser without importing a concrete implementation.
 * @module dsh-browser-playwright/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserError } from './errors.ts'
import type { BrowserProvider, BrowserSession } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/** Selection config for the browser seam. */
export interface BrowserRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one is registered. */
  readonly provider?: string
}

/** Schemastery validation for {@link BrowserRuntimeConfig}. */
export const Config: z<BrowserRuntimeConfig> = z.object({
  provider: z.string(),
})

/**
 * The browser service, registered as ctx.browser (one instance per context).
 * Selection semantics (resolved at acquire time, never order-dependent):
 * - A configured id that is registered → that provider.
 * - A configured id not registered → CONFIGURED_PROVIDER_MISSING.
 * - No id configured, exactly one registered provider → that provider.
 * - No id configured, multiple registered providers → AMBIGUOUS_PROVIDER.
 * - No registered provider → NO_PROVIDER.
 */
export default class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = Config

  private readonly providers = new Map<string, BrowserProvider>()
  private readonly configuredId: string | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.configuredId = config.provider
    // Unloading this plugin disposes every registered provider's resources.
    this.ctx.effect(() => () => {
      for (const provider of this.providers.values()) void provider.dispose()
      this.providers.clear()
    })
  }

  /**
   * Register a browser provider. Duplicate ids fail the registering plugin.
   * @param provider - the provider; its id is the registry key.
   * @returns the disposer that unregisters and disposes the provider.
   */
  registerProvider(provider: BrowserProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new BrowserError('AMBIGUOUS_PROVIDER', 'a browser provider with id "' + provider.id + '" is already registered')
    }
    const runtime = this
    const dispose = this.ctx.effect(function* () {
      runtime.providers.set(provider.id, provider)
      yield () => {
        runtime.providers.delete(provider.id)
        void provider.dispose()
      }
    }, 'browser.registerProvider()')
    return () => void dispose()
  }

  /**
   * Acquire the session owned by the owner key through the selected provider.
   * @param owner - opaque caller-owned session key (a harness session id).
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the live browser session.
   */
  async acquire(owner: string, signal?: AbortSignal): Promise<BrowserSession> {
    return this.resolveProvider().acquire(owner, signal)
  }

  /**
   * Release the session owned by the owner key on every registered provider;
   * providers ignore unknown owners.
   * @param owner - the owner key whose session should be released.
   */
  async disposeOwner(owner: string): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.disposeOwner(owner)
    }
  }

  private resolveProvider(): BrowserProvider {
    const { configuredId, providers } = this
    if (configuredId !== undefined) {
      const provider = providers.get(configuredId)
      if (provider === undefined) {
        throw new BrowserError('CONFIGURED_PROVIDER_MISSING', 'configured browser provider "' + configuredId + '" is not registered')
      }
      return provider
    }
    const registered = [...providers.values()]
    const [single] = registered
    if (single === undefined) {
      throw new BrowserError('NO_PROVIDER', 'no browser provider is registered; mount the playwright entry of this package')
    }
    if (registered.length > 1) {
      throw new BrowserError('AMBIGUOUS_PROVIDER', 'multiple browser providers are registered (' + registered.map(p => p.id).join(', ') + '); configure one explicitly')
    }
    return single
  }
}
