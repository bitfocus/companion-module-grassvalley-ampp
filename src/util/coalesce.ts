/**
 * Wraps a task so overlapping calls share runs: a call while it runs schedules one more run once it finishes (so
 * that run sees anything that changed meanwhile), and further calls until then join that same run.
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | null = null
	let next: Promise<void> | null = null

	// Sets `running` synchronously, before its first await
	const run = async (): Promise<void> => {
		running = task().finally(() => {
			running = null
		})
		return running
	}

	return async () => {
		if (!running) return run()
		const runNext = async () => {
			next = null
			return run()
		}
		// Runs after a failed run too; that failure was reported to its own callers
		next ??= running.then(runNext, runNext)
		return next
	}
}
