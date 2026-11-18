import { describe, expect, it, vi } from 'vitest'
import { consumer, producer, workload } from '../api/__tests__/fixtures.js'
import type { Apis, Session } from '../api/Connection.js'
import type { ControlApi } from '../api/ControlApi.js'
import type { MatrixApi } from '../api/MatrixApi.js'
import type { RouteRequest, RouteStatusValue } from '../api/types.js'
import {
	clearSelectedSource,
	controlApp,
	rename,
	route,
	selectDestination,
	Selection,
	selectSource,
	setLocked,
	take,
	type CommandContext,
} from '../commands.js'
import { DISCONNECT_SOURCE } from '../options.js'
import { RouterState, type StateChanges } from '../state/RouterState.js'

/** Loads the lists, as a connection and each reload does */
function loadEndpoints(state: RouterState): void {
	state.setEndpoints([
		{
			fabric: { id: 'f1', name: 'Studio' },
			producers: [producer({ id: 'cam1', name: 'Cam 1' }), producer({ id: 'cam3', name: 'Cam 3' })],
			consumers: [consumer({ id: 'mon', name: 'Monitor', locked: true }), consumer({ id: 'rec', name: 'Recorder' })],
		},
		{
			fabric: { id: 'f2', name: 'Gallery' },
			producers: [producer({ id: 'cam2', name: 'Cam 2' })],
			consumers: [],
		},
	])
}

function makeState(): RouterState {
	const state = new RouterState()
	loadEndpoints(state)
	state.takeChanges()
	return state
}

/** A stand-in for the module, recording the variables it's given and the changes it publishes */
function makeContext(state: RouterState) {
	const variables: Record<string, unknown> = {}
	const published: StateChanges[] = []
	const selection = new Selection(state)
	const selectionChanged = vi.fn()
	const ctx = {
		state,
		selection,
		log: vi.fn(),
		setVariableValues: vi.fn((values: Record<string, unknown>) => Object.assign(variables, values)),
		getVariableValue: (id: string) => variables[id],
		publishChanges: () => published.push(state.takeChanges()),
		selectionChanged,
	}
	return { typed: ctx as unknown as CommandContext, variables, published, selection, selectionChanged }
}

function makeSession(matrix: Partial<MatrixApi>, signal = new AbortController().signal): Session {
	return { apis: { matrix, cluster: {} } as unknown as Apis, signal, reload: vi.fn(async () => {}) }
}

const accepted = (routeStatus: RouteStatusValue, routeErrorMessage: string | null = null) =>
	vi.fn(async (): Promise<RouteRequest> => ({ requestId: 'r1', status: { routeStatus, routeErrorMessage } }))

describe('route', () => {
	it('refuses an unknown destination without asking AMPP', async () => {
		const requestRoute = vi.fn()
		const { typed } = makeContext(makeState())

		await expect(route(typed, makeSession({ requestRoute }), 'Cam 1', 'Nowhere')).rejects.toThrow(
			'Unknown destination: Nowhere',
		)
		expect(requestRoute).not.toHaveBeenCalled()
	})

	it('refuses a source on another fabric', async () => {
		const requestRoute = vi.fn()
		const { typed } = makeContext(makeState())

		await expect(route(typed, makeSession({ requestRoute }), 'cam2', 'mon')).rejects.toThrow(
			'Cam 2 (Gallery) and Monitor (Studio) are on different fabrics',
		)
		expect(requestRoute).not.toHaveBeenCalled()
	})

	it('records a route AMPP accepted as done', async () => {
		const state = makeState()
		const requestRoute = accepted('Routed')
		const { typed, variables, published } = makeContext(state)

		await route(typed, makeSession({ requestRoute }), 'cam1', 'mon')

		expect(requestRoute).toHaveBeenCalledWith('cam1', 'mon')
		expect(state.findDestination('mon')?.routedProducerId).toBe('cam1')
		expect(published).toEqual([expect.objectContaining({ destinations: [state.findDestination('mon')] })])
		expect(variables).toEqual({
			last_route: 'Cam 1 (Studio) → Monitor (Studio)',
			last_route_status: 'Routed',
			last_route_error: '',
		})
	})

	it('routes the same destination when the lists reloaded while it waited', async () => {
		const state = makeState()
		const destination = state.findDestination('mon')
		const requestRoute = vi.fn(async (): Promise<RouteRequest> => {
			loadEndpoints(state)
			return { requestId: 'r1', status: { routeStatus: 'Routed', routeErrorMessage: null } }
		})
		const { typed, published } = makeContext(state)

		await route(typed, makeSession({ requestRoute }), 'cam1', 'mon')

		expect(state.findDestination('mon')).toBe(destination)
		expect(destination?.routedProducerId).toBe('cam1')
		expect(published).toHaveLength(1)
	})

	it('stops following the route when the session ends', async () => {
		const controller = new AbortController()
		const requestRoute = accepted('Pending')
		const getRouteStatus = vi.fn()
		const session = makeSession({ requestRoute, getRouteStatus }, controller.signal)
		const { typed, published } = makeContext(makeState())

		const routing = route(typed, session, 'cam1', 'mon')
		await vi.waitFor(() => expect(requestRoute).toHaveBeenCalled())
		controller.abort(new Error('The connection to AMPP ended'))

		await expect(routing).rejects.toThrow(
			'Could not check the status of route Cam 1 (Studio) → Monitor (Studio): The connection to AMPP ended',
		)
		expect(getRouteStatus).not.toHaveBeenCalled()
		expect(published).toEqual([])
	})

	it('clears the destination for the disconnect source', async () => {
		const clearRoute = accepted('Cleared')
		const { typed, variables } = makeContext(makeState())

		await route(typed, makeSession({ clearRoute }), DISCONNECT_SOURCE, 'mon')

		expect(clearRoute).toHaveBeenCalledWith('mon')
		expect(variables.last_route).toBe('Disconnect Monitor (Studio)')
	})

	it('reports a refused request', async () => {
		const session = makeSession({ requestRoute: vi.fn().mockRejectedValue(new Error('Network down')) })
		const { typed, variables } = makeContext(makeState())

		await expect(route(typed, session, 'cam1', 'mon')).rejects.toThrow('Network down')
		expect(variables).toMatchObject({ last_route_status: 'Failed', last_route_error: 'Network down' })
	})

	it("throws AMPP's reason when the route fails", async () => {
		const state = makeState()
		const { typed, published } = makeContext(state)

		await expect(
			route(typed, makeSession({ requestRoute: accepted('Errored', 'No bandwidth') }), 'cam1', 'mon'),
		).rejects.toThrow('Route Cam 1 (Studio) → Monitor (Studio) failed: No bandwidth')
		expect(state.findDestination('mon')?.routedProducerId).toBeNull()
		expect(published).toEqual([])
	})
})

