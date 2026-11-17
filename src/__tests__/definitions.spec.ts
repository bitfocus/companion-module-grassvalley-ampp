import { describe, expect, it } from 'vitest'
import { UpdateActions } from '../actions.js'
import { UpdateFeedbacks } from '../feedbacks.js'
import type ModuleInstance from '../main.js'
import { RouterState } from '../state/RouterState.js'
import {
	destinationVariableValues,
	nodeVariableValues,
	sourceVariableValues,
	UpdateVariableDefinitions,
} from '../variables.js'
import { consumer, node, producer, workload } from '../api/__tests__/fixtures.js'

const SOURCE = 'ee35fcfe-7fd8-45ae-bdf3-ee407f5bb517'
const DESTINATION = '9593a95e-9ada-46b7-b75c-a01fdfb2472b'

function makeState(): RouterState {
	const state = new RouterState()
	state.setNodes([node({ id: 'n1', name: 'Node A', online: false, runningWorkloads: 0 })])
	state.setWorkloads([workload({ id: 'w1', name: 'engine', state: 'Running' })])
	state.setEndpoints([
		{
			fabric: { id: 'f1', name: 'Studio' },
			producers: [producer({ id: SOURCE, name: 'Cam 1', tallyState: 'High', workloadId: 'w1' })],
			consumers: [
				consumer({ id: DESTINATION, name: 'Monitor', locked: true, routedProducerId: SOURCE, enabled: false }),
			],
		},
	])
	return state
}

// The definition setters take the module's typed schema; what they're handed is all these tests read
type Definitions = Record<string, any>

/** A stand-in for the module that records the definitions it's given */
function makeModule(state: RouterState) {
	const registered: { variables: Definitions; actions: Definitions; feedbacks: Definitions } = {
		variables: {},
		actions: {},
		feedbacks: {},
	}
	const self = {
		state,
		setVariableDefinitions: (definitions: Definitions) => (registered.variables = definitions),
		setActionDefinitions: (definitions: Definitions) => (registered.actions = definitions),
		setFeedbackDefinitions: (definitions: Definitions) => (registered.feedbacks = definitions),
	} as unknown as ModuleInstance
	return { self, registered }
}

describe('variable definitions', () => {
	it('define every variable the module sets a value for', () => {
		const state = makeState()
		const { self, registered } = makeModule(state)
		UpdateVariableDefinitions(self)

		const values = {
			...destinationVariableValues(state, state.destinations),
			...sourceVariableValues(state, state.sources),
			...nodeVariableValues(state.nodes),
		}
		expect(Object.keys(values).filter((id) => !(id in registered.variables))).toEqual([])
	})
})

/** The Bitfocus Buttons middleware (`grassvalley_ampp_1_0_0`) reads these by name; changing one breaks it */
describe('router contract with the Buttons middleware', () => {
	it('keeps the route, lock and rename action ids and options', () => {
		const { self, registered } = makeModule(makeState())
		UpdateActions(self)

		const optionIds = (actionId: string) => registered.actions[actionId].options.map((o: { id: string }) => o.id)
		expect(optionIds('route')).toEqual(['source', 'destination'])
		expect(optionIds('lock')).toEqual(['destination', 'lock_state'])
		expect(optionIds('rename_source')).toEqual(['source', 'label'])
		expect(optionIds('rename_destination')).toEqual(['destination', 'label'])

		const [source] = registered.actions.route.options
		expect(source.choices[0]).toEqual({ id: 'disconnect', label: '(Disconnect)' })
		expect(source.choices.map((c: { id: string }) => c.id)).toContain(SOURCE)
		expect(registered.actions.lock.options[1].choices.map((c: { id: string }) => c.id)).toEqual(['L', 'U'])
	})

	it('keeps the routed source id, lock, fabric and label variables', () => {
		const state = makeState()

		expect(destinationVariableValues(state, state.destinations)).toMatchObject({
			[`dest_${DESTINATION}_source_id`]: SOURCE,
			[`dest_${DESTINATION}_locked`]: true,
			[`dest_${DESTINATION}_fabric`]: 'f1',
			[`dest_${DESTINATION}_label`]: '',
		})
		expect(sourceVariableValues(state, state.sources)).toMatchObject({
			[`src_${SOURCE}_fabric`]: 'f1',
			[`src_${SOURCE}_label`]: '',
		})
	})
})

describe('feedbacks', () => {
	const check = (feedbackId: string, options: Record<string, string>): boolean => {
		const { self, registered } = makeModule(makeState())
		UpdateFeedbacks(self)
		return registered.feedbacks[feedbackId].callback({ options }, {})
	}

	it('show a route, by id, name or alias', () => {
		expect(check('routed', { source: SOURCE, destination: DESTINATION })).toBe(true)
		expect(check('routed', { source: 'Cam 1', destination: 'Monitor' })).toBe(true)
		expect(check('routed', { source: 'nope', destination: DESTINATION })).toBe(false)
	})

	it('show lock, tally and enabled state', () => {
		expect(check('locked', { destination: DESTINATION })).toBe(true)
		expect(check('source_tally', { source: SOURCE, level: 'High' })).toBe(true)
		expect(check('source_tally', { source: SOURCE, level: 'Low' })).toBe(false)
		expect(check('endpoint_enabled', { endpoint: DESTINATION })).toBe(false)
		expect(check('endpoint_enabled', { endpoint: SOURCE })).toBe(true)
	})

	it("show an endpoint's app running and a node online", () => {
		expect(check('endpoint_running', { endpoint: SOURCE })).toBe(true)
		expect(check('endpoint_running', { endpoint: DESTINATION })).toBe(false)
		expect(check('node_online', { node: 'Node A' })).toBe(false)
		expect(check('node_online', { node: 'unknown' })).toBe(false)
	})
})
