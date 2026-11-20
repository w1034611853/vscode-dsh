import { describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import { effectiveSessionDirectory, type SessionSummary, type WorkspaceSummary } from '@dsh-vscode/domain'
import { sessionBelongsToWorkspaces } from './workspace-guards.js'
import { toRegisteredWorkspacePath } from './workspace-state.js'
import { sessionWorkspaceFolderId } from '../view/session-workspace-scope.js'
import { listScopedSessions, type DirectoryDependencies } from './session-directory.js'

const original: WorkspaceSummary = {
  id: 'main',
  name: 'main',
  path: '/repo/main',
  sessionIds: ['s1'],
  sessionCount: 1,
  createdAt: '',
  updatedAt: '',
}
const target: WorkspaceSummary = {
  ...original,
  id: 'feature',
  name: 'feature',
  path: '/repo/feature',
  sessionIds: [],
}
const session: SessionSummary = {
  id: 's1',
  workspaceId: 'main',
  cwd: '/repo/main',
  title: 'Existing history',
  blank: false,
  status: 'idle',
  createdAt: '',
  updatedAt: '',
  projection: { asOfSequence: 42, values: { workingDirectory: '/repo/feature' } },
}
const folders = [
  { name: 'feature', index: 0, uri: { fsPath: '/repo/feature' } },
] as unknown as readonly vscode.WorkspaceFolder[]

describe('continuing a moved session', () => {
  it('uses the committed directory and revokes original registry authority', () => {
    expect(effectiveSessionDirectory(session)).toBe('/repo/feature')
    expect(sessionBelongsToWorkspaces(session, [target], folders)).toBe(true)
    expect(sessionBelongsToWorkspaces(session, [original], [])).toBe(false)
    expect(
      sessionWorkspaceFolderId({
        folders: [{ id: 'folder', path: '/repo/feature' }],
        session,
        samePath: (a, b) => a === b,
      }),
    ).toBe('folder')
    const movedAgain = {
      ...session,
      projection: { asOfSequence: 43, values: { workingDirectory: '/repo/elsewhere' } },
    }
    expect(sessionBelongsToWorkspaces(movedAgain, [target], folders)).toBe(false)
    expect(
      sessionWorkspaceFolderId({
        folders: [{ id: 'folder', path: '/repo/feature' }],
        session: movedAgain,
        samePath: (a, b) => a === b,
      }),
    ).toBeUndefined()
  })

  it('does not fall back to the original project for unknown or malformed projected directories', () => {
    for (const value of [null, '', 1, {}]) {
      const invalid = { ...session, projection: { asOfSequence: 43, values: { workingDirectory: value } } }
      expect(effectiveSessionDirectory(invalid)).toBeUndefined()
      expect(sessionBelongsToWorkspaces(invalid, [original], [])).toBe(false)
    }
    expect(effectiveSessionDirectory({ cwd: '/legacy' })).toBe('/legacy')
  })

  it('lists a moved session in the current folder without mutating its registry identity', async () => {
    const deps: DirectoryDependencies = {
      currentWorkspaceFolders: () => folders,
      listCurrentWorkspaces: () => Promise.resolve([target]),
      listCurrentArchivedSessionIds: () => Promise.resolve([]),
      sessionUseCases: {
        list: (query) => {
          expect(query?.workspaceId).toBeUndefined()
          return Promise.resolve({
            items: [
              session,
              {
                ...session,
                id: 'foreign',
                projection: { asOfSequence: 1, values: { workingDirectory: '/outside' } },
              },
            ],
          })
        },
      },
    }
    const result = await listScopedSessions(deps, { workspaceId: 'feature' }, new AbortController().signal)
    expect(result.items).toEqual([{ ...session, workspaceId: 'feature' }])
    expect(session.workspaceId).toBe('main')
  })

  it('preserves the matching WSL namespace for Windows-hosted workspace registration', () => {
    const registry = ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\fixture\\main']
    expect(toRegisteredWorkspacePath('/home/fixture/feature', registry, 'Ubuntu-24.04')).toBe(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\fixture\\feature',
    )
    expect(toRegisteredWorkspacePath('/home/fixture/feature', registry, 'Debian')).toBe(
      '/home/fixture/feature',
    )
    expect(toRegisteredWorkspacePath('/home/fixture/feature', ['/home/fixture/main'], 'Ubuntu-24.04')).toBe(
      '/home/fixture/feature',
    )
  })
})
