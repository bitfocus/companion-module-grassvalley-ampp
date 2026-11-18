import {
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
	type CompanionSimplePresetDefinition,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import { DISCONNECT_LABEL, DISCONNECT_SOURCE } from './options.js'
import {
	appName,
	type RouterDestination,
	type RouterNode,
	type RouterSource,
	type RouterState,
} from './state/RouterState.js'
import { nodeVariablePrefix } from './variables.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const OFFLINE_RED = combineRgb(204, 0, 0)
const ROUTED_RED = combineRgb(255, 0, 0)
const SELECTED_YELLOW = combineRgb(255, 255, 0)
const GREEN = combineRgb(0, 204, 0)
const WARNING_AMBER = combineRgb(255, 153, 0)
const ERROR_RED = combineRgb(204, 0, 0)

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

// Template presets read the endpoint id from a local variable, which their groups fill in for each endpoint
const DESTINATION = { isExpression: true, value: '$(local:destination)' }
const SOURCE = { isExpression: true, value: '$(local:source)' }

/** The routing controls, and a template each for the destination and source buttons */
const ROUTING_PRESETS: CompanionPresetDefinitions<ModuleSchema> = {
	routing_destination: {
		type: 'simple',
		name: 'Select destination',
		keywords: ['routing', 'destination', 'select'],
		// Companion points `$(ampp:…)` at this connection's label when the preset is used
		style: {
			text: '$(ampp:dest_$(local:destination)_name)\\n$(ampp:dest_$(local:destination)_source)',
			size: 'auto',
			color: WHITE,
			bgcolor: BLACK,
		},
		steps: [{ down: [{ actionId: 'select_destination', options: { destination: DESTINATION } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'destination_selected',
				options: { destination: DESTINATION },
				style: { color: BLACK, bgcolor: SELECTED_YELLOW },
			},
		],
		localVariables: [{ variableType: 'simple', variableName: 'destination', startupValue: '' }],
	},
	routing_source: {
		type: 'simple',
		name: 'Select source',
		keywords: ['routing', 'source', 'route'],
		style: { text: '$(ampp:src_$(local:source)_name)', size: 'auto', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId: 'select_source', options: { source: SOURCE, wait_for_take: false } }], up: [] }],
		feedbacks: [
			{ feedbackId: 'routed_to_selected', options: { source: SOURCE }, style: { color: WHITE, bgcolor: ROUTED_RED } },
			{ feedbackId: 'source_selected', options: { source: SOURCE }, style: { color: BLACK, bgcolor: SELECTED_YELLOW } },
		],
		localVariables: [{ variableType: 'simple', variableName: 'source', startupValue: '' }],
	},
	routing_disconnect: {
		type: 'simple',
		name: 'Disconnect the selected destination',
		keywords: ['routing', 'disconnect', 'clear'],
		style: { text: DISCONNECT_LABEL, size: 'auto', color: WHITE, bgcolor: BLACK },
		steps: [
			{ down: [{ actionId: 'select_source', options: { source: DISCONNECT_SOURCE, wait_for_take: false } }], up: [] },
		],
		feedbacks: [
			{
				feedbackId: 'routed_to_selected',
				options: { source: DISCONNECT_SOURCE },
				style: { color: WHITE, bgcolor: ROUTED_RED },
			},
			{
				feedbackId: 'source_selected',
				options: { source: DISCONNECT_SOURCE },
				style: { color: BLACK, bgcolor: SELECTED_YELLOW },
			},
		],
	},
	routing_selected: {
		type: 'simple',
		name: 'Selected destination and its source',
		keywords: ['routing', 'selected', 'destination'],
		style: {
			text: '$(ampp:selected_destination)\\n$(ampp:selected_destination_source)',
			size: 'auto',
			color: BLACK,
			bgcolor: SELECTED_YELLOW,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [],
	},
	routing_take: {
		type: 'simple',
		name: 'Take',
		keywords: ['routing', 'take'],
		style: { text: 'TAKE', size: '18', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId: 'take', options: {} }], up: [] }],
		feedbacks: [{ feedbackId: 'selected_source', options: {}, style: { color: WHITE, bgcolor: GREEN } }],
	},
	routing_clear: {
		type: 'simple',
		name: 'Clear the source waiting for Take',
		keywords: ['routing', 'clear', 'cancel'],
		style: { text: 'CLEAR', size: '18', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId: 'clear_selected_source', options: {} }], up: [] }],
		feedbacks: [],
	},
}

/** A template group with a button for each endpoint on each fabric, which only names the fabric when there are several */
function endpointGroups(
	state: RouterState,
	kind: 'destination' | 'source',
	endpoints: readonly (RouterSource | RouterDestination)[],
): CompanionPresetGroup<ModuleSchema>[] {
	const several = state.fabrics.length > 1
	const title = kind === 'destination' ? 'Destinations' : 'Sources'
	// The endpoints are grouped by fabric already, so this keeps that order
	const fabricIds = [...new Set(endpoints.map((e) => e.fabricId))]
	return fabricIds.map((fabricId) => {
		const fabricName = state.fabrics.find((f) => f.id === fabricId)?.name ?? fabricId
		return {
			id: `routing-${kind}s-${fabricId}`,
			type: 'template',
			name: several ? `${title} on ${fabricName}` : title,
			presetId: `routing_${kind}`,
			templateVariableName: kind,
			templateValues: endpoints.filter((e) => e.fabricId === fabricId).map((e) => ({ name: e.label, value: e.id })),
		}
	})
}

