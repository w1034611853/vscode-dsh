import { describe, expect, it } from 'vitest'
import { isDesktopLocationHandoff } from './session-location-handoff.js'

describe('Desktop directory handoff eligibility', () => {
  const now = 1_000_000
  const origin = 'http://127.0.0.1:4000'
  const pending = {
    source: 'session-location',
    desktopPairing: true,
    origin,
    path: '/repo/feature',
    sessionId: 's1',
    time: now - 1000,
  }
  it('only requests pairing verification for a recent matching native handoff', () => {
    expect(isDesktopLocationHandoff(pending, origin, ['/repo/feature'], now)).toBe(true)
    for (const changed of [
      { desktopPairing: false },
      { source: 'other' },
      { origin: 'http://127.0.0.1:5000' },
      { path: '/repo/other' },
      { sessionId: '' },
      { time: now + 1 },
      { time: now - 300001 },
      { time: NaN },
    ])
      expect(isDesktopLocationHandoff({ ...pending, ...changed }, origin, ['/repo/feature'], now)).toBe(false)
    expect(isDesktopLocationHandoff(null, origin, ['/repo/feature'], now)).toBe(false)
  })
})
