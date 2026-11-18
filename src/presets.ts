import {
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
	type CompanionSimplePresetDefinition,
} from '@companion-module/base'
import { AMBER, BLACK, BLUE, GREEN, RED, WHITE } from './colors.js'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import { DISCONNECT_SOURCE } from './options.js'
import {
	appName,
	type RouterDestination,
	type RouterNode,
	type RouterSource,
	type RouterState,
} from './state/RouterState.js'
import { nodeVariablePrefix } from './variables.js'

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
				style: { color: WHITE, bgcolor: RED },
			},
		],
	}
}

/** The metrics a node button shows, one each, so the label and value fit on two short lines */
const NODE_METRICS = [
	{ variable: 'cpu', label: 'CPU', name: 'CPU' },
	{ variable: 'memory', label: 'MEM', name: 'Memory' },
	{ variable: 'gpu', label: 'GPU', name: 'GPU' },
	{ variable: 'gpu_encoder', label: 'ENC', name: 'GPU encoder' },
	{ variable: 'gpu_decoder', label: 'DEC', name: 'GPU decoder' },
	{ variable: 'disk_free', label: 'DISK', name: 'Disk free' },
] as const

/** One group per node: its online state and apps, then a button for each metric */
export function nodePresets(nodes: readonly RouterNode[]): {
	structure: CompanionPresetSection<ModuleSchema>[]
	presets: CompanionPresetDefinitions<ModuleSchema>
} {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const groups = nodes.map((node) => {
		const prefix = nodeVariablePrefix(node.id)
		// Companion points `$(ampp:…)` at this connection's label when the preset is used
		const v = (variable: string) => `$(ampp:${prefix}_${variable})`
		const ids = [`${prefix}_status`]
		presets[`${prefix}_status`] = statusPreset(
			node,
			'Status',
			`${v('name')}\\n${v('running_workloads')}/${v('total_workloads')} apps`,
		)
		for (const metric of NODE_METRICS) {
			const id = `${prefix}_${metric.variable}`
			presets[id] = statusPreset(node, metric.name, `${metric.label}\\n${v(metric.variable)}%`)
			ids.push(id)
		}
		return {
			id: `node-${node.id}`,
			type: 'simple' as const,
			name: node.name,
			presets: ids,
		}
	})

	if (!groups.length) return { structure: [], presets }
	return {
		structure: [
			{
				id: 'nodes',
				name: 'Node status',
				description: 'Per AMPP node: online and running apps, then each metric. Red while offline.',
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
			text: '$(ampp:dest_$(local:destination)_name)',
			size: 'auto',
			color: WHITE,
			bgcolor: BLACK,
		},
		steps: [{ down: [{ actionId: 'select_destination', options: { destination: DESTINATION } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'destination_selected',
				options: { destination: DESTINATION },
				style: { color: WHITE, bgcolor: BLUE },
			},
		],
		localVariables: [{ variableType: 'simple', variableName: 'destination', startupValue: '' }],
	},
	routing_source: {
		type: 'simple',
		name: 'Select source',
		keywords: ['routing', 'source', 'route'],
		style: { text: '$(ampp:src_$(local:source)_name)', size: 'auto', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId: 'select_source', options: { source: SOURCE, wait_for_take: true } }], up: [] }],
		feedbacks: [
			{ feedbackId: 'routed_to_selected', options: { source: SOURCE }, style: { color: WHITE, bgcolor: GREEN } },
			{ feedbackId: 'source_selected', options: { source: SOURCE }, style: { color: WHITE, bgcolor: BLUE } },
		],
		localVariables: [{ variableType: 'simple', variableName: 'source', startupValue: '' }],
	},
	routing_disconnect: {
		type: 'simple',
		name: 'Disconnect the selected destination',
		keywords: ['routing', 'disconnect', 'clear'],
		style: { text: 'DISCONNECT', size: 'auto', color: WHITE, bgcolor: BLACK },
		steps: [
			{ down: [{ actionId: 'select_source', options: { source: DISCONNECT_SOURCE, wait_for_take: true } }], up: [] },
		],
		feedbacks: [
			{
				feedbackId: 'routed_to_selected',
				options: { source: DISCONNECT_SOURCE },
				style: { color: WHITE, bgcolor: GREEN },
			},
			{
				feedbackId: 'source_selected',
				options: { source: DISCONNECT_SOURCE },
				style: { color: WHITE, bgcolor: BLUE },
			},
		],
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

/**
 * For each fabric, a template group of its source buttons, then one of its destination buttons. The fabric is only
 * named when there are several.
 */
function fabricGroups(state: RouterState): CompanionPresetGroup<ModuleSchema>[] {
	const several = state.fabrics.length > 1
	const fabricName = (id: string) => state.fabrics.find((f) => f.id === id)?.name ?? id
	const fabricIds = [...new Set([...state.sources, ...state.destinations].map((e) => e.fabricId))].sort((a, b) =>
		fabricName(a).localeCompare(fabricName(b), undefined, { numeric: true, sensitivity: 'base' }),
	)
	const group = (
		fabricId: string,
		kind: 'source' | 'destination',
		endpoints: readonly (RouterSource | RouterDestination)[],
	): CompanionPresetGroup<ModuleSchema>[] => {
		const onFabric = endpoints.filter((e) => e.fabricId === fabricId)
		if (!onFabric.length) return []
		const title = kind === 'source' ? 'Sources' : 'Destinations'
		return [
			{
				id: `routing-${kind}s-${fabricId}`,
				type: 'template',
				name: several ? `${fabricName(fabricId)}: ${title}` : title,
				presetId: `routing_${kind}`,
				templateVariableName: kind,
				templateValues: onFabric.map((e) => ({ name: e.label, value: e.id })),
			},
		]
	}
	return fabricIds.flatMap((id) => [
		...group(id, 'source', state.sources),
		...group(id, 'destination', state.destinations),
	])
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
				description: 'Select a destination and a source, then Take',
				definitions: [
					...fabricGroups(state),
					{
						id: 'routing-controls',
						type: 'simple',
						name: 'Controls',
						presets: ['routing_take', 'routing_clear', 'routing_disconnect'],
					},
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
			style: { color: WHITE, bgcolor: GREEN },
		},
		{
			feedbackId: 'app_state',
			options: { app: APP, state: 'Starting' },
			style: { color: WHITE, bgcolor: AMBER },
		},
		{
			feedbackId: 'app_state',
			options: { app: APP, state: 'Stopping' },
			style: { color: WHITE, bgcolor: AMBER },
		},
		{ feedbackId: 'app_error', options: { app: APP }, style: { color: WHITE, bgcolor: RED } },
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
			text: 'RESTART\\n$(ampp:app_$(local:app)_name)',
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
			{ feedbackId: 'any_app_state', options: { state: 'Starting' }, style: { color: WHITE, bgcolor: AMBER } },
			{ feedbackId: 'any_app_state', options: { state: 'Stopping' }, style: { color: WHITE, bgcolor: AMBER } },
			{ feedbackId: 'any_app_state', options: { state: 'Error' }, style: { color: WHITE, bgcolor: RED } },
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
