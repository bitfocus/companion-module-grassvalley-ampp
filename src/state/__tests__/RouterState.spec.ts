import { describe, expect, it } from 'vitest'
import type { AmppConsumer } from '../../api/types.js'
import { displayName, RouterState } from '../RouterState.js'
import { consumer, node, producer, workload } from '../../api/__tests__/fixtures.js'

const FABRIC = { id: 'f1', name: 'Studio' }

function makeState(): RouterState {
	const state = new RouterState()
	state.setEndpoints([
		{
			fabric: FABRIC,
			producers: [
				producer({ id: 'p10', name: 'Camera 10', alias: null }),
				producer({ id: 'p2', name: 'Camera 2', alias: 'Wide' }),
				producer({ id: 'p1', name: 'Camera 1', alias: 'Camera 1' }),
			],
			consumers: [consumer({ id: 'c1', name: 'Monitor', alias: 'MV 1', routedProducerId: 'p2' })],
		},
	])
	return state
}

describe('RouterState', () => {
	it('sorts sources naturally by label', () => {
		expect(makeState().sourceChoices()).toEqual([
			{ id: 'p1', label: 'Camera 1' },
			{ id: 'p10', label: 'Camera 10' },
			{ id: 'p2', label: 'Wide' },
		])
	})

	it('finds endpoints by id, name or alias', () => {
		const state = makeState()
		expect(state.findSource('p2')?.id).toBe('p2')
		expect(state.findSource('Camera 2')?.id).toBe('p2')
		expect(state.findSource(' Wide ')?.id).toBe('p2')
		expect(state.findDestination('MV 1')?.id).toBe('c1')
	})

	it('prefers an id match over a name or alias match', () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [producer({ id: 'a', name: 'b', alias: null }), producer({ id: 'b', name: 'other', alias: null })],
				consumers: [],
			},
		])
		expect(state.findSource('b')?.id).toBe('b')
	})

	it('returns undefined for unknown or empty references', () => {
		const state = makeState()
		expect(state.findSource('nope')).toBeUndefined()
		expect(state.findSource('  ')).toBeUndefined()
	})

	it('finds a shared name as the first by label', () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [
					producer({ id: 'z', name: 'Camera', alias: 'Zoom' }),
					producer({ id: 'a', name: 'Camera', alias: 'Angle' }),
				],
				consumers: [],
			},
		])
		expect(state.findSource('Camera')?.id).toBe('a')
	})

	it('keeps finding endpoints as they are added, renamed and removed', () => {
		const state = makeState()
		expect(state.findSource('Wide')?.id).toBe('p2')

		state.upsertProducer('f1', producer({ id: 'p2', name: 'Camera 2', alias: 'Tight' }))
		expect(state.findSource('Wide')).toBeUndefined()
		expect(state.findSource('Tight')?.id).toBe('p2')

		state.upsertProducer('f1', producer({ id: 'p3', name: 'Camera 3', alias: null }))
		expect(state.findSource('Camera 3')?.id).toBe('p3')
		expect(state.sourceById('p3')?.name).toBe('Camera 3')

		state.removeProducer('p2')
		expect(state.findSource('Tight')).toBeUndefined()
		expect(state.sourceById('p2')).toBeUndefined()

		state.clear()
		expect(state.findSource('p1')).toBeUndefined()
	})

	it('clears endpoints, fabrics, nodes and workloads', () => {
		const state = makeState()
		state.setNodes([node({ id: 'n1', name: 'A' })])
		state.setWorkloads([workload({ id: 'w1', name: 'engine', state: 'Running' })])

		state.clear()
		expect(state.sources).toEqual([])
		expect(state.destinations).toEqual([])
		expect(state.fabrics).toEqual([])
		expect(state.nodes).toEqual([])
		expect(state.workloads.size).toBe(0)
	})
})