describe('setLocked', () => {
	it('updates the destination once AMPP has changed it', async () => {
		const state = makeState()
		const matrixSetLocked = vi.fn(async () => {})
		const { typed, published } = makeContext(state)

		await setLocked(typed, makeSession({ setLocked: matrixSetLocked }), 'mon', false)

		expect(matrixSetLocked).toHaveBeenCalledWith('mon', false)
		expect(state.findDestination('mon')?.locked).toBe(false)
		expect(published).toEqual([expect.objectContaining({ destinations: [state.findDestination('mon')] })])
	})

	it('publishes nothing when the destination was already in that state', async () => {
		const { typed, published } = makeContext(makeState())

		await setLocked(typed, makeSession({ setLocked: vi.fn(async () => {}) }), 'mon', true)

		expect(published).toEqual([])
	})
})

describe('rename', () => {
	it('resets the alias to the name for an empty label', async () => {
		const setAlias = vi.fn(async () => {})
		const { typed } = makeContext(makeState())

		await rename(typed, makeSession({ setAlias }), 'destination', 'mon', '  ')

		expect(setAlias).toHaveBeenCalledWith('consumer', 'mon', 'Monitor')
	})

	it('sets a trimmed alias on a source', async () => {
		const setAlias = vi.fn(async () => {})
		const { typed } = makeContext(makeState())

		await rename(typed, makeSession({ setAlias }), 'source', 'cam1', ' Wide ')

		expect(setAlias).toHaveBeenCalledWith('producer', 'cam1', 'Wide')
	})
})

