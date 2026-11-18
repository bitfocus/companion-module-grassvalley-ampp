import { describe, expect, it, vi } from 'vitest'
import type { AmppClient } from '../AmppClient.js'
import { ControlApi } from '../ControlApi.js'

const SIGNAL = new AbortController().signal

type PostFn = (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>

function makeApi(post: PostFn) {
	return new ControlApi({ post } as unknown as AmppClient, SIGNAL)
}

describe('ControlApi', () => {
	it('restarts and stops an app with no body, returning the command id', async () => {
		const post = vi.fn<PostFn>().mockResolvedValue({ commandId: 'cmd1', childCommandIds: null })

		await expect(makeApi(post).command('restart', 'app 1')).resolves.toBe('cmd1')
		expect(post).toHaveBeenCalledWith('/cluster/control/api/v1/workload/app%201/restart', undefined, SIGNAL)

		await makeApi(post).command('stop', 'a1')
		expect(post).toHaveBeenLastCalledWith('/cluster/control/api/v1/workload/a1/stop', undefined, SIGNAL)
	})

	it('starts an app with no start properties', async () => {
		const post = vi.fn<PostFn>().mockResolvedValue({ commandId: 'cmd2' })

		await makeApi(post).command('start', 'a1')

		expect(post).toHaveBeenCalledWith('/cluster/control/api/v1/workload/a1/start', { properties: {} }, SIGNAL)
	})

	it('throws when AMPP returns no command id', async () => {
		await expect(makeApi(vi.fn<PostFn>().mockResolvedValue({})).command('stop', 'a1')).rejects.toThrow(
			'The stop command returned no command id',
		)
	})
})
