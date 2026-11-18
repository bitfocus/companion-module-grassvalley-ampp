import type { CompanionPresetDefinitions, CompanionSimplePresetDefinition } from '@companion-module/base'
import { describe, expect, it } from 'vitest'
import { consumer, node, producer, workload } from '../api/__tests__/fixtures.js'
import type { ModuleSchema } from '../main.js'
import { appPresets, nodePresets, routingPresets } from '../presets.js'
import { RouterState, type RouterNode } from '../state/RouterState.js'

function simplePreset(
	presets: CompanionPresetDefinitions<ModuleSchema>,
	id: string,
): CompanionSimplePresetDefinition<ModuleSchema> {
	const preset = presets[id]
	if (preset?.type !== 'simple') throw new Error(`${id} is not a simple preset`)
	return preset
}

const routerNode = (id: string, name: string): RouterNode => ({ ...node({ id, name }), metrics: null })

describe('nodePresets', () => {
	it('offers nothing without nodes', () => {
		expect(nodePresets([])).toEqual({ structure: [], presets: {} })
	})

	it('gives each node a group of status buttons', () => {
		const { structure, presets } = nodePresets([routerNode('n1', 'Node A'), routerNode('n2', 'Node B')])

		expect(structure).toHaveLength(1)
		expect(structure[0]?.definitions).toEqual([
			{
				id: 'node-n1',
				type: 'simple',
				name: 'Node A',
				presets: ['node_n1_status', 'node_n1_cpu', 'node_n1_gpu', 'node_n1_disk'],
			},
			{
				id: 'node-n2',
				type: 'simple',
				name: 'Node B',
				presets: ['node_n2_status', 'node_n2_cpu', 'node_n2_gpu', 'node_n2_disk'],
			},
		])
		expect(Object.keys(presets)).toHaveLength(8)
	})

	it("shows the node's variables, and turns red while it's offline", () => {
		const { presets } = nodePresets([routerNode('n1', 'Node A')])

		expect(simplePreset(presets, 'node_n1_status').style.text).toBe(
			'$(ampp:node_n1_name)\\n$(ampp:node_n1_running_workloads)/$(ampp:node_n1_total_workloads) apps',
		)
		expect(simplePreset(presets, 'node_n1_cpu').style.text).toBe(
			'CPU $(ampp:node_n1_cpu)%\\nMEM $(ampp:node_n1_memory)%',
		)
		expect(simplePreset(presets, 'node_n1_disk').feedbacks).toEqual([
			expect.objectContaining({ feedbackId: 'node_online', options: { node: 'n1' }, isInverted: true }),
		])
	})
})

describe('routingPresets', () => {
	it('offers nothing without destinations', () => {
		expect(routingPresets(new RouterState())).toEqual({ structure: [], presets: {} })
	})

	it('groups the destination and source buttons by fabric, after the controls', () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: { id: 'f2', name: 'Truck' },
				producers: [producer({ id: 'p2', name: 'Cam 2' })],
				consumers: [consumer({ id: 'c2', name: 'Monitor' })],
			},
			{
				fabric: { id: 'f1', name: 'Studio' },
				producers: [producer({ id: 'p1', name: 'Cam 1' })],
				consumers: [consumer({ id: 'c1', name: 'Monitor' })],
			},
		])

		const [section] = routingPresets(state).structure
		expect(
			section?.definitions.map((group) =>
				typeof group === 'string' || group.type === 'simple'
					? group
					: [group.name, group.presetId, group.templateValues],
			),
		).toEqual([
			expect.objectContaining({ id: 'routing-controls' }),
			['Destinations on Studio', 'routing_destination', [{ name: 'Monitor (Studio)', value: 'c1' }]],
			['Destinations on Truck', 'routing_destination', [{ name: 'Monitor (Truck)', value: 'c2' }]],
			['Sources on Studio', 'routing_source', [{ name: 'Cam 1 (Studio)', value: 'p1' }]],
			['Sources on Truck', 'routing_source', [{ name: 'Cam 2 (Truck)', value: 'p2' }]],
		])
	})

	it("routes from a source button to the selected destination, lit while it's routed there", () => {
		const state = new RouterState()
		state.setEndpoints([
			{ fabric: { id: 'f1', name: 'Studio' }, producers: [], consumers: [consumer({ id: 'c1', name: 'MV' })] },
		])
		const source = simplePreset(routingPresets(state).presets, 'routing_source')

		expect(source.steps[0]?.down).toEqual([
			{
				actionId: 'select_source',
				options: { source: { isExpression: true, value: '$(local:source)' }, wait_for_take: false },
			},
		])
		expect(source.feedbacks.map((f) => f.feedbackId)).toEqual(['routed_to_selected', 'source_selected'])
		expect(source.style.text).toBe('$(ampp:src_$(local:source)_name)')
	})
})

describe('appPresets', () => {
	it('offers nothing without apps', () => {
		expect(appPresets(new RouterState())).toEqual({ structure: [], presets: {} })
	})

	it('has a summary, then a status and a held restart button for each app', () => {
		const state = new RouterState()
		state.setWorkloads([
			workload({ id: 'a1', name: 'signal-gen-02', alias: 'Bars' }),
			workload({ id: 'e1', name: 'signal-gen-02 - Live Engine', parentId: 'a1' }),
		])
		const { structure, presets } = appPresets(state)

		expect(
			structure[0]?.definitions.map((group) =>
				typeof group === 'string' ? group : group.type === 'simple' ? group.presets : group.templateValues,
			),
		).toEqual([['apps_summary'], [{ name: 'Bars', value: 'a1' }], [{ name: 'Bars', value: 'a1' }]])
		expect(
			simplePreset(presets, 'app_status').feedbacks.map((f) => [
				f.feedbackId,
				(f.options as { state?: string }).state ?? null,
			]),
		).toEqual([
			['app_state', 'Running'],
			['app_state', 'Starting'],
			['app_state', 'Stopping'],
			['app_error', null],
		])
		const restart = simplePreset(presets, 'app_restart')
		expect(restart.steps[0]?.down).toEqual([])
		expect(restart.steps[0]?.[2000]).toEqual({
			options: { runWhileHeld: true },
			actions: [{ actionId: 'restart_app', options: { app: { isExpression: true, value: '$(local:app)' } } }],
		})
	})
})
