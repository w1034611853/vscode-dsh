import type * as vscode from 'vscode'
import { effectiveSessionDirectory, type SessionSummary, type WorkspaceSummary } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import { sameWorkspacePath } from './workspace-state.js'

export function sessionBelongsToWorkspaces(
  session: Pick<SessionSummary, 'id' | 'workspaceId' | 'cwd' | 'projection'>,
  workspaces: readonly WorkspaceSummary[],
  folders: readonly vscode.WorkspaceFolder[] = [],
): boolean {
  // An explicit execution-directory projection overrides registry membership.
  // Moving a session must not leave execution authority in its original window.
  if (session.projection !== undefined && Object.hasOwn(session.projection.values, 'workingDirectory')) {
    const cwd = effectiveSessionDirectory(session)
    return (
      cwd !== undefined &&
      (folders.some((folder) => sameWorkspacePath(cwd, folder.uri.fsPath)) ||
        workspaces.some(
          (workspace) => workspace.path !== undefined && sameWorkspacePath(cwd, workspace.path),
        ))
    )
  }
  return (
    workspaces.some(
      (workspace) =>
        session.workspaceId === workspace.id ||
        workspace.sessionIds?.includes(session.id) === true ||
        (workspace.path !== undefined &&
          session.cwd !== undefined &&
          sameWorkspacePath(workspace.path, session.cwd)),
    ) ||
    (session.cwd !== undefined &&
      folders.some((folder) => sameWorkspacePath(session.cwd as string, folder.uri.fsPath)))
  )
}
export function requiresTrustedWorkspace(type: WebviewRequest['type']): boolean {
  switch (type) {
    case 'workspace.rename':
    case 'workspace.remove':
    case 'workspace.move':
    case 'session.move':
    case 'session.create':
    case 'session.rename':
    case 'session.remove':
    case 'session.fork':
    case 'session.archive':
    case 'session.open':
    case 'session.transcript.ack':
    case 'session.transcript.resync':
    case 'session.transcript.navigate':
    case 'session.transcript.openContent':
    case 'session.sendPrompt':
    case 'session.queue.list':
    case 'session.queue.update':
    case 'session.queue.steer':
    case 'session.configure':
    case 'session.setAgentTeamMode':
    case 'attachment.pick':
    case 'attachment.ingest':
    case 'attachment.preview':
    case 'attachment.open.list':
    case 'attachment.open.attach':
    case 'attachment.read':
    case 'reference.list':
    case 'feedback.list':
    case 'feedback.toggle':
    case 'feedback.note':
    case 'feedback.remove':
    case 'models.discover.custom':
    case 'provider.secret.configure':
    case 'provider.secret.remove':
    case 'provider.custom.create':
    case 'plugin.credential.configure':
    case 'plugin.credential.remove':
    case 'interaction.permission.respond':
    case 'interaction.question.respond':
    case 'settings.update':
    case 'settings.unset':
    case 'settings.mutate':
    case 'settings.openDocument':
    case 'settings.openKeyboardShortcuts':
    case 'goal.list':
    case 'goal.update':
    case 'goal.clear':
    case 'subagent.send':
    case 'subagent.list':
    case 'subagent.history':
    case 'skill.list':
    case 'skill.openDocument':
    case 'command.list':
    case 'command.execute':
    case 'job.list':
    case 'job.follow.start':
    case 'preset.read':
    case 'preset.copy':
    case 'preset.openDocument':
    case 'preset.remove':
    case 'session.export':
    case 'surface.openInEditor':
      return true
    default:
      return false
  }
}