describe('RouterState routing table', () => {
	it('records a new route and reports the change', () => {
		const state = makeState()

		expect(state.setRoute('c1', 'p10')).toBe(true)
		expect(state.destinations[0].routedProducerId).toBe('p10')
	})

	it('reports no change for the current route or an unknown destination', () => {
		const state = makeState()

		expect(state.setRoute('c1', 'p2')).toBe(false)
		expect(state.setRoute('nope', 'p1')).toBe(false)
	})

	it('clears a pending route once it is made', () => {
		const state = makeState()
		state.destinations[0].pendingProducerId = 'p1'

		expect(state.setRoute('c1', 'p1')).toBe(true)
		expect(state.destinations[0].pendingProducerId).toBeNull()
	})

	it('keeps a pending route to a different source', () => {
		const state = makeState()
		state.destinations[0].pendingProducerId = 'p1'

		state.setRoute('c1', 'p10')
		expect(state.destinations[0].pendingProducerId).toBe('p1')
	})

	it('changes the list key only when ids or labels change', () => {
		const state = makeState()
		const key = state.definitionsKey()

		state.setRoute('c1', 'p10')
		state.destinations[0].locked = true
		expect(state.definitionsKey()).toBe(key)

		state.setEndpoints([
			{ fabric: FABRIC, producers: [producer({ id: 'p1', name: 'Camera 1', alias: 'Renamed' })], consumers: [] },
		])
		expect(state.definitionsKey()).not.toBe(key)
	})
})

describe('RouterState consumer updates', () => {
	const update = (changes: Partial<AmppConsumer>): AmppConsumer =>
		consumer({ id: 'c1', name: 'Monitor', alias: 'MV 1', routedProducerId: 'p2', ...changes })

	it('reports no change when nothing differs', () => {
		expect(makeState().upsertConsumer('f1', update({}))).toBe('unchanged')
	})

	it('applies route, lock, tally and enabled changes in place', () => {
		const state = makeState()
		const destination = state.destinations[0]

		expect(
			state.upsertConsumer('f1', update({ routedProducerId: 'p10', locked: true, tallyState: 'High', enabled: false })),
		).toBe('state')
		expect(destination).toMatchObject({
			routedProducerId: 'p10',
			locked: true,
			tallyState: 'High',
			enabled: false,
			label: 'MV 1',
		})
	})

	it('relabels and re-sorts a renamed destination', () => {
		const state = makeState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [],
				consumers: [update({}), update(producer({ id: 'c2', name: 'B', alias: null }))],
			},
		])

		expect(state.upsertConsumer('f1', update({ alias: 'A' }))).toBe('list')
		expect(state.destinationChoices()).toEqual([
			{ id: 'c1', label: 'A' },
			{ id: 'c2', label: 'B' },
		])
	})

	it('adds a destination it does not know, in label order', () => {
		const state = makeState()

		expect(state.upsertConsumer('f1', update(producer({ id: 'new', name: 'A new one', alias: null })))).toBe('list')
		expect(state.destinationChoices().map((c) => c.id)).toEqual(['new', 'c1'])
	})

	it('removes a destination', () => {
		const state = makeState()

		expect(state.removeConsumer('c1')).toBe(true)
		expect(state.destinations).toEqual([])
		expect(state.removeConsumer('c1')).toBe(false)
	})
})

describe('RouterState producer updates', () => {
	it('ignores an update that keeps the name and alias', () => {
		expect(makeState().upsertProducer('f1', producer({ id: 'p2', name: 'Camera 2', alias: 'Wide' }))).toBe('unchanged')
	})

	it('relabels and re-sorts a renamed source', () => {
		const state = makeState()

		expect(state.upsertProducer('f1', producer({ id: 'p10', name: 'Camera 10', alias: 'A' }))).toBe('list')
		expect(state.sourceChoices()[0]).toEqual({ id: 'p10', label: 'A' })
	})

	it('adds a source it does not know, in label order', () => {
		const state = makeState()

		expect(state.upsertProducer('f1', producer({ id: 'new', name: 'Camera 3', alias: null }))).toBe('list')
		expect(state.sourceChoices().map((c) => c.id)).toEqual(['p1', 'new', 'p10', 'p2'])
	})

	it('removes a source', () => {
		const state = makeState()

		expect(state.removeProducer('p2')).toBe(true)
		expect(state.findSource('p2')).toBeUndefined()
		expect(state.removeProducer('p2')).toBe(false)
	})
})

