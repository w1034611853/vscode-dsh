import { describe, expect, it } from 'vitest'
import { isLoopbackEndpoint, parseServerOrigin } from './server-origin.js'

describe('server origin loopback classification', () => {
  it('recognizes IPv4, localhost, and IPv6 loopback origins', () => {
    for (const value of ['http://127.0.0.1:1464', 'http://localhost:1464', 'http://[::1]:1464']) {
      const endpoint = parseServerOrigin(value)
      expect(endpoint).toBeDefined()
      expect(isLoopbackEndpoint(endpoint!)).toBe(true)
    }
  })

  it('does not classify non-loopback IPv6 origins as local', () => {
    const endpoint = parseServerOrigin('http://[::2]:1464')
    expect(endpoint).toBeDefined()
    expect(isLoopbackEndpoint(endpoint!)).toBe(false)
  })
})
