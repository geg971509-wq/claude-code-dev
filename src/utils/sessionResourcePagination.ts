type SessionResourceRow = { id: string }

type SessionPageRequest = (
  url: string,
  config: {
    headers: Record<string, string>
    timeout: number
    validateStatus: (status: number) => boolean
  },
) => Promise<{ status: number; statusText?: string; data: unknown }>

type PaginationOptions = {
  url: string
  headers?: Record<string, string>
  request: SessionPageRequest
  maxPages?: number
}

const DEFAULT_PAGE_BUDGET = 5

function sessionIdBody(id: string): string {
  return id.replace(/^(?:session_|cse_)/, '')
}

function cursorUrl(url: string, afterId: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}after_id=${encodeURIComponent(afterId)}`
}

export async function paginateSessionResources<
  T extends SessionResourceRow = SessionResourceRow,
>(options: PaginationOptions): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  const seenSessions = new Set<string>()
  const seenCursors = new Set<string>()
  const pageBudget = Math.max(1, options.maxPages ?? DEFAULT_PAGE_BUDGET)
  let afterId: string | undefined
  let truncated = false

  for (let page = 0; page < pageBudget; page++) {
    const response = await options.request(
      afterId ? cursorUrl(options.url, afterId) : options.url,
      {
        headers: options.headers ?? {},
        timeout: 15_000,
        validateStatus: status => status < 500,
      },
    )
    if (response.status !== 200) {
      throw new Error(
        `Failed to list sessions: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      )
    }
    if (
      response.data === null ||
      typeof response.data !== 'object' ||
      !Array.isArray((response.data as { data?: unknown }).data)
    ) {
      throw new Error('Failed to list sessions: response data is not an array')
    }

    const body = response.data as {
      data: unknown[]
      has_more?: unknown
      last_id?: unknown
    }
    for (const row of body.data) {
      if (
        row === null ||
        typeof row !== 'object' ||
        typeof (row as { id?: unknown }).id !== 'string'
      ) {
        continue
      }
      const typed = row as T
      const identity = sessionIdBody(typed.id)
      if (seenSessions.has(identity)) continue
      seenSessions.add(identity)
      rows.push(typed)
    }

    if (body.has_more !== true) break
    const next =
      typeof body.last_id === 'string' && body.last_id.length > 0
        ? body.last_id
        : undefined
    if (!next || seenCursors.has(next)) {
      truncated = true
      break
    }
    seenCursors.add(next)
    afterId = next
    if (page === pageBudget - 1) truncated = true
  }

  return { rows, truncated }
}