describe('RouterState with several fabrics', () => {
	const named = (id: string, name: string): AmppConsumer => consumer({ id, name })

	function makeTwoFabrics(): RouterState {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: { id: 'f1', name: 'Studio' },
				producers: [producer({ id: 'p1', name: 'Cam 1', alias: null }), producer({ id: 'p3', name: 'Aerial' })],
				consumers: [named('c1', 'MV 1')],
			},
			{
				fabric: { id: 'F2', name: 'Remote' },
				producers: [producer({ id: 'p2', name: 'Cam 1', alias: 'Wide' })],
				consumers: [named('c2', 'MV 1')],
			},
		])
		return state
	}

	it("records each endpoint's fabric and names it after the label, grouping by fabric", () => {
		const state = makeTwoFabrics()

		expect(state.sources.map((s) => [s.id, s.fabricId, s.label])).toEqual([
			['p2', 'F2', 'Wide (Remote)'],
			['p3', 'f1', 'Aerial (Studio)'],
			['p1', 'f1', 'Cam 1 (Studio)'],
		])
		expect(state.destinationChoices()).toEqual([
			{ id: 'c2', label: 'MV 1 (Remote)' },
			{ id: 'c1', label: 'MV 1 (Studio)' },
		])
	})

	it('leaves the fabric out of labels when there is only one', () => {
		expect(makeState().sources.every((s) => !s.label.includes('('))).toBe(true)
	})

	it('regroups the endpoints when a fabric is renamed', () => {
		const state = makeTwoFabrics()

		state.setEndpoints([
			{
				fabric: { id: 'f1', name: 'Studio' },
				producers: [producer({ id: 'p1', name: 'Cam 1', alias: null }), producer({ id: 'p3', name: 'Aerial' })],
				consumers: [],
			},
			{
				fabric: { id: 'F2', name: 'Truck' },
				producers: [producer({ id: 'p2', name: 'Cam 1', alias: 'Wide' })],
				consumers: [],
			},
		])

		expect(state.sources.map((s) => s.label)).toEqual(['Aerial (Studio)', 'Cam 1 (Studio)', 'Wide (Truck)'])
	})

	it('labels an added or renamed endpoint with its fabric', () => {
		const state = makeTwoFabrics()

		state.upsertConsumer('F2', named('c3', 'MV 2'))
		state.upsertProducer('f1', producer({ id: 'p1', name: 'Cam 1', alias: 'Close' }))

		expect(state.findDestination('c3')).toMatchObject({ fabricId: 'F2', label: 'MV 2 (Remote)' })
		expect(state.findSource('p1')?.label).toBe('Close (Studio)')
	})

	it('keeps an endpoint on its fabric when updated', () => {
		const state = makeTwoFabrics()

		state.upsertConsumer('f1', { ...named('c2', 'MV 1'), locked: true })
		expect(state.findDestination('c2')?.fabricId).toBe('F2')
	})

	it('finds a fabric id without case, and the fabric of a known endpoint', () => {
		const state = makeTwoFabrics()

		expect(state.findFabricId('f2')).toBe('F2')
		expect(state.findFabricId('nope')).toBeNull()
		expect(state.endpointFabricId('p2')).toBe('F2')
		expect(state.endpointFabricId('c1')).toBe('f1')
		expect(state.endpointFabricId('nope')).toBeNull()
	})
})

describe('RouterState source state', () => {
	it('applies tally, enabled and format changes in place', () => {
		const state = makeState()
		const source = state.findSource('p2')

		expect(
			state.upsertProducer(
				'f1',
				producer({ id: 'p2', name: 'Camera 2', alias: 'Wide', tallyState: 'High', format: '1080p50' }),
			),
		).toBe('state')
		expect(source).toMatchObject({ tallyState: 'High', format: '1080p50', label: 'Wide' })
	})
})

describe('RouterState nodes and workloads', () => {
	const namedNode = (id: string, name: string, online = true) => node({ id, name, online })
	const METRICS = {
		cpu: 1,
		memory: 2,
		gpu: null,
		gpuEncoder: null,
		gpuDecoder: null,
		gpuMemory: null,
		diskFree: null,
		ntpOffset: null,
	}

	it('sorts nodes by name and keeps metrics across a reload', () => {
		const state = new RouterState()
		state.setNodes([namedNode('n2', 'Node 10'), namedNode('n1', 'Node 2')])
		state.setNodeMetrics('n2', METRICS)
		state.setNodes([namedNode('n2', 'Node 10'), namedNode('n3', 'Node 3')])

		expect(state.nodes.map((n) => [n.id, n.metrics])).toEqual([
			['n3', null],
			['n2', METRICS],
		])
	})

	it('tells a state change from a new or renamed node', () => {
		const state = new RouterState()
		state.setNodes([namedNode('n1', 'A')])

		expect(state.upsertNode(namedNode('n1', 'A'))).toBe('unchanged')
		expect(state.upsertNode(namedNode('n1', 'A', false))).toBe('state')
		expect(state.upsertNode(namedNode('n1', 'B', false))).toBe('list')
		expect(state.upsertNode(namedNode('n2', 'C'))).toBe('list')
		expect(state.nodes.map((n) => n.name)).toEqual(['B', 'C'])
	})

	it("gives an endpoint's workload state, or null when it isn't known", () => {
		const state = new RouterState()
		state.setWorkloads([workload({ id: 'w1', name: 'engine', state: 'Running' })])

		expect(state.workloadState(producer({ id: 'p1', name: 'a', workloadId: 'w1' }))).toBe('Running')
		expect(state.workloadState(producer({ id: 'p2', name: 'b', workloadId: 'w2' }))).toBeNull()
		expect(state.workloadState(producer({ id: 'p3', name: 'c' }))).toBeNull()
	})

	it('changes the list key when a node is added or renamed', () => {
		const state = makeState()
		const key = state.definitionsKey()

		state.setNodes([namedNode('n1', 'A')])
		expect(state.definitionsKey()).not.toBe(key)
	})
})

