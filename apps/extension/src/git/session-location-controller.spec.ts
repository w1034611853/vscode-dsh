import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshBackend, SessionLocation } from '@dsh-vscode/domain'
import type { SessionNavigation } from '../composition/session-navigation.js'
import type * as vscode from 'vscode'
import type * as GitExecutor from './git-executor.js'
import { SessionLocationController } from './session-location-controller.js'

const native = vi.hoisted(() => ({
  trusted: true,
  folder: '/repo/main',
  bar: {
    text: '',
    tooltip: '',
    backgroundColor: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  },
  warning: vi.fn(),
  error: vi.fn(),
  pick: vi.fn(),
  execute: vi.fn(),
  stat: vi.fn(),
  git: vi.fn(),
}))
vi.mock('vscode', () => ({
  window: {
    createStatusBarItem: () => native.bar,
    showWarningMessage: native.warning,
    showErrorMessage: native.error,
    showQuickPick: native.pick,
  },
  workspace: {
    get isTrusted() {
      return native.trusted
    },
    get workspaceFolders() {
      return [{ uri: { fsPath: native.folder } }]
    },
  },
  StatusBarAlignment: { Left: 1 },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  commands: { executeCommand: native.execute },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}))
vi.mock('node:fs/promises', () => ({ stat: native.stat }))
vi.mock('./git-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecutor>()),
  executeGitCommand: native.git,
}))
const controllers: SessionLocationController[] = []
beforeEach(() => {
  vi.clearAllMocks()
  native.trusted = true
  native.folder = '/repo/main'
  native.warning.mockResolvedValue(undefined)
  native.stat.mockResolvedValue({ isDirectory: () => true })
  native.execute.mockResolvedValue(undefined)
  native.git.mockResolvedValue('feature\n')
})
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
function fixture(frames: readonly SessionLocation[] = []): {
  controller: SessionLocationController
  get: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  follow: ReturnType<typeof vi.fn>
  disposed: ReturnType<typeof vi.fn>
} {
  const disposed = vi.fn()
  const follow = vi.fn(async function* (_id: string, signal: AbortSignal): AsyncGenerator<SessionLocation> {
    try {
      for (const frame of frames) yield frame
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
    } finally {
      disposed()
    }
  })
  const get = vi.fn().mockResolvedValue({
    id: 's1',
    cwd: '/repo/main',
    projection: { values: { workingDirectory: '/repo/feature' } },
  })
  const update = vi.fn().mockResolvedValue(undefined)
  const open = vi.fn().mockResolvedValue(undefined)
  const backend = {
    connection: {
      endpoint: { host: '127.0.0.1', port: 4000, baseUrl: 'http://127.0.0.1:4000' },
      ownership: 'external',
      localDesktopPairing: true,
    },
    sessionLocation: { follow },
    sessions: { get },
    workspaces: { listArchivedSessionIds: (): Promise<string[]> => Promise.resolve([]) },
  } as unknown as DshBackend
  const navigation = {
    activeSessionId: 's1',
    onDidChange: () => ({ dispose: vi.fn() }),
    open,
  } as unknown as SessionNavigation
  const controller = new SessionLocationController({
    backendService: { requireBackend: () => backend },
    sessionNavigation: navigation,
    context: { globalState: { update } as unknown as vscode.ExtensionContext['globalState'] },
  })
  controllers.push(controller)
  return { controller, get, update, open, follow, disposed }
}
const location = (directory: string): SessionLocation => ({
  directory,
  checkout: { state: 'ready', root: directory, branch: 'feature', linked: true },
})
describe('native Session location surface', () => {
  it('reads the matching WSL checkout with local Git when official inspection fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    fixture([{ directory: '\\\\wsl.localhost\\Ubuntu\\repo\\feature', checkout: { state: 'failed' } }])
    await vi.waitFor(() => expect(native.bar.text).toContain('feature · feature'))
    expect(native.git).toHaveBeenCalledWith(
      '/repo/feature',
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      expect.any(AbortSignal),
    )
    expect(native.bar.tooltip).toContain('Git 只读查询')
  })
  it('does not overwrite a newer official directory with a delayed local Git result', async () => {
    let resolveGit: (value: string) => void = () => undefined
    native.git.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGit = resolve
      }),
    )
    fixture([{ directory: '/repo/old', checkout: { state: 'failed' } }, location('/repo/new')])
    await vi.waitFor(() => expect(native.bar.text).toContain('new · feature'))
    resolveGit('old-branch\n')
    await Promise.resolve()
    await Promise.resolve()
    expect(native.bar.text).toContain('new · feature')
  })
  it('shows branch, warns once for a directory change, and releases the stream', async () => {
    const f = fixture([location('/repo/main'), location('/repo/feature'), location('/repo/feature')])
    await vi.waitFor(() => expect(native.warning).toHaveBeenCalledTimes(1))
    expect(native.bar.text).toContain('feature')
    expect(native.bar.tooltip).toContain('/repo/feature')
    expect(native.warning).toHaveBeenCalledWith(expect.stringContaining('/repo/main'), '打开目录并继续')
    f.controller.dispose()
    await vi.waitFor(() => expect(f.disposed).toHaveBeenCalledOnce())
  })
  it('opens the freshly read effective directory and preserves the original session id', async () => {
    const f = fixture([location('/repo/main')])
    await f.controller.open()
    expect(f.get).toHaveBeenCalledWith('s1', expect.any(AbortSignal))
    expect(f.update).toHaveBeenCalledWith(
      'dsh.workspace.browserHandoff',
      expect.objectContaining({
        path: '/repo/feature',
        sessionId: 's1',
        source: 'session-location',
        origin: 'http://127.0.0.1:4000',
        desktopPairing: true,
      }),
    )
    expect(native.execute).toHaveBeenCalledWith(
      'vscode.openFolder',
      { fsPath: '/repo/feature' },
      { forceReuseWindow: true },
    )
    expect(f.open).not.toHaveBeenCalled()
  })
  it('continues locally without reopening the current folder', async () => {
    native.folder = '/repo/feature'
    const f = fixture()
    await f.controller.open()
    expect(f.open).toHaveBeenCalledWith('s1', false, expect.any(AbortSignal))
    expect(native.execute).not.toHaveBeenCalled()
  })
  it('maps matching WSL paths and refuses missing or untrusted destinations', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    const f = fixture()
    f.get.mockResolvedValue({
      id: 's1',
      projection: { values: { workingDirectory: '\\\\wsl.localhost\\Ubuntu\\repo\\feature' } },
    })
    await f.controller.open()
    expect(native.execute).toHaveBeenCalledWith(
      'vscode.openFolder',
      { fsPath: '/repo/feature' },
      { forceReuseWindow: true },
    )
    native.execute.mockClear()
    native.stat.mockResolvedValue({ isDirectory: () => false })
    await f.controller.open()
    native.trusted = false
    await f.controller.open()
    expect(native.execute).not.toHaveBeenCalled()
    expect(native.error).toHaveBeenCalledTimes(2)
  })
  it('does not subscribe in an untrusted workspace', () => {
    native.trusted = false
    const f = fixture()
    expect(f.follow).not.toHaveBeenCalled()
    expect(native.bar.hide).toHaveBeenCalled()
  })
})
