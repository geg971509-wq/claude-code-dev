import { describe, expect, test } from 'bun:test'
import { paginateSessionResources } from '../sessionResourcePagination.js'

describe('paginateSessionResources', () => {
  test('walks after_id pages and deduplicates compatible session IDs', async () => {
    const urls: string[] = []
    const result = await paginateSessionResources({
      url: 'https://api.example.test/v1/sessions',
      headers: { Authorization: 'Bearer token' },
      request: async (url, config) => {
        urls.push(url)
        expect(config.timeout).toBe(15_000)
        expect(config.headers.Authorization).toBe('Bearer token')
        if (urls.length === 1) {
          return {
            status: 200,
            data: {
              data: [{ id: 'session_one' }, { id: 'session_two' }],
              has_more: true,
              last_id: 'session_two',
            },
          }
        }
        return {
          status: 200,
          data: {
            data: [{ id: 'cse_two' }, { id: 'session_three' }],
            has_more: false,
            last_id: 'session_three',
          },
        }
      },
    })

    expect(urls).toEqual([
      'https://api.example.test/v1/sessions',
      'https://api.example.test/v1/sessions?after_id=session_two',
    ])
    expect(result.rows.map(row => row.id)).toEqual([
      'session_one',
      'session_two',
      'session_three',
    ])
    expect(result.truncated).toBe(false)
  })

  test('stops at the page budget and reports truncation', async () => {
    let calls = 0
    const result = await paginateSessionResources({
      url: 'https://api.example.test/v1/sessions',
      maxPages: 2,
      request: async () => {
        calls++
        return {
          status: 200,
          data: {
            data: [{ id: `session_${calls}` }],
            has_more: true,
            last_id: `session_${calls}`,
          },
        }
      },
    })

    expect(calls).toBe(2)
    expect(result.truncated).toBe(true)
  })

  test('rejects non-success and malformed page responses', async () => {
    await expect(
      paginateSessionResources({
        url: 'https://api.example.test/v1/sessions',
        request: async () => ({ status: 403, data: {} }),
      }),
    ).rejects.toThrow('HTTP 403')

    await expect(
      paginateSessionResources({
        url: 'https://api.example.test/v1/sessions',
        request: async () => ({ status: 200, data: { data: {} } }),
      }),
    ).rejects.toThrow('data is not an array')
  })
})
