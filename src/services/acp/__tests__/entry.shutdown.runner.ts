import { mock } from 'bun:test'
import { AbortError } from '../../../utils/errors.js'

const scenario = process.argv[2]
let resolveClosed!: () => void
const closed = new Promise<void>(resolve => {
  resolveClosed = resolve
})

let closeCalls = 0
const sessions = new Map([['session-1', {}]])

mock.module('@agentclientprotocol/sdk', () => ({
  AgentSideConnection: class {
    closed = closed

    constructor(factory: (connection: unknown) => unknown) {
      factory({})
    }
  },
  ndJsonStream: () => ({}),
}))

mock.module('src/services/acp/agent.js', () => ({
  AcpAgent: class {
    sessions = sessions

    async unstable_closeSession(): Promise<void> {
      closeCalls++
      console.error('close:start')
      await Bun.sleep(40)
      console.error('close:end')
    }
  },
}))

mock.module('src/utils/config.js', () => ({
  enableConfigs: () => {},
}))

mock.module('src/utils/managedEnv.js', () => ({
  applySafeConfigEnvironmentVariables: () => {},
}))

const originalExit = process.exit
process.exit = ((code?: number) => {
  console.error(`exit:${code}:closeCalls:${closeCalls}`)
  return originalExit(code)
}) as typeof process.exit

const { runAcpAgent } = await import('../entry.js')
await runAcpAgent()

const promise = Promise.resolve()
if (scenario === 'fatal') {
  process.emit('unhandledRejection', new Error('fatal'), promise)
} else if (scenario === 'race') {
  resolveClosed()
  setTimeout(() => {
    process.emit('unhandledRejection', new Error('fatal'), promise)
  }, 5)
} else if (scenario === 'abort') {
  process.emit('unhandledRejection', new AbortError('cancelled'), promise)
  setTimeout(() => originalExit(0), 50)
} else {
  throw new Error(`Unknown scenario: ${scenario}`)
}
