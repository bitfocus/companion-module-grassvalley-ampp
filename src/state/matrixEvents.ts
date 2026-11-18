import { parseMatrixEvent, type PlatformNotification } from '../api/Notifications.js'
import type { RouterState } from './RouterState.js'

const KNOWN_ACTIONS = new Set(['created', 'updated', 'deleted'])

/**
 * Apply `gv.cluster.matrix.<consumer|producer>.<created|updated|deleted>` notifications to the state, which records
 * what changed. Each carries the whole endpoint, so the lists only need reloading for one that doesn't, an unknown
 * action, or a fabric not loaded yet. Returns whether they do.
 */
export function applyMatrixEvents(state: RouterState, notifications: readonly PlatformNotification[]): boolean {
	let reload = false

	for (const notification of notifications) {
		const event = parseMatrixEvent(notification)
		if (!event) continue

		if (!KNOWN_ACTIONS.has(event.action) || !event.endpoint) {
			reload = true
			continue
		}
		const { id } = event.endpoint
		if (event.action === 'deleted') {
			if (event.kind === 'consumer') state.removeConsumer(id)
			else state.removeProducer(id)
			continue
		}

		// Without a fabric id in the notification, an endpoint we already know stays where it is
		const fabricId = event.fabricId ? state.findFabricId(event.fabricId) : state.endpointFabricId(id)
		if (!fabricId) reload = true
		else if (event.kind === 'producer') state.upsertProducer(fabricId, event.endpoint)
		else state.upsertConsumer(fabricId, event.endpoint)
	}

	return reload
}
