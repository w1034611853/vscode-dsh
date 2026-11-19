import { describe, expect, it } from 'vitest'
import { wslUncPathToPosix } from './workspace-state.js'

describe('WSL workspace path mapping', () => {
  it('maps the current distribution Windows UNC spelling to its POSIX path', () => {
    expect(
      wslUncPathToPosix(
        '\\\\wsl.localhost\\HwUbuntu-24.04\\home\\w00640205\\codehub\\ai\\WirelessArchESL',
        'HwUbuntu-24.04',
      ),
    ).toBe('/home/w00640205/codehub/ai/WirelessArchESL')
  })

  it('supports the legacy wsl$ UNC host spelling', () => {
    expect(
      wslUncPathToPosix('\\\\wsl$\\HwUbuntu-24.04\\home\\project', 'HwUbuntu-24.04'),
    ).toBe('/home/project')
  })

  it('does not map another distribution or a non-WSL path', () => {
    expect(
      wslUncPathToPosix('\\\\wsl.localhost\\Ubuntu\\home\\project', 'HwUbuntu-24.04'),
    ).toBeUndefined()
    expect(wslUncPathToPosix('C:\\work\\project', 'HwUbuntu-24.04')).toBeUndefined()
    expect(wslUncPathToPosix('\\\\server\\share\\project', 'HwUbuntu-24.04')).toBeUndefined()
    expect(wslUncPathToPosix('\\\\wsl.localhost\\Ubuntu\\home\\project', undefined)).toBeUndefined()
  })

  it('rejects traversal segments instead of resolving them into a different directory', () => {
    expect(
      wslUncPathToPosix('\\\\wsl.localhost\\HwUbuntu-24.04\\home\\..\\etc', 'HwUbuntu-24.04'),
    ).toBeUndefined()
  })
})
