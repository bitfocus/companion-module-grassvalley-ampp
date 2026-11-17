import {
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionPresetSection,
	type CompanionSimplePresetDefinition,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import type { RouterNode } from './state/RouterState.js'
import { nodeVariablePrefix } from './variables.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const OFFLINE_RED = combineRgb(204, 0, 0)

type Preset = CompanionSimplePresetDefinition<ModuleSchema>

/** A status button: nothing to press, red while the node is offline */
function statusPreset(node: RouterNode, name: string, text: string): Preset {
	return {
		type: 'simple',
		name: `${node.name}: ${name}`,
		keywords: ['node', 'status', node.name],
		style: { text, size: 'auto', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{
				feedbackId: 'node_online',
				options: { node: node.id },
				isInverted: true,
				style: { color: WHITE, bgcolor: OFFLINE_RED },
			},
		],
	}
}

/** One group of status buttons per node: online and apps, CPU/memory, GPU and disk */
export function nodePresets(nodes: readonly RouterNode[]): {
	structure: CompanionPresetSection<ModuleSchema>[]
	presets: CompanionPresetDefinitions<ModuleSchema>
} {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const groups = nodes.map((node) => {
		// Companion points `$(ampp:…)` at this connection's label when the preset is used
		const v = (variable: string) => `$(ampp:${nodeVariablePrefix(node.id)}_${variable})`
		const ids = {
			status: `${nodeVariablePrefix(node.id)}_status`,
			cpu: `${nodeVariablePrefix(node.id)}_cpu`,
			gpu: `${nodeVariablePrefix(node.id)}_gpu`,
			disk: `${nodeVariablePrefix(node.id)}_disk`,
		}
		presets[ids.status] = statusPreset(
			node,
			'Status',
			`${v('name')}\\n${v('running_workloads')}/${v('total_workloads')} apps`,
		)
		presets[ids.cpu] = statusPreset(node, 'CPU and memory', `CPU ${v('cpu')}%\\nMEM ${v('memory')}%`)
		presets[ids.gpu] = statusPreset(
			node,
			'GPU',
			`GPU ${v('gpu')}%\\nENC ${v('gpu_encoder')}%\\nDEC ${v('gpu_decoder')}%`,
		)
		presets[ids.disk] = statusPreset(node, 'Disk', `Disk free\\n${v('disk_free')}%`)
		return {
			id: `node-${node.id}`,
			type: 'simple' as const,
			name: node.name,
			presets: Object.values(ids),
		}
	})

	if (!groups.length) return { structure: [], presets }
	return {
		structure: [
			{
				id: 'nodes',
				name: 'Node status',
				description: 'Per AMPP node: online and running apps, CPU and memory, GPU, and disk. Red while offline.',
				definitions: groups,
			},
		],
		presets,
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const { structure, presets } = nodePresets(self.state.nodes)
	self.setPresetDefinitions(structure, presets)
}
