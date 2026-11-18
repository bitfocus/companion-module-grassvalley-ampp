export interface OncePerTurn {
	/** Run the task at the end of this turn of the event loop, if it isn't already due to */
	schedule(): void
	/** Drop a scheduled run */
	cancel(): void
}

/**
 * Wraps a task so any number of calls in one turn of the event loop run it once, after everything else that turn
 * (such as the rest of a burst of messages that arrived together) has run. Unlike a timer, it adds no delay.
 */
export function oncePerTurn(task: () => void): OncePerTurn {
	let scheduled: NodeJS.Immediate | null = null
	return {
		schedule: () => {
			scheduled ??= setImmediate(() => {
				scheduled = null
				task()
			})
		},
		cancel: () => {
			if (scheduled) clearImmediate(scheduled)
			scheduled = null
		},
	}
}
