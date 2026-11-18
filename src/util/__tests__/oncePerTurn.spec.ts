import { describe, expect, it, vi } from 'vitest'
import { oncePerTurn } from '../oncePerTurn.js'

const nextTurn = async () => new Promise((resolve) => setImmediate(resolve))

describe('oncePerTurn', () => {
	it('runs once for every call made in the same turn, after the turn', async () => {
		const task = vi.fn()
		const publish = oncePerTurn(task)

		publish.schedule()
		publish.schedule()
		publish.schedule()
		expect(task).not.toHaveBeenCalled()

		await nextTurn()
		expect(task).toHaveBeenCalledOnce()
	})

	it('runs again for a call in a later turn', async () => {
		const task = vi.fn()
		const publish = oncePerTurn(task)

		publish.schedule()
		await nextTurn()
		publish.schedule()
		await nextTurn()

		expect(task).toHaveBeenCalledTimes(2)
	})

	it('drops a cancelled run', async () => {
		const task = vi.fn()
		const publish = oncePerTurn(task)

		publish.schedule()
		publish.cancel()
		await nextTurn()

		expect(task).not.toHaveBeenCalled()
	})
})
