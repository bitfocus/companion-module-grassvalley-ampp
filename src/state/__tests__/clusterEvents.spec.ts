import { describe, expect, it } from 'vitest'
import { consumer, node, producer, workload } from '../../api/__tests__/fixtures.js'
import type { PlatformNotification } from '../../api/Notifications.js'
import { applyClusterEvents } from '../clusterEvents.js'
import { RouterState, type StateChanges } from '../RouterState.js'

/** A node, a running app, and a source on it and on an app not loaded yet; with the load's changes taken */
function makeState(): RouterState {
	const state = new RouterState()
	state.setNodes([node({ id: 'n1', name: 'Node A', runningWorkloads: 2, totalWorkloads: 2 })])
	state.setWorkloads([workload({ id: 'w1', name: 'engine', state: 'Running' })])
	state.setEndpoints([
		{
			fabric: { id: 'f1', name: 'Studio' },
			producers: [
				producer({ id: 'p1', name: 'engine', workloadId: 'w1' }),
				producer({ id: 'p2', name: 'player', workloadId: 'w2' }),
			],
			consumers: [consumer({ id: 'c1', name: 'MV', workloadId: 'w1' })],
		},
	])
	state.takeChanges()
	return state
}

function apply(state: RouterState, notifications: PlatformNotification[]): StateChanges {
	applyClusterEvents(state, notifications)
	return state.takeChanges()
}

const NOTHING: StateChanges = {
	lists: false,
	all: false,
	destinations: [],
	sources: [],
	nodes: [],
	nodeMetrics: [],
}

function nodeEvent(id: string, name: string, online: boolean, running = 2): PlatformNotification {
	return {
		topic: `gv.cluster.nodestate.${id}.changed`,
		content: JSON.stringify({
			nodeState: { online, runningWorkloadCount: running, totalWorkloadCount: 2, nodeProperties: { nodeName: name } },
		}),
	}
}

function workloadEvent(id: string, workloadState: string): PlatformNotification {
	return {
		topic: `gv.cluster.workloadstate.${id}.changed`,
		content: JSON.stringify({ workloadState, workload: { id, name: 'engine' } }),
	}
}

describe('applyClusterEvents', () => {
	it('records nothing for a node heartbeat that changes nothing', () => {
		expect(apply(makeState(), [nodeEvent('n1', 'Node A', true)])).toEqual(NOTHING)
	})

	it("keeps a node's name when the notification doesn't carry it", () => {
		const state = makeState()
		const unnamed: PlatformNotification = {
			topic: 'gv.cluster.nodestate.n1.changed',
			content: JSON.stringify({ nodeState: { online: false, runningWorkloadCount: 2, totalWorkloadCount: 2 } }),
		}

		expect(apply(state, [unnamed]).lists).toBe(false)
		expect(state.findNode('n1')).toMatchObject({ name: 'Node A', online: false })
	})

	it('records a node going offline or changing workload counts', () => {
		const state = makeState()

		expect(apply(state, [nodeEvent('n1', 'Node A', false, 0)]).nodes).toEqual([state.nodes[0]])
		expect(state.nodes[0]).toMatchObject({ online: false, runningWorkloads: 0 })
	})

	it('records a new or renamed node as a list change', () => {
		expect(apply(makeState(), [nodeEvent('n2', 'Node B', true)]).lists).toBe(true)
		expect(apply(makeState(), [nodeEvent('n1', 'Node A2', true)]).lists).toBe(true)
	})

	it('records the endpoints whose app state changed, and a new app that relabels them as a list change', () => {
		const state = makeState()

		expect(apply(state, [workloadEvent('w1', 'Running')])).toEqual(NOTHING)
		expect(apply(state, [workloadEvent('w1', 'Stopping')])).toMatchObject({
			sources: [state.findSource('p1')],
			destinations: [state.findDestination('c1')],
		})
		expect(apply(state, [workloadEvent('w2', 'Running')]).lists).toBe(true)
		expect(state.findSource('p2')?.label).toBe('engine')
		expect(state.workloads.get('w1')?.state).toBe('Stopping')
	})

	it('records an app rename that relabels endpoints as a list change', () => {
		const state = makeState()
		const rename = {
			topic: 'gv.cluster.workload.w1.updated',
			content: JSON.stringify({ workload: { id: 'w1', name: 'engine', alias: 'Camera' } }),
		}

		expect(apply(state, [rename]).lists).toBe(true)
		expect(state.findSource('p1')?.label).toBe('Camera')
	})

	it("records a known node's changed metrics and ignores an unknown node's", () => {
		const state = makeState()
		const metrics = (id: string) => ({
			topic: `gv.cluster.node.${id}.performancemetrics`,
			content: JSON.stringify({ numa: [{ totalCPU: 12 }] }),
		})

		expect(apply(state, [metrics('n1'), metrics('unknown')]).nodeMetrics).toEqual([state.nodes[0]])
		expect(state.nodes[0].metrics?.cpu).toBe(12)
		expect(apply(state, [metrics('n1')]).nodeMetrics).toEqual([])
	})

	it('ignores matrix events', () => {
		expect(apply(makeState(), [{ topic: 'gv.cluster.matrix.consumer.updated', content: '{}' }])).toEqual(NOTHING)
	})
})
