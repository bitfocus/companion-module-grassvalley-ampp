import { parseClusterEvent, type PlatformNotification } from '../api/Notifications.js'
import type { RouterState } from './RouterState.js'

/** Apply node state, workload state and node metrics notifications to the state, which records what changed */
export function applyClusterEvents(state: RouterState, notifications: readonly PlatformNotification[]): void {
	for (const notification of notifications) {
		const event = parseClusterEvent(notification)
		if (!event) continue

		if (event.kind === 'node') state.upsertNode(event.node)
		else if (event.kind === 'workload') state.upsertWorkload(event.workload)
		else state.setNodeMetrics(event.nodeId, event.metrics)
	}
}
