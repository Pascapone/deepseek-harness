/** Host registry for model-visible, read-only Cordis capability queries. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type {
  CordisInspectMethodManifest, CordisInspectPlatform, CordisInspectProviderManifest,
  CordisInspectProviderView, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, CordisInspectResolveAck,
} from './types.ts'

/** Context supplied to a Host inspect query. */
export interface HostCordisInspectQueryContext {
  /** Tool-call cancellation. */
  signal: AbortSignal
  /** Agent whose scoped runtime is being inspected. */
  agent: Agent
}

/** Local registration paired with its serializable manifest. */
export interface HostCordisInspectProviderRegistration {
  /** Provider and explicit method directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared method. */
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

/** Bounds for cross-page inspect queries, in milliseconds. */
export interface InspectConfig {
  /** Hard deadline for a Client query, including any error grace period. */
  inspectQueryTimeoutMs?: number
  /** Non-resetting grace after the first page failure for another page to succeed. */
  inspectQueryErrorGraceMs?: number
}

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
  settle(resolution: CordisInspectQueryResolution): void
  fail(resolution: Extract<CordisInspectQueryResolution, { ok: false }>): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host registry for Cordis inspect providers and Client manifest/query routing. */
    cordisInspect: CordisInspectRegistryService
  }
}

/** Registry and cross-page router behind the two model-facing inspect tools. */
export class CordisInspectRegistryService extends Service {
  static Config: z<InspectConfig> = z.object({
    inspectQueryTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
    inspectQueryErrorGraceMs: z.number().step(1).min(0).max(2_147_483_647).default(250),
  })

  private readonly config: Required<InspectConfig>
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /** Register the process-global Host registry. */
  constructor(ctx: Context, config: InspectConfig = {}) {
    super(ctx, 'cordisInspect')
    this.config = CordisInspectRegistryService.Config(config) as Required<InspectConfig>
    ctx.effect(() => () => {
      for (const pending of this.pending.values()) {
        pending.settle({ ok: false, reason: 'cancelled', message: 'Client inspect registry was disposed' })
      }
    }, 'cordisInspect: pending queries')
  }

  /**
   * Register one Host provider.
   * @param registration - manifest and local query handler.
   * @returns idempotent disposer.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    const stored = { ...registration, manifest }
    this.providers.set(manifest.id, stored)
    return () => {
      if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id)
    }
  }

  /**
   * Replace the mirrored Client provider directory.
   * @param providers - complete Client manifest snapshot.
   */
  syncClientManifest(providers: readonly CordisInspectProviderManifest[]): void {
    const ids = new Set<string>()
    const validated = providers.map((provider) => {
      const manifest = validateManifest(provider)
      if (ids.has(manifest.id)) throw new Error(`Client Cordis inspect manifest repeats provider "${manifest.id}"`)
      ids.add(manifest.id)
      return manifest
    })
    this.clientManifest = Object.freeze(validated)
  }

  /**
   * Return the complete known Host and Client provider directory.
   * @returns Host providers followed by the Client providers.
   */
  list(): CordisInspectProviderView[] {
    return [
      ...[...this.providers.values()].map(provider => view('host', provider.manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /**
   * Execute one provider query on its owning platform.
   * @param platform - Host or Client runtime.
   * @param providerId - provider selected from {@link list}.
   * @param methodName - declared method name.
   * @param input - optional lossless JSON input.
   * @param agent - requesting Agent and scope.
   * @param signal - tool-call cancellation.
   * @returns provider JSON data; Client queries reject on cancellation, deadline,
   * or the first failure after its grace period unless a valid response wins.
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (platform === 'host') {
      const registration = this.providers.get(providerId)
      if (registration === undefined) throw new Error(`Host Cordis inspect provider "${providerId}" is not registered`)
      const method = findMethod(registration.manifest, methodName)
      validateInput('Host', providerId, method, input)
      signal.throwIfAborted()
      const data = await registration.query(methodName, input, { agent, signal })
      signal.throwIfAborted()
      return validateOutput('Host', providerId, method, data)
    }
    return await this.queryClient(providerId, methodName, input, agent, signal)
  }

  /**
   * Accept the first valid Client response; retain the first failure for bounded error grace.
   * @param agent - Agent whose Session owns the query.
   * @param requestId - Pending Client query identity.
   * @param resolution - Client provider result or failure.
   * @returns whether this response settled the still-pending query.
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    if (!resolution.ok) {
      pending.fail(resolution)
      return { accepted: false }
    }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch (error) {
      pending.fail({ ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : String(error) })
      return { accepted: false }
    }
    pending.settle(resolution)
    return { accepted: true }
  }

  private async queryClient(
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.clientManifest?.find(candidate => candidate.id === providerId)
    if (provider === undefined) throw new Error(`Client Cordis inspect provider "${providerId}" is not registered`)
    const method = findMethod(provider, methodName)
    validateInput('Client', providerId, method, input)
    signal.throwIfAborted()
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: providerId,
      method: methodName,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      let errorTimer: ReturnType<typeof setTimeout> | undefined
      let firstFailure: Extract<CordisInspectQueryResolution, { ok: false }> | undefined
      const settle = (resolution: CordisInspectQueryResolution): void => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timeout)
        clearTimeout(errorTimer)
        signal.removeEventListener('abort', onAbort)
        resolve(resolution)
        void this.ctx.parallel('cordis/inspect-query-resolved', { requestId }).catch((error: unknown) => {
          console.error(`[cordis-host-runner] notifying inspect settlement ${requestId} failed:`, error)
        })
      }
      const onAbort = (): void => {
        settle({ ok: false, reason: 'cancelled', message: `Client inspect query ${providerId}.${methodName} was cancelled` })
      }
      const timeout = setTimeout(() => {
        settle(firstFailure ?? {
          ok: false,
          reason: 'provider-error',
          message: `Client inspect query timed out after ${this.config.inspectQueryTimeoutMs}ms; no valid page response. Check that a connected page has this provider, then retry.`,
        })
      }, this.config.inspectQueryTimeoutMs)
      this.pending.set(requestId, {
        request, method, settle,
        fail: (resolution) => {
          if (firstFailure !== undefined) return
          firstFailure = resolution
          // ponytail: bounded grace, not a page census; slower successful pages require a larger configured grace.
          errorTimer = setTimeout(() => { settle(resolution) }, this.config.inspectQueryErrorGraceMs)
        },
      })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      else {
        try {
          this.ctx.emit('cordis/inspect-query', request)
        } catch (error) {
          settle({ ok: false, reason: 'provider-error', message: error instanceof Error ? error.message : String(error) })
        }
      }
    })
    const resolution = await result
    if (!resolution.ok) throw new Error(`${providerId}.${methodName}: ${resolution.message}`)
    return resolution.data
  }
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method === undefined) throw new Error(`Cordis inspect provider "${manifest.id}" has no method "${name}"`)
  return method
}

function validateInput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  input: JsonValue | undefined,
): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`)
}

function validateOutput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  data: JsonValue,
): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned a non-JSON value`)
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`)
  return snapshot
}