describe('selecting a destination, then a source', () => {
	it('needs a destination before a source', async () => {
		const requestRoute = vi.fn()
		const { typed } = makeContext(makeState())

		await expect(selectSource(typed, makeSession({ requestRoute }), 'cam1', false)).rejects.toThrow(
			'Select a destination first',
		)
		expect(requestRoute).not.toHaveBeenCalled()
	})

	it('selects a destination by id, name or alias, once', () => {
		const state = makeState()
		const { typed, selection, selectionChanged } = makeContext(state)

		selectDestination(typed, 'Monitor')
		selectDestination(typed, 'mon')

		expect(selection.destination).toBe(state.findDestination('mon'))
		expect(selectionChanged).toHaveBeenCalledOnce()
		expect(() => selectDestination(typed, 'nope')).toThrow('Unknown destination: nope')
	})

	it('routes a source to the selected destination straight away', async () => {
		const requestRoute = accepted('Routed')
		const { typed, selection } = makeContext(makeState())
		selectDestination(typed, 'mon')

		await selectSource(typed, makeSession({ requestRoute }), 'Cam 1', false)

		expect(requestRoute).toHaveBeenCalledWith('cam1', 'mon')
		expect(selection.sourceId).toBeNull()
	})

	it('selects a source to route on Take', async () => {
		const state = makeState()
		const requestRoute = accepted('Routed')
		const session = makeSession({ requestRoute })
		const { typed, selection } = makeContext(state)
		selectDestination(typed, 'mon')

		await selectSource(typed, session, 'Cam 3', true)
		expect(requestRoute).not.toHaveBeenCalled()
		expect(selection.source).toBe(state.findSource('cam3'))
		expect(selection.isSourceSelected('cam3')).toBe(true)

		await take(typed, session)
		expect(requestRoute).toHaveBeenCalledWith('cam3', 'mon')
		expect(selection.sourceId).toBeNull()
	})

	it('keeps the source selected when Take fails, so it can be pressed again', async () => {
		const session = makeSession({ requestRoute: vi.fn().mockRejectedValue(new Error('The destination is locked')) })
		const { typed, selection } = makeContext(makeState())
		selectDestination(typed, 'mon')
		await selectSource(typed, session, 'cam3', true)

		await expect(take(typed, session)).rejects.toThrow('The destination is locked')
		expect(selection.sourceId).toBe('cam3')
	})

	it('drops a selected source when another button routes straight away', async () => {
		const requestRoute = accepted('Routed')
		const session = makeSession({ requestRoute })
		const { typed, selection } = makeContext(makeState())
		selectDestination(typed, 'mon')
		await selectSource(typed, session, 'cam3', true)

		await selectSource(typed, session, 'cam1', false)

		expect(requestRoute).toHaveBeenCalledWith('cam1', 'mon')
		expect(selection.sourceId).toBeNull()
	})

	it('has nothing to take without a selected source', async () => {
		const { typed } = makeContext(makeState())
		selectDestination(typed, 'mon')

		await expect(take(typed, makeSession({}))).rejects.toThrow('Nothing to take')
	})

	it('drops the selected source when another destination is selected, or when cleared', async () => {
		const session = makeSession({})
		const { typed, selection } = makeContext(makeState())
		selectDestination(typed, 'mon')
		await selectSource(typed, session, 'cam3', true)

		selectDestination(typed, 'rec')
		expect(selection.sourceId).toBeNull()

		await selectSource(typed, session, 'cam1', true)
		clearSelectedSource(typed)
		expect(selection.sourceId).toBeNull()
	})

	it('selects and shows a disconnect', async () => {
		const clearRoute = accepted('Cleared')
		const session = makeSession({ clearRoute })
		const { typed, selection } = makeContext(makeState())
		selectDestination(typed, 'rec')

		expect(selection.isRoutedToSelected(DISCONNECT_SOURCE)).toBe(true)
		await selectSource(typed, session, DISCONNECT_SOURCE, true)
		expect(selection.isSourceSelected(DISCONNECT_SOURCE)).toBe(true)
		expect(selection.source).toBeUndefined()

		await take(typed, session)
		expect(clearRoute).toHaveBeenCalledWith('rec')
	})

	it('shows which source is routed to the selected destination, by id or name', () => {
		const state = makeState()
		state.setRoute('mon', 'cam1')
		const { typed, selection } = makeContext(state)
		expect(selection.isRoutedToSelected('cam1')).toBe(false)

		selectDestination(typed, 'mon')
		expect(selection.isRoutedToSelected('cam1')).toBe(true)
		expect(selection.isRoutedToSelected('Cam 1')).toBe(true)
		expect(selection.isRoutedToSelected('cam3')).toBe(false)
		expect(selection.isRoutedToSelected(DISCONNECT_SOURCE)).toBe(false)
	})

	it('forgets a selected destination or source that has gone', async () => {
		const state = makeState()
		const { typed, selection } = makeContext(state)
		selectDestination(typed, 'mon')
		await selectSource(typed, makeSession({}), 'cam3', true)

		state.removeProducer('cam3')
		expect(selection.prune()).toBe(true)
		expect(selection.sourceId).toBeNull()
		expect(selection.destination?.id).toBe('mon')

		state.removeConsumer('mon')
		expect(selection.prune()).toBe(true)
		expect(selection.destination).toBeUndefined()
		expect(selection.prune()).toBe(false)
	})
})

describe('controlApp', () => {
	function withApp() {
		const state = makeState()
		state.setWorkloads([workload({ id: 'a1', name: 'signal-gen-02', alias: 'Bars' })])
		state.takeChanges()
		return state
	}
	const sessionWith = (command: ControlApi['command']): Session => ({
		...makeSession({}),
		apis: { matrix: {}, cluster: {}, control: { command } } as unknown as Apis,
	})

	it('asks AMPP to restart an app found by id, name or alias', async () => {
		const command = vi.fn(async () => 'cmd1')
		const { typed } = makeContext(withApp())

		await controlApp(typed, sessionWith(command), 'restart', 'Bars')

		expect(command).toHaveBeenCalledWith('restart', 'a1')
		expect(typed.log).toHaveBeenCalledWith('info', 'Asked AMPP to restart Bars (a1)')
	})

	it('refuses an unknown app without asking AMPP', async () => {
		const command = vi.fn(async () => 'cmd1')
		const { typed } = makeContext(withApp())

		await expect(controlApp(typed, sessionWith(command), 'stop', 'nope')).rejects.toThrow('Unknown app: nope')
		expect(command).not.toHaveBeenCalled()
	})

	it('reports a refused command', async () => {
		const command = vi.fn(async () => Promise.reject(new Error('Forbidden')))
		const { typed } = makeContext(withApp())

		await expect(controlApp(typed, sessionWith(command), 'start', 'a1')).rejects.toThrow(
			'Could not start Bars: Forbidden',
		)
	})
})