describe('RouterState node lookup', () => {
	it('finds a node by id, then name, and lists them by name', () => {
		const state = new RouterState()
		state.setNodes([
			{ id: 'n2', name: 'Node B', online: true, runningWorkloads: 1, totalWorkloads: 1 },
			{ id: 'n1', name: 'Node A', online: false, runningWorkloads: 0, totalWorkloads: 1 },
		])

		expect(state.findNodeByRef('n2')?.name).toBe('Node B')
		expect(state.findNodeByRef(' Node A ')?.id).toBe('n1')
		expect(state.findNodeByRef('')).toBeUndefined()
		expect(state.nodeChoices()).toEqual([
			{ id: 'n1', label: 'Node A' },
			{ id: 'n2', label: 'Node B' },
		])
	})
})

describe('RouterState sources and destinations together', () => {
	it('finds either kind by id, name or alias', () => {
		const state = makeState()

		expect(state.findAnyEndpoint('p2')?.id).toBe('p2')
		expect(state.findAnyEndpoint('MV 1')?.id).toBe('c1')
		expect(state.findAnyEndpoint('nope')).toBeUndefined()
	})

	it('lists sources then destinations, saying which each is', () => {
		expect(makeState().endpointChoices()).toEqual([
			{ id: 'p1', label: 'Source: Camera 1' },
			{ id: 'p10', label: 'Source: Camera 10' },
			{ id: 'p2', label: 'Source: Wide' },
			{ id: 'c1', label: 'Destination: MV 1' },
		])
	})
})

describe('RouterState.fabricsDiffer', () => {
	function withFabrics(): RouterState {
		const state = new RouterState()
		state.setEndpoints([
			{ fabric: { id: 'f1', name: 'Studio' }, producers: [], consumers: [] },
			{ fabric: { id: 'f2', name: 'Remote' }, producers: [], consumers: [] },
		])
		return state
	}

	it('ignores the same fabrics in another order', () => {
		expect(
			withFabrics().fabricsDiffer([
				{ id: 'f2', name: 'Remote' },
				{ id: 'f1', name: 'Studio' },
			]),
		).toBe(false)
	})

	it('spots a fabric added, removed, replaced or renamed', () => {
		const state = withFabrics()
		const f1 = { id: 'f1', name: 'Studio' }

		expect(state.fabricsDiffer([f1, { id: 'f2', name: 'Remote' }, { id: 'f3', name: 'New' }])).toBe(true)
		expect(state.fabricsDiffer([f1])).toBe(true)
		expect(state.fabricsDiffer([f1, { id: 'f3', name: 'Remote' }])).toBe(true)
		expect(state.fabricsDiffer([f1, { id: 'f2', name: 'Remote 2' }])).toBe(true)
	})
})

