import { AmppHttpError } from './AmppClient.js'
import type { RouteStatus, RouteStatusValue } from './types.js'
import { errorMessage } from '../util/errorMessage.js'

export type RouteOutcome = 'success' | 'failed' | 'pending'

const OUTCOMES: Record<RouteStatusValue, RouteOutcome> = {
	Pending: 'pending',
	Routed: 'success',
	Errored: 'failed',
	TimedOut: 'failed',
	// Removing/Removed and Clearing/Cleared describe a route being taken down, not made
	Removing: 'pending',
	Removed: 'failed',
	Clearing: 'pending',
	Cleared: 'failed',
}

// A clear request goes Clearing → Cleared
const CLEAR_OUTCOMES: Record<RouteStatusValue, RouteOutcome> = {
	...OUTCOMES,
	Routed: 'failed',
	Removed: 'success',
	Cleared: 'success',
}

function classifyWith(outcomes: Record<RouteStatusValue, RouteOutcome>) {
	return (status: RouteStatus): RouteOutcome => {
		if (status.routeErrorMessage) return 'failed'
		// Fall back to pending for a value added to the API after this was written
		return outcomes[status.routeStatus] ?? 'pending'
	}
}

export const classifyRouteStatus = classifyWith(OUTCOMES)
export const classifyClearStatus = classifyWith(CLEAR_OUTCOMES)

/** A user-facing message for a route request the API refused */
export function describeRouteRequestError(e: unknown, destinationLabel: string): string {
	if (e instanceof AmppHttpError) {
		const detail = e.detail ? `: ${e.detail}` : ''
		if (e.status === 429) return `AMPP is rate limiting requests, try again shortly${detail}`
		// The server explains a refusal itself, e.g. a locked destination is a 400 "The destination is locked"
		const isAuth = e.status === 401 || e.status === 403
		if (e.detail && e.status >= 400 && e.status < 500 && !isAuth) {
			return `Route to ${destinationLabel} was refused: ${e.detail}`
		}
		// The swagger documents a 409 for requestroute without saying more
		if (e.status === 409) return `Route to ${destinationLabel} was refused (it may be locked)`
	}
	return errorMessage(e)
}

export interface RouteStatusResult {
	outcome: RouteOutcome
	status: RouteStatus | null
}

export interface PollRouteStatusOptions {
	/** The status the request was accepted with; a completed one is returned without polling */
	initialStatus: RouteStatus | null
	intervalMs: number
	timeoutMs: number
	/** Stops the polling, rejecting with its reason */
	signal: AbortSignal
	/** classifyRouteStatus for a route request, classifyClearStatus for a clear */
	classify: (status: RouteStatus) => RouteOutcome
	/** Called whenever the raw status string changes */
	onStatusChange: (status: RouteStatus) => void
}

/**
 * Poll a route request until it succeeds, fails, or the timeout passes.
 * A timeout resolves with outcome 'pending' and the last status seen.
 */
export async function pollRouteStatus(
	getStatus: () => Promise<RouteStatus>,
	options: PollRouteStatusOptions,
): Promise<RouteStatusResult> {
	const deadline = Date.now() + options.timeoutMs
	let last: RouteStatus | null = null

	const { signal } = options
	const aborted = (): Error => (signal.reason instanceof Error ? signal.reason : new Error('Route polling aborted'))
	const wait = async () =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(aborted())
				return
			}
			const done = () => {
				clearTimeout(timer)
				reject(aborted())
			}
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', done)
				resolve()
			}, options.intervalMs)
			signal.addEventListener('abort', done, { once: true })
		})
	const see = (status: RouteStatus): RouteOutcome => {
		if (status.routeStatus !== last?.routeStatus || status.routeErrorMessage !== last?.routeErrorMessage) {
			options.onStatusChange(status)
		}
		last = status
		return options.classify(status)
	}

	if (options.initialStatus) {
		const outcome = see(options.initialStatus)
		if (outcome !== 'pending') return { outcome, status: options.initialStatus }
		await wait()
	}

	for (;;) {
		signal.throwIfAborted()
		const status = await getStatus()
		const outcome = see(status)
		if (outcome !== 'pending') return { outcome, status }
		if (Date.now() + options.intervalMs > deadline) break

		await wait()
	}

	return { outcome: 'pending', status: last }
}
