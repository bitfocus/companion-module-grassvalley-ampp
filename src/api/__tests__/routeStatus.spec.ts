import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmppHttpError } from '../AmppClient.js'
import { classifyClearStatus, classifyRouteStatus, describeRouteRequestError, pollRouteStatus } from '../routeStatus.js'
import type { RouteStatus, RouteStatusValue } from '../types.js'

const status = (routeStatus: RouteStatusValue, routeErrorMessage: string | null = null): RouteStatus => ({
	routeStatus,
	routeErrorMessage,
})

describe('classifyRouteStatus', () => {
	it.each<[RouteStatusValue, string]>([
		['Pending', 'pending'],
		['Routed', 'success'],
		['Errored', 'failed'],
		['TimedOut', 'failed'],
		['Removing', 'pending'],
		['Removed', 'failed'],
		['Clearing', 'pending'],
		['Cleared', 'failed'],
	])('treats %s as %s', (value, outcome) => {
		expect(classifyRouteStatus(status(value))).toBe(outcome)
	})

	it('treats unknown values as pending', () => {
		expect(classifyRouteStatus(status('SomethingNew' as RouteStatusValue))).toBe('pending')
	})

	it('treats any error message as failed', () => {
		expect(classifyRouteStatus(status('Routed', 'destination locked'))).toBe('failed')
	})
})

describe('classifyClearStatus', () => {
	it.each<[RouteStatusValue, string]>([
		['Pending', 'pending'],
		['Clearing', 'pending'],
		['Cleared', 'success'],
		['Removed', 'success'],
		['Routed', 'failed'],
		['Errored', 'failed'],
		['TimedOut', 'failed'],
	])('treats %s as %s', (value, outcome) => {
		expect(classifyClearStatus(status(value))).toBe(outcome)
	})

	it('treats any error message as failed', () => {
		expect(classifyClearStatus(status('Cleared', 'nope'))).toBe('failed')
	})
})

describe('pollRouteStatus', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const options = (overrides: Partial<Parameters<typeof pollRouteStatus>[1]> = {}) => ({
		initialStatus: null,
		intervalMs: 500,
		timeoutMs: 2000,
		signal: new AbortController().signal,
		classify: classifyRouteStatus,
		onStatusChange: () => {},
		...overrides,
	})

	it('polls until the route completes, reporting each status change once', async () => {
		const getStatus = vi
			.fn<() => Promise<RouteStatus>>()
			.mockResolvedValueOnce(status('Pending'))
			.mockResolvedValueOnce(status('Pending'))
			.mockResolvedValueOnce(status('Routed'))
		const onStatusChange = vi.fn<(status: RouteStatus) => void>()
		const opts = options({ onStatusChange })

		const promise = pollRouteStatus(getStatus, opts)
		await vi.runAllTimersAsync()

		await expect(promise).resolves.toEqual({ outcome: 'success', status: status('Routed') })
		expect(getStatus).toHaveBeenCalledTimes(3)
		expect(onStatusChange.mock.calls.map(([s]) => s.routeStatus)).toEqual(['Pending', 'Routed'])
	})

	it('returns a completed initial status without polling', async () => {
		const getStatus = vi.fn<() => Promise<RouteStatus>>()
		const onStatusChange = vi.fn<(status: RouteStatus) => void>()

		await expect(
			pollRouteStatus(getStatus, options({ initialStatus: status('Routed'), onStatusChange })),
		).resolves.toEqual({ outcome: 'success', status: status('Routed') })
		expect(getStatus).not.toHaveBeenCalled()
		expect(onStatusChange).toHaveBeenCalledTimes(1)
	})

	it('waits an interval after a pending initial status before polling', async () => {
		const getStatus = vi.fn<() => Promise<RouteStatus>>().mockResolvedValue(status('Routed'))
		const onStatusChange = vi.fn<(status: RouteStatus) => void>()

		const promise = pollRouteStatus(getStatus, options({ initialStatus: status('Pending'), onStatusChange }))
		expect(getStatus).not.toHaveBeenCalled()
		await vi.runAllTimersAsync()

		await expect(promise).resolves.toEqual({ outcome: 'success', status: status('Routed') })
		expect(getStatus).toHaveBeenCalledTimes(1)
		expect(onStatusChange.mock.calls.map(([s]) => s.routeStatus)).toEqual(['Pending', 'Routed'])
	})

	it('stops on failure', async () => {
		const getStatus = vi.fn<() => Promise<RouteStatus>>().mockResolvedValue(status('Errored', 'locked'))

		await expect(pollRouteStatus(getStatus, options())).resolves.toEqual({
			outcome: 'failed',
			status: status('Errored', 'locked'),
		})
		expect(getStatus).toHaveBeenCalledTimes(1)
	})

	it('gives up after the timeout with the last status', async () => {
		const getStatus = vi.fn<() => Promise<RouteStatus>>().mockResolvedValue(status('Pending'))

		const promise = pollRouteStatus(getStatus, options())
		await vi.runAllTimersAsync()

		await expect(promise).resolves.toEqual({ outcome: 'pending', status: status('Pending') })
		// Polls at 0, 500, 1000, 1500 and 2000ms; the next would land past the 2000ms deadline
		expect(getStatus).toHaveBeenCalledTimes(5)
	})

	it("stops waiting when aborted, rejecting with the signal's reason", async () => {
		const controller = new AbortController()
		const reason = new Error('The connection to AMPP ended')
		const getStatus = vi.fn<() => Promise<RouteStatus>>().mockResolvedValue(status('Pending'))

		const promise = pollRouteStatus(getStatus, options({ signal: controller.signal }))
		const rejected = expect(promise).rejects.toBe(reason)
		await vi.advanceTimersByTimeAsync(0)
		controller.abort(reason)

		await rejected
		expect(getStatus).toHaveBeenCalledTimes(1)
	})
})

describe('describeRouteRequestError', () => {
	it("passes on the server's reason for a refusal", () => {
		// As AMPP answers a route to a locked destination
		const locked = new AmppHttpError(400, 'The destination is locked', 'POST … failed (400): The destination is locked')
		expect(describeRouteRequestError(locked, 'MV 1')).toBe('Route to MV 1 was refused: The destination is locked')
		expect(
			describeRouteRequestError(
				new AmppHttpError(404, 'Source not found', 'POST … failed (404): Source not found'),
				'MV 1',
			),
		).toBe('Route to MV 1 was refused: Source not found')
	})

	it('keeps the raw message for a permission problem', () => {
		expect(describeRouteRequestError(new AmppHttpError(403, 'Nope', 'POST … failed (403): Nope'), 'MV 1')).toBe(
			'POST … failed (403): Nope',
		)
	})

	it('explains a conflict without a reason as a possibly locked destination', () => {
		expect(describeRouteRequestError(new AmppHttpError(409, null, 'POST … failed (409)'), 'MV 1')).toBe(
			'Route to MV 1 was refused (it may be locked)',
		)
	})

	it('explains rate limiting', () => {
		expect(describeRouteRequestError(new AmppHttpError(429, null, 'POST … failed (429)'), 'MV 1')).toBe(
			'AMPP is rate limiting requests, try again shortly',
		)
	})

	it('passes other errors through', () => {
		expect(describeRouteRequestError(new AmppHttpError(500, 'boom', 'POST /x failed (500): boom'), 'MV 1')).toBe(
			'POST /x failed (500): boom',
		)
		expect(describeRouteRequestError(new Error('offline'), 'MV 1')).toBe('offline')
		expect(describeRouteRequestError('odd', 'MV 1')).toBe('odd')
	})
})
