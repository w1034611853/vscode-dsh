import { AppError, type SessionLocation, type SessionLocationRepository } from '@dsh-vscode/domain'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'

/** Official forgePanel/follow at 9c2670d3bce5275e0d1610272958121af87787bb. */
export class Rc225SessionLocationRepository implements SessionLocationRepository {
  constructor(private readonly transport: Pick<AlphaLoopbackApiClient, 'openRemoteStream'>) {}
  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<SessionLocation> {
    for await (const raw of this.transport.openRemoteStream('forgePanel/follow', { sessionId }, signal)) {
      if (signal.aborted) return
      yield parseSessionLocation(raw)
    }
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed()
  return value as Record<string, unknown>
}
function directory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value)
  )
    throw malformed()
  return value
}
export function parseSessionLocation(value: unknown): SessionLocation {
  const raw = record(value)
  const cwd = directory(raw.directory)
  const checkout = record(raw.checkout)
  if (checkout.state === 'pending' || checkout.state === 'none' || checkout.state === 'failed')
    return { directory: cwd, checkout: { state: checkout.state } }
  if (checkout.state !== 'ready') throw malformed()
  const facts = record(checkout.checkout)
  if (
    (facts.branch !== null && (typeof facts.branch !== 'string' || facts.branch.length === 0)) ||
    typeof facts.linked !== 'boolean'
  )
    throw malformed()
  return {
    directory: cwd,
    checkout: {
      state: 'ready',
      root: directory(facts.root),
      branch: facts.branch,
      linked: facts.linked,
    },
  }
}
function malformed(): AppError {
  return new AppError({ code: 'PROTOCOL_ERROR', message: 'Invalid DSH location state.', retryable: false })
}
