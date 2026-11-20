import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, type ConnectedBackend, type WorkspaceSummary } from '@dsh-vscode/domain'

vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))

import { createSessionScope } from './session-scope.js'

const distro = 'FixtureUbuntu'
const unc = (directory: string): string => `\\\\wsl.localhost\\${distro}${directory.replaceAll('/', '\\')}`
const workspace = (id: string, directory: string): WorkspaceSummary => ({
  id,
  name: id,
  path: directory,
  createdAt: '',
  updatedAt: '',
  sessionCount: 0,
  sessionIds: [],
})

describe('new main-repository folder beside registered worktree sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('registers the exact new main folder in the Desktop namespace and makes it available for session creation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('WSL_DISTRO_NAME', distro)
    const linked = { ...workspace('linked', unc('/repo/worktrees/feature')), sessionIds: ['old-session'] }
    const original = { ...workspace('original', unc('/elsewhere')), sessionIds: ['original-session'] }
    const main = workspace('main', unc('/repo/main'))
    const registry: WorkspaceSummary[] = [linked, original]
    // The configured endpoint is reachable before Desktop identity is verified.
    // The Windows Host can resolve UNC paths, not the WSL host's /repo spelling.
    const connection: ConnectedBackend = {
      endpoint: { host: '127.0.0.1', port: 43120, baseUrl: 'http://127.0.0.1:43120' },
      ownership: 'external',
      capabilities: {} as ConnectedBackend['capabilities'],
    }
    const create = vi.fn((input: { path: string }): Promise<WorkspaceSummary> => {
      if (input.path !== main.path)
        return Promise.reject(
          new AppError({ code: 'INVALID_CONFIGURATION', message: 'Invalid Host path', retryable: false }),
        )
      if (!registry.some((item) => item.id === main.id)) registry.push(main)
      return Promise.resolve(main)
    })
    const backend = {
      connection,
      workspaces: {
        listWithArchiveState: () =>
          Promise.resolve({ items: [...registry], archivedSessionIds: new Set<string>() }),
      },
    }
    const scope = createSessionScope({
      backendService: { requireBackend: () => backend },
      workspaceUseCases: { list: () => Promise.resolve([...registry]), create },
      temporaryWorkspaceManager: {},
      currentWorkspaceFolders: () => [{ uri: { fsPath: '/repo/main' } }],
      currentWorkspaceFolder: () => ({ uri: { fsPath: '/repo/main' } }),
    } as never)

    await expect(scope.readCurrentWorkspaceDirectory(new AbortController().signal)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      retryable: true,
    })
    backend.connection = { ...connection, localDesktopPairing: true }
    const directory = await scope.readCurrentWorkspaceDirectory(new AbortController().signal)
    expect(directory.workspaces).toEqual([main])
    expect(directory.registry.items).toEqual([linked, original, main])
    expect(create).toHaveBeenLastCalledWith({ name: 'main', path: main.path }, expect.any(AbortSignal))
    await expect(scope.ensureCurrentWorkspace(undefined)).resolves.toEqual(main)
    expect(create).toHaveBeenCalledTimes(2)
    expect(linked.sessionIds).toEqual(['old-session'])
    expect(original.sessionIds).toEqual(['original-session'])
  })
})
