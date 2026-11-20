import * as vscode from 'vscode'
import { effectiveSessionDirectory } from '@dsh-vscode/domain'
import type { BackendService } from '@dsh-vscode/application'
import type { SessionNavigation } from '../composition/session-navigation.js'
import { hasLocalWorkspaceAuthority } from '../view/session-workspace-scope.js'
import { sameWorkspacePath, toCurrentHostWorkspacePath } from '../composition/workspace-state.js'
import { scanGitWorktrees } from './worktree-scanner.js'
import { matchSessionsToWorktrees } from './session-matcher.js'

/** Discovery never grants access: navigation revalidates the live session before opening. */
export async function browseWorktreeSessions(deps: {
  readonly backendService: BackendService
  readonly sessionNavigation: SessionNavigation
}): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    await vscode.window.showWarningMessage('Trust this workspace before opening Worktree sessions.')
    return
  }
  const folders = vscode.workspace.workspaceFolders ?? []
  const active = vscode.window.activeTextEditor?.document.uri
  const folder =
    (active === undefined ? undefined : vscode.workspace.getWorkspaceFolder(active)) ?? folders[0]
  if (folder === undefined) {
    await vscode.window.showInformationMessage('Open a Git Worktree folder first / 请先打开工作树目录。')
    return
  }
  const controller = new AbortController()
  try {
    const backend = deps.backendService.requireBackend()
    if (!hasLocalWorkspaceAuthority(backend.connection)) {
      await vscode.window.showWarningMessage(
        'Connect to a verified local DSH Desktop first / 请先连接本机 DSH。',
      )
      return
    }
    const repository = await scanGitWorktrees(folder.uri.fsPath, controller.signal)
    if (repository === undefined) {
      await vscode.window.showInformationMessage('The selected folder is not a Git Worktree.')
      return
    }
    const [page, archived] = await Promise.all([
      backend.sessions.list(undefined, controller.signal),
      backend.workspaces.listArchivedSessionIds(controller.signal),
    ])
    const matches = matchSessionsToWorktrees(
      repository,
      page.items.filter(
        (session) => !session.blank && session.origin !== 'subagent' && !archived.includes(session.id),
      ),
    )
    if (matches.length === 0) {
      await vscode.window.showInformationMessage(
        'No sessions found for this Git repository / 未找到此仓库的会话。',
      )
      return
    }
    const selected = await vscode.window.showQuickPick(
      matches.map((match) => ({
        match,
        label: match.session.title || match.session.id,
        description: `${match.relationship === 'current-worktree' ? '当前工作树 · 可继续' : '其他工作树'} · ${match.worktree.branch ?? 'detached HEAD'}`,
        detail: `执行目录: ${effectiveSessionDirectory(match.session) ?? ''}`,
      })),
      {
        title: 'DSH: Git Worktree Sessions',
        placeHolder: '选择原会话，在其实际执行目录继续',
        matchOnDescription: true,
      },
    )
    if (selected === undefined) return
    if (
      backend !== deps.backendService.requireBackend() ||
      !vscode.workspace.isTrusted ||
      !vscode.workspace.workspaceFolders?.some((entry) => entry.uri.toString() === folder.uri.toString())
    )
      throw new Error('Workspace or connection changed')
    const fresh = await backend.sessions.get(selected.match.session.id, controller.signal)
    const verified = await scanGitWorktrees(folder.uri.fsPath, controller.signal)
    if (verified?.repositoryId !== repository.repositoryId) throw new Error('Repository changed')
    const current = matchSessionsToWorktrees(verified, [fresh])[0]
    const cwd = effectiveSessionDirectory(fresh)
    if (
      current === undefined ||
      cwd === undefined ||
      (await backend.workspaces.listArchivedSessionIds(controller.signal)).includes(fresh.id)
    )
      throw new Error('Session directory or availability changed')
    if (current.relationship !== 'current-worktree' || !sameWorkspacePath(cwd, folder.uri.fsPath)) {
      await vscode.window.showInformationMessage(
        '此会话仍在其他目录执行。请先在 DSH 中切换执行目录，再在此继续。插件不会静默改变会话目录。',
      )
      return
    }
    await deps.sessionNavigation.open(fresh.id, false, controller.signal)
    vscode.window.setStatusBarMessage(`DSH · 当前工作树: ${toCurrentHostWorkspacePath(cwd)}`, 10000)
  } catch {
    await vscode.window.showErrorMessage(
      'Unable to open Worktree session. Refresh the DSH connection and try again / 工作树会话未打开，请刷新连接后重试。',
    )
  } finally {
    controller.abort()
  }
}
