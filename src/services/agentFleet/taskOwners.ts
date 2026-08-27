import { readFile } from 'node:fs/promises'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { injectUserMessageToTeammate } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { queuePendingMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { stopTask } from '../../tasks/stopTask.js'
import type { ToolUseContext } from '../../Tool.js'
import { resumeAgentBackground } from '../../tools/AgentTool/resumeAgent.js'
import type { AgentFleetActionOwners } from './actions.js'
import type { AgentFleetRecord } from './types.js'

function taskId(record: AgentFleetRecord): string {
  if (!record.taskId) throw new Error(`Agent ${record.id} has no task owner`)
  return record.taskId
}

export function createAgentFleetTaskOwners(
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): Pick<
  AgentFleetActionOwners,
  'message' | 'resume' | 'retry' | 'stopRecord' | 'logsRecord' | 'cleanupRecord'
> {
  const setAppState = context.setAppStateForTasks ?? context.setAppState

  async function resume(
    record: AgentFleetRecord,
    prompt: string,
  ): Promise<void> {
    await resumeAgentBackground({
      agentId: record.rawId ?? taskId(record),
      prompt,
      toolUseContext: context,
      canUseTool,
    })
  }

  return {
    async message(record, content) {
      const id = taskId(record)
      const task = context.getAppState().tasks[id]
      if (task?.type === 'local_agent') {
        queuePendingMessage(id, content, setAppState)
        return
      }
      if (
        task?.type === 'in_process_teammate' &&
        injectUserMessageToTeammate(id, content, undefined, setAppState)
      ) {
        return
      }
      throw new Error(`Agent ${record.id} is not accepting messages`)
    },
    resume,
    retry: resume,
    async stopRecord(record) {
      await stopTask(taskId(record), {
        getAppState: context.getAppState,
        setAppState,
      })
    },
    async logsRecord(record) {
      if (!record.logPath) return undefined
      return (await readFile(record.logPath, 'utf8')).slice(-64_000)
    },
    async cleanupRecord(record) {
      const id = taskId(record)
      setAppState(state => {
        if (!state.tasks[id]) return state
        const tasks = { ...state.tasks }
        delete tasks[id]
        return { ...state, tasks }
      })
    },
  }
}
