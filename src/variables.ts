import type { CompanionVariableDefinitions } from '@companion-module/base'
import type { AmppWorkload, NodeMetrics } from './api/types.js'
import type ModuleInstance from './main.js'
import { DISCONNECT_LABEL, DISCONNECT_SOURCE } from './options.js'
import type { Selection } from './commands.js'
import {
	appName,
	distinctAlias,
	type RouterDestination,
	type RouterNode,
	type RouterSource,
	type RouterState,
} from './state/RouterState.js'

type EndpointPrefix = `dest_${string}` | `src_${string}`

export type VariablesSchema = {
	last_route: string
	last_route_status: string
	last_route_error: string
	first_load_complete: boolean
	selected_destination: string
	selected_destination_id: string
	selected_destination_source: string
	selected_source: string
	selected_source_id: string
	[variableId: `${EndpointPrefix}_name`]: string
	[variableId: `${EndpointPrefix}_app`]: string
	[variableId: `${EndpointPrefix}_state`]: string
	[variableId: `${EndpointPrefix}_label`]: string
	[variableId: `${EndpointPrefix}_fabric`]: string
	[variableId: `dest_${string}_source`]: string
	[variableId: `dest_${string}_source_id`]: string
	[variableId: `dest_${string}_locked`]: boolean
	[variableId: `src_${string}_format`]: string
	[variableId: `node_${string}_name`]: string
	[variableId: `node_${string}_online`]: boolean
	[variableId: `node_${string}_running_workloads`]: number | null
	[variableId: `node_${string}_total_workloads`]: number | null
	[variableId: `node_${string}_${MetricVariable}`]: number | null
	apps_total: number
	apps_running: number
	apps_error: number
	apps_error_names: string
	[variableId: `app_${string}_${AppVariable}`]: string
}

type AppVariable = 'name' | 'state' | 'error' | 'node'

type MetricVariable =
	'cpu' | 'memory' | 'gpu' | 'gpu_encoder' | 'gpu_decoder' | 'gpu_memory' | 'disk_free' | 'ntp_offset'

const METRICS: ReadonlyArray<{ id: MetricVariable; field: keyof NodeMetrics; name: string }> = [
	{ id: 'cpu', field: 'cpu', name: 'CPU %' },
	{ id: 'memory', field: 'memory', name: 'memory %' },
	{ id: 'gpu', field: 'gpu', name: 'GPU %' },
	{ id: 'gpu_encoder', field: 'gpuEncoder', name: 'GPU video encoder %' },
	{ id: 'gpu_decoder', field: 'gpuDecoder', name: 'GPU video decoder %' },
	{ id: 'gpu_memory', field: 'gpuMemory', name: 'GPU memory %' },
	{ id: 'disk_free', field: 'diskFree', name: 'disk free %' },
	{ id: 'ntp_offset', field: 'ntpOffset', name: 'NTP offset (µs)' },
]

