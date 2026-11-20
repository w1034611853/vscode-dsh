import {
  effectiveSessionDirectory,
  type SessionListQuery,
  type SessionPage,
  type SessionSummary,
} from '@dsh-vscode/domain'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import type { CurrentWorkspaceDirectory } from './session-scope.js'
import { sameWorkspacePath } from './workspace-state.js'
import { sessionBelongsToWorkspaces } from './workspace-guards.js'

export type DirectoryDependencies = Pick<
  RequestGatewayDependencies,
  | 'currentWorkspaceFolders'
  | 'listCurrentWorkspaces'
  | 'listCurrentArchivedSessionIds'
  | 'readCurrentWorkspaceDirectory'
> & { readonly sessionUseCases: Pick<RequestGatewayDependencies['sessionUseCases'], 'list'> }

/** Both session lists use the same DSH summaries and workspace/archive boundary. */
export async function listScopedSessions(
  deps: DirectoryDependencies,
  query: SessionListQuery,
  signal: AbortSignal,
  current?: Pick<CurrentWorkspaceDirectory, 'workspaces'> &
    Partial<Pick<CurrentWorkspaceDirectory, 'registry'>>,
): Promise<SessionPage> {
  signal.throwIfAborted()
  const folders = deps.currentWorkspaceFolders()
  const directory = current ?? (await deps.readCurrentWorkspaceDirectory?.(signal))
  const workspaces = directory?.workspaces ?? (await deps.listCurrentWorkspaces(signal))
  signal.throwIfAborted()
  if (workspaces.length === 0 && folders.length === 0) return { items: [] }
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  const workspaceId = query.workspaceId
  const archived = query.archived ?? false
  if (workspaceId !== undefined && !workspaceIds.has(workspaceId)) return { items: [] }
  const inCurrentWorkspace = (session: SessionSummary): boolean => {
    const selected =
      workspaceId === undefined ? workspaces : workspaces.filter((item) => item.id === workspaceId)
    if (!Object.hasOwn(session.projection?.values ?? {}, 'workingDirectory'))
      return (
        selected.some((item) => item.id === session.workspaceId || item.sessionIds?.includes(session.id)) ||
        (session.cwd !== undefined &&
          folders.some((folder) => sameWorkspacePath(folder.uri.fsPath, session.cwd!)))
      )
    const selectedFolders =
      workspaceId === undefined
        ? folders
        : folders.filter((folder) =>
            selected.some(
              (item) => item.path !== undefined && sameWorkspacePath(item.path, folder.uri.fsPath),
            ),
          )
    return sessionBelongsToWorkspaces(session, selected, selectedFolders)
  }
  // Filtering by the immutable DSH registry id would remove a moved session
  // before its authoritative execution directory can be matched here.
  const { workspaceId: _workspaceId, ...backendQuery } = query
  void _workspaceId
  const forDisplay = (session: SessionSummary): SessionSummary => {
    const cwd = effectiveSessionDirectory(session)
    const currentWorkspace =
      cwd === undefined
        ? undefined
        : workspaces.find((item) => item.path !== undefined && sameWorkspacePath(item.path, cwd))
    return currentWorkspace === undefined ? session : { ...session, workspaceId: currentWorkspace.id }
  }
  if (directory?.registry !== undefined) {
    const { registry } = directory
    const includeSession = (session: SessionSummary): boolean =>
      inCurrentWorkspace(session) && registry.archivedSessionIds.has(session.id) === archived
    const page = await deps.sessionUseCases.list({ ...backendQuery, archived }, signal, {
      workspaceSnapshot: registry,
      includeSession,
    })
    signal.throwIfAborted()
    return { ...page, items: page.items.filter(includeSession).map(forDisplay) }
  }
  const [archive, page] = await Promise.all([
    deps.listCurrentArchivedSessionIds(workspaces, signal),
    deps.sessionUseCases.list({ ...backendQuery, archived }, signal),
  ])
  signal.throwIfAborted()
  const archivedIds = new Set(archive)
  return {
    ...page,
    items: page.items
      .filter((session) => inCurrentWorkspace(session) && archivedIds.has(session.id) === archived)
      .map(forDisplay),
  }
}
