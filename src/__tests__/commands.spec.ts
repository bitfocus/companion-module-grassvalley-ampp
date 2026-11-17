import { describe, expect, it, vi } from 'vitest'
import { consumer, producer } from '../api/__tests__/fixtures.js'
import type { Apis, Session } from '../api/Connection.js'
import type { MatrixApi } from '../api/MatrixApi.js'
import type { RouteRequest, RouteStatusValue } from '../api/types.js'
import { rename, route, setLocked, type CommandContext } from '../commands.js'
import { DISCONNECT_SOURCE } from '../options.js'
import { RouterState, type StateChanges } from '../state/RouterState.js'

/** Loads the lists, as a connection and each reload does */
function loadEndpoints(state: RouterState): void {
	state.setEndpoints([
		{
			fabric: { id: 'f1', name: 'Studio' },
			producers: [producer({ id: 'cam1', name: 'Cam 1' })],
			consumers: [consumer({ id: 'mon', name: 'Monitor', locked: true })],
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
	const ctx = {
		state,
		log: vi.fn(),
		setVariableValues: vi.fn((values: Record<string, unknown>) => Object.assign(variables, values)),
		getVariableValue: (id: string) => variables[id],
		publishChanges: () => published.push(state.takeChanges()),
	}
	return { typed: ctx as unknown as CommandContext, variables, published }
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
			'Gallery / Cam 2 and Studio / Monitor are on different fabrics',
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
			last_route: 'Studio / Cam 1 → Studio / Monitor',
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
			'Could not check the status of route Studio / Cam 1 → Studio / Monitor: The connection to AMPP ended',
		)
		expect(getRouteStatus).not.toHaveBeenCalled()
		expect(published).toEqual([])
	})

	it('clears the destination for the disconnect source', async () => {
		const clearRoute = accepted('Cleared')
		const { typed, variables } = makeContext(makeState())

		await route(typed, makeSession({ clearRoute }), DISCONNECT_SOURCE, 'mon')

		expect(clearRoute).toHaveBeenCalledWith('mon')
		expect(variables.last_route).toBe('Disconnect Studio / Monitor')
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
		).rejects.toThrow('Route Studio / Cam 1 → Studio / Monitor failed: No bandwidth')
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
