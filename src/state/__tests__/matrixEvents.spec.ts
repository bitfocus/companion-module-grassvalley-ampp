import { describe, expect, it } from 'vitest'
import type { PlatformNotification } from '../../api/Notifications.js'
import { applyMatrixEvents } from '../matrixEvents.js'
import { RouterState } from '../RouterState.js'
import { consumer, producer } from '../../api/__tests__/fixtures.js'

const FABRIC = 'acd4525c-b7d6-40ce-ae10-46762053d90e'

function makeState(): RouterState {
	const state = new RouterState()
	state.setEndpoints([
		{
			fabric: { id: FABRIC, name: 'aws-project-gvampp-mesh' },
			producers: [
				producer({ id: 'p1', name: 'clock', alias: null }),
				producer({ id: 'p2', name: 'signal-gen-01', alias: null }),
			],
			consumers: [consumer({ id: 'c1', name: 'mult-01 - Input 1', tallyState: 'Off', routedProducerId: 'p1' })],
		},
	])
	state.takeChanges()
	return state
}

/** Applies the events, returning whether they asked for a reload and what they changed */
function apply(state: RouterState, notifications: PlatformNotification[]) {
	const reload = applyMatrixEvents(state, notifications)
	const { destinations, sources, lists } = state.takeChanges()
	return { destinations, sources, lists, reload }
}

/** Shaped like the real notifications, trimmed to the fields the module reads */
function consumerEvent(action: string, fields: Record<string, unknown>, fabricId = FABRIC): PlatformNotification {
	return {
		topic: `gv.cluster.matrix.consumer.${action}`,
		content: JSON.stringify({
			consumer: {
				id: 'c1',
				name: 'mult-01 - Input 1',
				alias: null,
				fabricId,
				tallyState: 'Off',
				locked: false,
				enabled: true,
				routedProducerId: 'p1',
				...fields,
			},
			action,
		}),
	}
}

function producerEvent(action: string, fields: Record<string, unknown>): PlatformNotification {
	return {
		topic: `gv.cluster.matrix.producer.${action}`,
		content: JSON.stringify({ producer: { fabricId: FABRIC, alias: null, ...fields }, action }),
	}
}

describe('applyMatrixEvents', () => {
	it('applies a destination update in place', () => {
		const state = makeState()

		const result = apply(state, [consumerEvent('updated', { routedProducerId: 'p2', locked: true })])

		expect(result).toEqual({ destinations: [state.destinations[0]], sources: [], lists: false, reload: false })
		expect(state.destinations[0]).toMatchObject({ routedProducerId: 'p2', locked: true })
	})

	it('ignores an update that changes nothing', () => {
		expect(apply(makeState(), [consumerEvent('updated', {})])).toEqual({
			destinations: [],
			sources: [],
			lists: false,
			reload: false,
		})
	})

	it('adds created destinations and sources without reloading', () => {
		const state = makeState()
		// As a new multiviewer announces its output and inputs
		const result = apply(state, [
			producerEvent('created', { id: 'p3', name: 'mult-test' }),
			consumerEvent('created', { id: 'c2', name: 'mult-test - Input 1', routedProducerId: null }),
			consumerEvent('created', { id: 'c3', name: 'mult-test - Input 2', routedProducerId: null }),
		])

		expect(result).toEqual({ destinations: [], sources: [], lists: true, reload: false })
		expect(state.findSource('mult-test')?.id).toBe('p3')
		expect(state.destinations.map((d) => d.id)).toEqual(['c1', 'c2', 'c3'])
	})

	it('treats an update to an unknown destination as an addition', () => {
		const state = makeState()

		expect(apply(state, [consumerEvent('updated', { id: 'c9', name: 'Late' })])).toMatchObject({
			lists: true,
			reload: false,
		})
		expect(state.findDestination('c9')).toBeDefined()
	})

	it('removes deleted destinations and sources', () => {
		const state = makeState()

		const result = apply(state, [
			producerEvent('deleted', { id: 'p2', name: 'signal-gen-01' }),
			consumerEvent('deleted', {}),
		])

		expect(result).toEqual({ destinations: [], sources: [], lists: true, reload: false })
		expect(state.sources.map((s) => s.id)).toEqual(['p1'])
		expect(state.destinations).toEqual([])
	})

	it('drops a destination that was updated then deleted in the same batch', () => {
		const state = makeState()

		const result = apply(state, [consumerEvent('updated', { locked: true }), consumerEvent('deleted', {})])

		expect(result.destinations).toEqual([])
		expect(result.lists).toBe(true)
	})

	it('ignores deleting something not in the list', () => {
		expect(apply(makeState(), [consumerEvent('deleted', { id: 'gone' })]).lists).toBe(false)
	})

	it('relabels a renamed source', () => {
		const state = makeState()

		expect(apply(state, [producerEvent('updated', { id: 'p2', name: 'signal-gen-01', alias: 'Bars' })])).toMatchObject({
			lists: true,
		})
		expect(state.findSource('p2')?.label).toBe('Bars')
	})

	it('matches the fabric id without case', () => {
		const state = makeState()

		apply(state, [consumerEvent('updated', { locked: true }, FABRIC.toUpperCase())])
		expect(state.destinations[0].locked).toBe(true)
	})

	it('places each event on its own fabric', () => {
		const state = new RouterState()
		state.setEndpoints([
			{ fabric: { id: FABRIC, name: 'Mesh' }, producers: [], consumers: [] },
			{ fabric: { id: 'f2', name: 'Remote' }, producers: [], consumers: [] },
		])

		apply(state, [
			consumerEvent('created', { id: 'c1', name: 'MV 1' }),
			consumerEvent('created', { id: 'c2', name: 'MV 1' }, 'f2'),
		])

		expect(state.destinations.map((d) => [d.id, d.fabricId, d.label])).toEqual([
			['c1', FABRIC, 'Mesh / MV 1'],
			['c2', 'f2', 'Remote / MV 1'],
		])
	})

	it('reloads for a fabric not loaded yet, rather than guessing', () => {
		const state = makeState()

		expect(apply(state, [consumerEvent('created', { id: 'c9' }, 'new-fabric')])).toMatchObject({
			reload: true,
			lists: false,
		})
		expect(state.findDestination('c9')).toBeUndefined()
	})

	it('keeps a known endpoint on its fabric when the notification names none', () => {
		const state = makeState()
		const noFabric = (fields: Record<string, unknown>): PlatformNotification => ({
			topic: 'gv.cluster.matrix.consumer.updated',
			content: JSON.stringify({ consumer: { id: 'c1', name: 'mult-01 - Input 1', routedProducerId: 'p1', ...fields } }),
		})

		expect(apply(state, [noFabric({ locked: true })]).destinations).toHaveLength(1)
		expect(state.destinations[0]).toMatchObject({ locked: true, fabricId: FABRIC })

		expect(apply(state, [noFabric({ id: 'c9' })]).reload).toBe(true)
	})

	it('asks for a reload for an unknown action or an event without its endpoint', () => {
		const state = makeState()

		expect(apply(state, [consumerEvent('archived', {})]).reload).toBe(true)
		expect(apply(state, [{ topic: 'gv.cluster.matrix.consumer.created', content: '{}' }]).reload).toBe(true)
	})

	it('ignores notifications that are not matrix endpoint events', () => {
		expect(apply(makeState(), [{ topic: 'gv.cluster.workload.created', content: '{}' }])).toEqual({
			destinations: [],
			sources: [],
			lists: false,
			reload: false,
		})
	})
})
