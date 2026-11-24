import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import type { BackendService, WorkspaceUseCases } from '@dsh-vscode/application'
import type { DshBackend, SessionDetail, SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import type { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'

vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))

import { createSessionScope } from './session-scope.js'
import { listScopedSessions, type DirectoryDependencies } from './session-directory.js'

const directory = (id: string, path: string): WorkspaceSummary => ({
  id,
  path,
  name: id,
  sessionIds: [],
  sessionCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

describe('session list/open workspace identity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it.each(['ordinary-folder', 'worktree', 'wsl', 'unregistered-header'] as const)(
    'keeps a clicked session in the same sidebar group before and after refresh: %s',
    async (scenario) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      vi.stubEnv('WSL_DISTRO_NAME', 'FixtureUbuntu')
      const hostPath = scenario === 'worktree' ? '/fixture/worktrees/feature' : '/fixture/project'
      const runtimePath =
        scenario === 'wsl' ? `\\\\wsl.localhost\\FixtureUbuntu${hostPath.replaceAll('/', '\\')}` : hostPath
      const target = directory('current-registry', runtimePath)
      const original = { ...directory('original-registry', '/fixture/original'), sessionIds: ['fork'] }
      const raw: SessionDetail = {
        id: 'fork',
        workspaceId: scenario === 'unregistered-header' ? '' : original.id,
        cwd: scenario === 'unregistered-header' ? runtimePath : original.path!,
        title: 'Forked task',
        blank: false,
        status: 'idle',
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        ...(scenario === 'unregistered-header'
          ? {}
          : {
              projection: { asOfSequence: 42, values: { workingDirectory: runtimePath } },
            }),
        history: [],
        configuration: {
          preset: '',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: '', modelId: '' },
        },
      }
      let currentDetail = raw
      const registry = { items: [original, target], archivedSessionIds: new Set<string>() }
      const get = vi.fn(() => Promise.resolve(currentDetail))
      const backend = {
        workspaces: { listWithArchiveState: () => Promise.resolve(registry) },
        sessions: { get, open: get },
        subagents: {},
      } as unknown as DshBackend
      const folders: readonly vscode.WorkspaceFolder[] = [
        { name: 'project', index: 0, uri: { fsPath: hostPath } as vscode.Uri },
      ]
      const scope = createSessionScope({
        backendService: { requireBackend: () => backend } as BackendService,
        workspaceUseCases: { list: () => Promise.resolve(registry.items) } as unknown as WorkspaceUseCases,
        temporaryWorkspaceManager: {} as TemporaryWorkspaceManager,
        currentWorkspaceFolders: () => folders,
        currentWorkspaceFolder: () => folders[0],
      })
      const deps: DirectoryDependencies = {
        ...scope,
        currentWorkspaceFolders: () => folders,
        sessionUseCases: { list: () => Promise.resolve({ items: [raw] }) },
      }
      const signal = new AbortController().signal
      const list = (): Promise<readonly SessionSummary[]> =>
        listScopedSessions(deps, { archived: false }, signal).then((page) => page.items)
      const before = await list()
      const opened = await scope.requireCurrentWorkspaceSession(raw.id, signal, { fresh: true })
      const reopenedDrawer = await list()
      expect(before[0]?.workspaceId).toBe(target.id)
      expect(reopenedDrawer[0]?.workspaceId).toBe(target.id)
      // 0.1.99 returned original-registry (or '') here, so the real drawer's
      // workspace-id/membership filter removed the clicked row until a refresh.
      expect(opened.workspaceId).toBe(before[0]?.workspaceId)
      expect((await scope.requireCurrentWorkspaceSession(raw.id, signal)).workspaceId).toBe(target.id)
      expect(raw.workspaceId).toBe(scenario === 'unregistered-header' ? '' : original.id)
      expect(raw.cwd).toBe(scenario === 'unregistered-header' ? runtimePath : original.path)
      expect(original.sessionIds).toEqual(['fork'])
      expect(target.sessionIds).toEqual([])
      // Display normalization must not grant access after a move out of scope.
      currentDetail = { ...raw, projection: { asOfSequence: 43, values: { workingDirectory: '/outside' } } }
      await expect(
        scope.requireCurrentWorkspaceSession(raw.id, signal, { fresh: true }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    },
  )
})