describe('displayName', () => {
	const app = (name: string, alias: string | null = null) => workload({ id: 'app', name, alias })

	it("names an app's only endpoint after the app, or its alias", () => {
		const clock = producer({ id: 'p', name: 'clock-01 - Graphic Engine', alias: 'clock-01 - Graphic Engine' })

		expect(displayName(clock, app('clock-01'), true)).toBe('clock-01')
		expect(displayName(clock, app('clock-01', 'Clock'), true)).toBe('Clock')
		// AMPP sets an app's alias to its name until it's changed
		expect(displayName(clock, app('clock-01', 'clock-01'), true)).toBe('clock-01')
	})

	it("keeps one of several endpoints' own name, with the app alias in place of the app name", () => {
		const input = consumer({ id: 'c', name: 'multiview-01 - Input 1' })

		expect(displayName(input, app('multiview-01'), false)).toBe('multiview-01 - Input 1')
		expect(displayName(input, app('multiview-01', 'MV Wall'), false)).toBe('MV Wall - Input 1')
	})

	it('only swaps a whole app name at the start of the endpoint name', () => {
		expect(displayName(consumer({ id: 'c', name: 'multiview-010 - Input 1' }), app('multiview-01', 'MV'), false)).toBe(
			'multiview-010 - Input 1',
		)
		expect(displayName(consumer({ id: 'c', name: 'Input 1' }), app('multiview-01', 'MV'), false)).toBe('Input 1')
	})

	it("uses the endpoint's own alias over the app's, without either name alongside", () => {
		const cam = producer({ id: 'p', name: 'cam-01 - Live Engine', alias: 'Wide' })

		expect(displayName(cam, app('cam-01', 'Camera 1'), true)).toBe('Wide')
		expect(displayName(consumer({ id: 'c', name: 'mv - Input 1', alias: 'PGM' }), app('mv', 'Wall'), false)).toBe('PGM')
	})

	it("uses the endpoint's name when its app isn't known", () => {
		expect(displayName(producer({ id: 'p', name: 'virtual-producer-test' }), undefined, false)).toBe(
			'virtual-producer-test',
		)
	})
})

describe('RouterState labels from apps', () => {
	const FABRIC = { id: 'f1', name: 'Studio' }
	const apps = [
		workload({ id: 'clock', name: 'clock-01' }),
		workload({ id: 'clock-engine', name: 'clock-01 - Graphic Engine', parentId: 'clock' }),
		workload({ id: 'mv', name: 'multiview-01', alias: 'MV Wall' }),
		workload({ id: 'mv-engine', name: 'multiview-01 - Mocha MultiViewer', parentId: 'mv' }),
	]

	function makeAppState(): RouterState {
		const state = new RouterState()
		state.setWorkloads(apps)
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [
					producer({ id: 'p-clock', name: 'clock-01 - Graphic Engine', workloadId: 'clock-engine' }),
					producer({ id: 'p-mv', name: 'multiview-01', workloadId: 'mv-engine' }),
				],
				consumers: [
					consumer({ id: 'c-in1', name: 'multiview-01 - Input 1', workloadId: 'mv-engine' }),
					consumer({ id: 'c-in2', name: 'multiview-01 - Input 2', workloadId: 'mv-engine' }),
				],
			},
		])
		return state
	}

	it('labels a multiviewer output after the app and its inputs with the app alias', () => {
		const state = makeAppState()

		expect(state.sourceChoices()).toEqual([
			{ id: 'p-clock', label: 'clock-01' },
			{ id: 'p-mv', label: 'MV Wall' },
		])
		expect(state.destinationChoices()).toEqual([
			{ id: 'c-in1', label: 'MV Wall - Input 1' },
			{ id: 'c-in2', label: 'MV Wall - Input 2' },
		])
	})

	it("relabels an app's endpoints when a second one appears or one goes", () => {
		const state = makeAppState()

		expect(
			state.upsertProducer('f1', producer({ id: 'p-clock-2', name: 'clock-01 - Key', workloadId: 'clock-engine' })),
		).toBe('list')
		expect(state.findSource('p-clock')?.label).toBe('clock-01 - Graphic Engine')

		state.removeProducer('p-clock-2')
		expect(state.findSource('p-clock')?.label).toBe('clock-01')
	})

	it('relabels when an app is renamed, and keeps what an update leaves out', () => {
		const state = makeAppState()

		expect(state.upsertWorkload({ id: 'mv', alias: 'Wall' })).toBe('list')
		expect(state.findDestination('c-in1')?.label).toBe('Wall - Input 1')
		expect(state.workloads.get('mv')).toMatchObject({ name: 'multiview-01', alias: 'Wall', parentId: null })
	})

	it('reports a running state change without relabelling', () => {
		const state = makeAppState()

		expect(state.upsertWorkload({ id: 'mv-engine', state: 'Stopping' })).toBe('state')
		expect(state.upsertWorkload({ id: 'mv-engine', state: 'Stopping' })).toBe('unchanged')
		expect(state.workloads.get('mv-engine')?.parentId).toBe('mv')
	})
})
