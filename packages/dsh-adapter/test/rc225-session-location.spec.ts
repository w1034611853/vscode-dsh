import { describe, expect, it, vi } from 'vitest'
import {
  parseSessionLocation,
  Rc225SessionLocationRepository,
} from '../src/versions/rc225/session-location.js'

const frame = {
  directory: '/repo/feature',
  checkout: {
    state: 'ready',
    checkout: {
      root: '/repo/feature',
      branch: 'feature',
      linked: true,
      commit: 'abc',
    },
  },
  repository: { privateData: 'not forwarded' },
}
describe('official rc225 Forge location contract', () => {
  it('projects only directory and checked-out branch facts', () => {
    expect(parseSessionLocation(frame)).toEqual({
      directory: '/repo/feature',
      checkout: {
        state: 'ready',
        root: '/repo/feature',
        branch: 'feature',
        linked: true,
      },
    })
    expect(
      parseSessionLocation({ directory: '/tmp', checkout: { state: 'failed', message: 'private failure' } }),
    ).toEqual({ directory: '/tmp', checkout: { state: 'failed' } })
    for (const state of ['none', 'pending'])
      expect(parseSessionLocation({ directory: '/tmp', checkout: { state } }).checkout.state).toBe(state)
  })
  it('rejects malformed paths and branch facts without exposing payloads', () => {
    for (const bad of [
      null,
      { ...frame, directory: '../private' },
      { ...frame, directory: '/bad\0path' },
      { ...frame, checkout: { state: 'ready', checkout: { root: '/repo', branch: 1, linked: true } } },
      { ...frame, checkout: { state: 'unknown' } },
    ])
      expect(() => parseSessionLocation(bad)).toThrow('Invalid DSH location state.')
  })
  it('uses the native Session argument, propagates cancellation and closes the iterator', async () => {
    let closed = false
    const stream = vi.fn(async function* (
      _endpoint: string,
      _args: Record<string, unknown>,
      _signal?: AbortSignal,
    ): AsyncGenerator<unknown> {
      try {
        yield await Promise.resolve(frame)
        yield await Promise.resolve(frame)
      } finally {
        closed = true
      }
    })
    const source = new Rc225SessionLocationRepository({ openRemoteStream: stream })
    const control = new AbortController()
    for await (const location of source.follow('session-fixture', control.signal)) {
      expect(location.directory).toBe('/repo/feature')
      control.abort()
    }
    // Published typert.remote-client: the Session lookup parameter's wire name is sessionId.
    expect(stream).toHaveBeenCalledWith('forgePanel/follow', { sessionId: 'session-fixture' }, control.signal)
    expect(closed).toBe(true)
  })
})
