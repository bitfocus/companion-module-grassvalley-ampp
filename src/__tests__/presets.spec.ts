import type { CompanionPresetDefinitions, CompanionSimplePresetDefinition } from '@companion-module/base'
import { describe, expect, it } from 'vitest'
import { node } from '../api/__tests__/fixtures.js'
import type { ModuleSchema } from '../main.js'
import { nodePresets } from '../presets.js'
import type { RouterNode } from '../state/RouterState.js'

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
