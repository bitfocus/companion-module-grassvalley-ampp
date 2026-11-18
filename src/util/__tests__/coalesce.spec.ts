import { describe, expect, it, vi } from 'vitest'
import { coalesce } from '../coalesce.js'

/** A task whose runs finish only when the test says so */
function controllableTask() {
	const finishers: Array<(e?: Error) => void> = []
	const task = vi.fn(
		async () => new Promise<void>((resolve, reject) => finishers.push((e) => (e ? reject(e) : resolve()))),
	)
	const finish = async (e?: Error) => {
		finishers.shift()?.(e)
		await new Promise((resolve) => setImmediate(resolve))
	}
	return { task, finish }
}

describe('coalesce', () => {
	it('runs straight away when idle', async () => {
		const { task, finish } = controllableTask()
		const run = coalesce(task)

		const done = run()
		expect(task).toHaveBeenCalledTimes(1)
		await finish()
		await expect(done).resolves.toBeUndefined()
	})

	it('folds calls made during a run into one more run afterwards', async () => {
		const { task, finish } = controllableTask()
		const run = coalesce(task)

		void run()
		const second = run()
		const third = run()
		expect(task).toHaveBeenCalledTimes(1)

		await finish()
		expect(task).toHaveBeenCalledTimes(2)
		await finish()
		await expect(Promise.all([second, third])).resolves.toEqual([undefined, undefined])
		expect(task).toHaveBeenCalledTimes(2)
	})

	it('runs again on the next call once idle', async () => {
		const { task, finish } = controllableTask()
		const run = coalesce(task)

		void run()
		await finish()
		void run()
		expect(task).toHaveBeenCalledTimes(2)
	})

	it('still makes the follow-up run when a run fails', async () => {
		const { task, finish } = controllableTask()
		const run = coalesce(task)

		const first = expect(run()).rejects.toThrow('boom')
		const second = run()
		await finish(new Error('boom'))
		await first

		expect(task).toHaveBeenCalledTimes(2)
		await finish()
		await expect(second).resolves.toBeUndefined()
	})
})
