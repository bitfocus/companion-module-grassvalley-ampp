import { describe, expect, it } from 'vitest'
import { producer, workload } from '../../api/__tests__/fixtures.js'
import { RouterState } from '../RouterState.js'

const running = { state: 'Running', desiredState: 'Running' }

function makeState(): RouterState {
	const state = new RouterState()
	state.setWorkloads([
		workload({ id: 'clock', name: 'clock-01', alias: 'Clock', ...running }),
		workload({ id: 'clock-engine', name: 'clock-01 - Graphic Engine', parentId: 'clock', ...running }),
		workload({ id: 'mv', name: 'multiview-01', ...running }),
	])
	state.setEndpoints([
		{
			fabric: { id: 'f1', name: 'Studio' },
			producers: [producer({ id: 'p1', name: 'clock-01 - Graphic Engine', workloadId: 'clock-engine' })],
			consumers: [],
		},
	])
	state.takeChanges()
	return state
}

describe('RouterState apps', () => {
	it('lists only the apps, not their engines, by name', () => {
		const state = makeState()

		expect(state.apps.map((a) => a.id)).toEqual(['clock', 'mv'])
		expect(state.appChoices()).toEqual([
			{ id: 'clock', label: 'Clock' },
			{ id: 'mv', label: 'multiview-01' },
		])
	})

	it('finds an app by id, name or alias, but not an engine', () => {
		const state = makeState()

		expect(state.findApp('clock')?.id).toBe('clock')
		expect(state.findApp('clock-01')?.id).toBe('clock')
		expect(state.findApp(' Clock ')?.id).toBe('clock')
		expect(state.findApp('clock-engine')).toBeUndefined()
	})

	it('is in error when it or an engine is in Error or reports an error reason', () => {
		const state = makeState()
		const clock = () => state.findApp('clock')!
		expect(state.appHasError(clock())).toBe(false)

		state.upsertWorkload({ id: 'clock-engine', state: 'Error' })
		expect(state.appHasError(clock())).toBe(true)
		expect(state.appError(clock())).toBeNull()

		state.upsertWorkload({ id: 'clock-engine', state: 'Running', error: 'Licence expired' })
		expect(state.appHasError(clock())).toBe(true)
		expect(state.appError(clock())).toBe('Licence expired')

		// Reported by AMPP when no node can run it
		state.upsertWorkload({ id: 'mv', state: null, error: 'Unplaced' })
		expect(state.appHasError(state.findApp('mv')!)).toBe(true)
	})

	it('records the app when it or one of its engines changes', () => {
		const state = makeState()

		state.upsertWorkload({ id: 'clock-engine', desiredState: 'Ready' })
		expect(state.takeChanges()).toMatchObject({ lists: false, apps: [state.findApp('clock')] })

		state.upsertWorkload({ id: 'clock', nodeName: 'mesh-2' })
		expect(state.takeChanges().apps).toEqual([state.findApp('clock')])

		state.upsertWorkload({ id: 'clock', nodeName: 'mesh-2' })
		expect(state.takeChanges().apps).toEqual([])
	})

	it("records an engine's state change for the endpoints on it too", () => {
		const state = makeState()

		state.upsertWorkload({ id: 'clock-engine', state: 'Stopping' })

		expect(state.takeChanges()).toMatchObject({ sources: [state.findSource('p1')], apps: [state.findApp('clock')] })
	})

	it('treats a new or renamed app as a list change, but not a new engine', () => {
		const state = makeState()

		state.upsertWorkload({ id: 'clock', alias: 'Studio clock' })
		expect(state.takeChanges().lists).toBe(true)

		state.upsertWorkload({ id: 'player', name: 'clip-player', ...running })
		expect(state.takeChanges().lists).toBe(true)

		state.upsertWorkload({ id: 'player-engine', name: 'clip-player - Engine', parentId: 'player', ...running })
		expect(state.takeChanges()).toMatchObject({ lists: false, apps: [state.findApp('player')] })
	})
})