/** Select a destination, then a source for it; each fabric's endpoints in their own groups */
export function routingPresets(state: RouterState): {
	structure: CompanionPresetSection<ModuleSchema>[]
	presets: CompanionPresetDefinitions<ModuleSchema>
} {
	if (!state.destinations.length) return { structure: [], presets: {} }
	return {
		structure: [
			{
				id: 'routing',
				name: 'Routing',
				description:
					'Select a destination, then press a source to route it to that destination. With Wait For Take on in the Select Source action of a source button, the source is selected until Take is pressed.',
				definitions: [
					{
						id: 'routing-controls',
						type: 'simple',
						name: 'Controls',
						presets: ['routing_selected', 'routing_take', 'routing_clear', 'routing_disconnect'],
					},
					...endpointGroups(state, 'destination', state.destinations),
					...endpointGroups(state, 'source', state.sources),
				],
			},
		],
		presets: ROUTING_PRESETS,
	}
}

const APP = { isExpression: true, value: '$(local:app)' }

/**
 * Green while Running, amber while Starting or Stopping, as AMPP names its states; red in error, last so it wins,
 * including an engine's error while the app itself still reads Running
 */
function appStateFeedbacks(): CompanionSimplePresetDefinition<ModuleSchema>['feedbacks'] {
	return [
		{
			feedbackId: 'app_state',
			options: { app: APP, state: 'Running' },
			style: { color: BLACK, bgcolor: GREEN },
		},
		{
			feedbackId: 'app_state',
			options: { app: APP, state: 'Starting' },
			style: { color: BLACK, bgcolor: WARNING_AMBER },
		},
		{
			feedbackId: 'app_state',
			options: { app: APP, state: 'Stopping' },
			style: { color: BLACK, bgcolor: WARNING_AMBER },
		},
		{ feedbackId: 'app_error', options: { app: APP }, style: { color: WHITE, bgcolor: ERROR_RED } },
	]
}

// A restart takes an app off air, so the button has to be held rather than tapped
const RESTART_HOLD_MS = 2000

/** An app's state, a held restart for it, and a summary of every app's state */
const APP_PRESETS: CompanionPresetDefinitions<ModuleSchema> = {
	app_status: {
		type: 'simple',
		name: 'App status',
		keywords: ['app', 'state', 'status'],
		style: {
			text: '$(ampp:app_$(local:app)_name)\\n$(ampp:app_$(local:app)_state)',
			size: 'auto',
			color: WHITE,
			bgcolor: BLACK,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: appStateFeedbacks(),
		localVariables: [{ variableType: 'simple', variableName: 'app', startupValue: '' }],
	},
	app_restart: {
		type: 'simple',
		name: 'Restart app (hold)',
		keywords: ['app', 'restart'],
		style: {
			text: 'HOLD TO RESTART\\n$(ampp:app_$(local:app)_name)',
			size: 'auto',
			color: WHITE,
			bgcolor: BLACK,
		},
		steps: [
			{
				down: [],
				up: [],
				[RESTART_HOLD_MS]: {
					options: { runWhileHeld: true },
					actions: [{ actionId: 'restart_app', options: { app: APP } }],
				},
			},
		],
		feedbacks: appStateFeedbacks(),
		localVariables: [{ variableType: 'simple', variableName: 'app', startupValue: '' }],
	},
	apps_summary: {
		type: 'simple',
		name: 'Apps running',
		keywords: ['app', 'state', 'summary'],
		style: {
			text: 'APPS\\n$(ampp:apps_running)/$(ampp:apps_total) RUNNING',
			size: 'auto',
			color: WHITE,
			bgcolor: BLACK,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{ feedbackId: 'any_app_state', options: { state: 'Starting' }, style: { color: BLACK, bgcolor: WARNING_AMBER } },
			{ feedbackId: 'any_app_state', options: { state: 'Stopping' }, style: { color: BLACK, bgcolor: WARNING_AMBER } },
			{ feedbackId: 'any_app_state', options: { state: 'Error' }, style: { color: WHITE, bgcolor: ERROR_RED } },
		],
	},
}

/** A status button and a held restart button for each app, after a summary of them all */
export function appPresets(state: RouterState): {
	structure: CompanionPresetSection<ModuleSchema>[]
	presets: CompanionPresetDefinitions<ModuleSchema>
} {
	const apps = state.apps
	if (!apps.length) return { structure: [], presets: {} }
	const templateValues = apps.map((app) => ({ name: appName(app), value: app.id }))
	return {
		structure: [
			{
				id: 'apps',
				name: 'App status',
				description: "Each AMPP app's own state: green while Running, amber while Starting or Stopping, red in Error",
				definitions: [
					{ id: 'apps-summary', type: 'simple', name: 'Summary', presets: ['apps_summary'] },
					{
						id: 'apps-status',
						type: 'template',
						name: 'Status',
						presetId: 'app_status',
						templateVariableName: 'app',
						templateValues,
					},
					{
						id: 'apps-restart',
						type: 'template',
						name: 'Restart (hold for 2 seconds)',
						presetId: 'app_restart',
						templateVariableName: 'app',
						templateValues,
					},
				],
			},
		],
		presets: APP_PRESETS,
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const sections = [routingPresets(self.state), appPresets(self.state), nodePresets(self.state.nodes)]
	self.setPresetDefinitions(
		sections.flatMap((s) => s.structure),
		Object.assign({}, ...sections.map((s) => s.presets)) as CompanionPresetDefinitions<ModuleSchema>,
	)
}