/** Variable ids may only use letters, numbers, underscore and hyphen. AMPP ids are GUIDs, so this rarely changes them */
function variablePrefix<P extends string>(kind: P, id: string): `${P}_${string}` {
	return `${kind}_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function destinationVariablePrefix(destinationId: string): `dest_${string}` {
	return variablePrefix('dest', destinationId)
}

function sourceVariablePrefix(sourceId: string): `src_${string}` {
	return variablePrefix('src', sourceId)
}

export function nodeVariablePrefix(nodeId: string): `node_${string}` {
	return variablePrefix('node', nodeId)
}

export function appVariablePrefix(appId: string): `app_${string}` {
	return variablePrefix('app', appId)
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const definitions: CompanionVariableDefinitions<VariablesSchema> = {
		last_route: { name: 'Last route requested (source → destination)' },
		last_route_status: { name: 'Status of the last route request' },
		last_route_error: { name: 'Error from the last route request, if any' },
		first_load_complete: { name: 'Whether the lists have been loaded from AMPP since connecting' },
		selected_destination: { name: 'Selected destination' },
		selected_destination_id: { name: 'Selected destination id' },
		selected_destination_source: { name: "The selected destination's routed source" },
		selected_source: { name: 'Source waiting for Take' },
		selected_source_id: { name: 'Id of the source waiting for Take' },
		apps_total: { name: 'Apps: total' },
		apps_running: { name: 'Apps: Running' },
		apps_error: { name: 'Apps: in Error, or reporting an error (including their engines)' },
		apps_error_names: { name: 'Apps: names of those in error' },
	}
	const endpointDefinitions = (prefix: EndpointPrefix, label: string) => {
		definitions[`${prefix}_name`] = { name: `${label}: name (without its fabric)` }
		definitions[`${prefix}_app`] = { name: `${label}: AMPP package` }
		definitions[`${prefix}_state`] = { name: `${label}: app state (e.g. Running)` }
		definitions[`${prefix}_label`] = { name: `${label}: user label (AMPP alias, if it differs from the name)` }
		definitions[`${prefix}_fabric`] = { name: `${label}: fabric id` }
	}
	for (const destination of self.state.destinations) {
		const prefix = destinationVariablePrefix(destination.id)
		endpointDefinitions(prefix, destination.label)
		definitions[`${prefix}_source`] = { name: `${destination.label}: routed source` }
		definitions[`${prefix}_source_id`] = { name: `${destination.label}: routed source id` }
		definitions[`${prefix}_locked`] = { name: `${destination.label}: locked` }
	}
	for (const source of self.state.sources) {
		const prefix = sourceVariablePrefix(source.id)
		endpointDefinitions(prefix, source.label)
		definitions[`${prefix}_format`] = { name: `${source.label}: video format (e.g. 1080p59.94)` }
	}
	for (const node of self.state.nodes) {
		const prefix = nodeVariablePrefix(node.id)
		definitions[`${prefix}_name`] = { name: `Node ${node.name}: name` }
		definitions[`${prefix}_online`] = { name: `Node ${node.name}: online` }
		definitions[`${prefix}_running_workloads`] = { name: `Node ${node.name}: running workloads` }
		definitions[`${prefix}_total_workloads`] = { name: `Node ${node.name}: total workloads` }
		for (const metric of METRICS) definitions[`${prefix}_${metric.id}`] = { name: `Node ${node.name}: ${metric.name}` }
	}
	for (const app of self.state.apps) {
		const prefix = appVariablePrefix(app.id)
		const name = appName(app)
		definitions[`${prefix}_name`] = { name: `App ${name}: name` }
		definitions[`${prefix}_state`] = { name: `App ${name}: state (e.g. Running, or Ready when stopped)` }
		definitions[`${prefix}_error`] = { name: `App ${name}: error reason, if it or an engine reports one` }
		definitions[`${prefix}_node`] = { name: `App ${name}: node` }
	}
	self.setVariableDefinitions(definitions)
}

function endpointValues(
	state: RouterState,
	prefix: EndpointPrefix,
	endpoint: RouterSource | RouterDestination,
): Partial<VariablesSchema> {
	const values: Partial<VariablesSchema> = {}
	values[`${prefix}_name`] = endpoint.shortLabel
	values[`${prefix}_app`] = endpoint.packageName ?? ''
	values[`${prefix}_state`] = state.workloadState(endpoint) ?? ''
	values[`${prefix}_label`] = distinctAlias(endpoint) ?? ''
	values[`${prefix}_fabric`] = endpoint.fabricId
	return values
}

export function destinationVariableValues(
	state: RouterState,
	destinations: readonly RouterDestination[],
): Partial<VariablesSchema> {
	const values: Partial<VariablesSchema> = {}
	for (const destination of destinations) {
		const prefix = destinationVariablePrefix(destination.id)
		Object.assign(values, endpointValues(state, prefix, destination))
		values[`${prefix}_source`] = routedSourceLabel(state, destination)
		values[`${prefix}_source_id`] = destination.routedProducerId ?? ''
		values[`${prefix}_locked`] = destination.locked
	}
	return values
}

export function sourceVariableValues(state: RouterState, sources: readonly RouterSource[]): Partial<VariablesSchema> {
	const values: Partial<VariablesSchema> = {}
	for (const source of sources) {
		const prefix = sourceVariablePrefix(source.id)
		Object.assign(values, endpointValues(state, prefix, source))
		values[`${prefix}_format`] = source.format ?? ''
	}
	return values
}

/** A source we don't know about (e.g. added since the lists were loaded) still shows its id */
function routedSourceLabel(state: RouterState, destination: RouterDestination): string {
	const routed = destination.routedProducerId
	return routed ? (state.sourceById(routed)?.label ?? routed) : ''
}

/** The selected destination, what's routed to it, and the source waiting for Take */
export function selectionVariableValues(state: RouterState, selection: Selection): Partial<VariablesSchema> {
	const destination = selection.destination
	const sourceId = selection.sourceId
	return {
		selected_destination: destination?.label ?? '',
		selected_destination_id: destination?.id ?? '',
		selected_destination_source: destination ? routedSourceLabel(state, destination) : '',
		selected_source: sourceId === DISCONNECT_SOURCE ? DISCONNECT_LABEL : (selection.source?.label ?? ''),
		selected_source_id: sourceId ?? '',
	}
}

export function nodeVariableValues(nodes: readonly RouterNode[]): Partial<VariablesSchema> {
	const values: Partial<VariablesSchema> = {}
	for (const node of nodes) {
		const prefix = nodeVariablePrefix(node.id)
		values[`${prefix}_name`] = node.name
		values[`${prefix}_online`] = node.online
		values[`${prefix}_running_workloads`] = node.runningWorkloads
		values[`${prefix}_total_workloads`] = node.totalWorkloads
		for (const metric of METRICS) values[`${prefix}_${metric.id}`] = node.metrics?.[metric.field] ?? null
	}
	return values
}

/** Each app's name, state, error (its own or an engine's) and node */
export function appVariableValues(state: RouterState, apps: readonly AmppWorkload[]): Partial<VariablesSchema> {
	const values: Partial<VariablesSchema> = {}
	for (const app of apps) {
		const prefix = appVariablePrefix(app.id)
		values[`${prefix}_name`] = appName(app)
		values[`${prefix}_state`] = app.state ?? ''
		values[`${prefix}_error`] = state.appError(app) ?? ''
		values[`${prefix}_node`] = app.nodeName ?? ''
	}
	return values
}

/** How many apps there are, how many are Running, and which are in error */
export function appSummaryValues(state: RouterState): Partial<VariablesSchema> {
	const apps = state.apps
	const inError = apps.filter((app) => state.appHasError(app))
	return {
		apps_total: apps.length,
		apps_running: apps.filter((app) => app.state === 'Running').length,
		apps_error: inError.length,
		apps_error_names: inError.map(appName).join(', '),
	}
}
