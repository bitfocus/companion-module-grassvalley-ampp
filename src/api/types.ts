export interface AmppFabric {
	id: string
	name: string
}

// The wire shapes below follow the swagger, which marks almost every field nullable

export interface FabricsResponse {
	fabrics: Array<{ fabric: { id?: string | null; name?: string | null } | null }> | null
}

/** The list endpoints are paginated with an opaque continuation token */
export interface PagedResponse {
	hasMore?: boolean | null
	nextPageToken?: string | null
}

export type TallyState = 'Off' | 'Low' | 'High'

/** What sources and destinations have in common */
export interface AmppEndpoint {
	id: string
	name: string
	alias: string | null
	enabled: boolean
	tallyState: TallyState | null
	/** The engine workload behind the endpoint, whose running state it shares */
	workloadId: string | null
	/** The AMPP package the workload runs, e.g. `GV.Mocha.ClipPlayer` */
	packageName: string | null
}

export interface AmppProducer extends AmppEndpoint {
	/** The first picture flow's format, e.g. `1080p59.94` */
	format: string | null
}

/** A flow descriptor; virtual producers send every value as a string (objects JSON-encoded) */
export interface RawFlowDescriptor {
	height?: number | string | null
	progressive?: boolean | string | null
	rate?: { num?: number | null; den?: number | null } | string | null
}

export interface RawFlow {
	dataType?: string | null
	descriptor?: RawFlowDescriptor | null
}

export interface RawProducer {
	id?: string | null
	name?: string | null
	alias?: string | null
	fabricId?: string | null
	enabled?: boolean | null
	tallyState?: TallyState | null
	workloadId?: string | null
	properties?: { packageName?: string | null } | null
	stream?: { flows?: Array<RawFlow | null> | null } | null
}

export interface ProducersResponse extends PagedResponse {
	producers: Array<{ producer: RawProducer | null }> | null
}

export interface AmppConsumer extends AmppEndpoint {
	locked: boolean
	/** The source currently routed to this destination */
	routedProducerId: string | null
	/** The source of a route request that hasn't completed yet */
	pendingProducerId: string | null
}

export interface RawConsumer extends RawProducer {
	locked?: boolean | null
	routedProducerId?: string | null
	pendingProducerId?: string | null
}

export interface ConsumersResponse extends PagedResponse {
	consumers: Array<{ consumer: RawConsumer | null }> | null
}

export interface AmppNode {
	id: string
	name: string
	online: boolean
	runningWorkloads: number | null
	totalWorkloads: number | null
}

/** As in `GET /cluster/state/api/v1/nodes` and the `nodeState` of a `gv.cluster.nodestate.<id>.changed` notification */
export interface RawNodeState {
	online?: boolean | null
	runningWorkloadCount?: number | null
	totalWorkloadCount?: number | null
	nodeProperties?: { nodeId?: string | null; nodeName?: string | null } | null
}

export interface NodesResponse {
	nodes: Array<{ nodeId?: string | null; nodeName?: string | null; nodeState?: RawNodeState | null } | null> | null
}

/**
 * An app instance or one of its engines. An endpoint's `workloadId` is usually an engine, whose parent is the app
 * the user named (e.g. engine `clock-01 - Graphic Engine` under app `clock-01`).
 */
export interface AmppWorkload {
	id: string
	name: string
	alias: string | null
	/** The app an engine belongs to; null for an app itself */
	parentId: string | null
	/** e.g. `Running`, `Starting`, `Stopping`, `Ready` (stopped), `Error`; null before it's placed on a node */
	state: string | null
	/** What AMPP is trying to make it: `Running`, `Ready` (stopped) or `Removed` */
	desiredState: string | null
	/** Why it failed, e.g. `Unplaced` when no node could run it; null when it hasn't */
	error: string | null
	/** The node it runs on */
	nodeName: string | null
	/** e.g. `GV.AMPP.Apps.Clock` */
	packageName: string | null
}

/** AMPP's workload states, most used first, as its State Manager API names them */
export const WORKLOAD_STATES = [
	'Running',
	'Starting',
	'Stopping',
	'Ready',
	'Error',
	'Provisioning',
	'Unprovisioning',
	'Unprovisioned',
	'Selection',
	'Removed',
] as const

export type WorkloadState = (typeof WORKLOAD_STATES)[number]

/** What a notification says about a workload; a field it leaves out keeps its last known value */
export type WorkloadUpdate = Pick<AmppWorkload, 'id'> & Partial<Omit<AmppWorkload, 'id'>>

export interface RawWorkloadNodeState {
	state?: string | null
	nodeName?: string | null
	errorReason?: string | null
	errorReasonCode?: string | null
}

export interface RawWorkload {
	id?: string | null
	name?: string | null
	alias?: string | null
	parentId?: string | null
	packageName?: string | null
	desiredState?: { state?: string | null } | null
	/** Its state on the node it's assigned to */
	state?: RawWorkloadNodeState | null
	/** Its state on each node it's on */
	states?: Array<RawWorkloadNodeState | null> | null
}

export interface WorkloadsResponse {
	workloads: Array<{ workload: RawWorkload | null } | null> | null
}

/** Percentages are 0–100; null when the node doesn't report it */
export interface NodeMetrics {
	cpu: number | null
	memory: number | null
	gpu: number | null
	gpuEncoder: number | null
	gpuDecoder: number | null
	gpuMemory: number | null
	diskFree: number | null
	/** Microseconds; AMPP reports seconds */
	ntpOffset: number | null
}

/** The content of a `gv.cluster.node.<id>.performancemetrics` notification */
export interface RawNodeMetrics {
	nodeId?: string | null
	numa?: Array<{ totalCPU?: number | null; totalMemory?: number | null } | null> | null
	gpu?: Array<{
		gpuUsage?: number | null
		videoEncoderUsage?: number | null
		videoDecoderUsage?: number | null
		memoryUsagePercentage?: number | null
	} | null> | null
	drive?: Array<{ totalSpace?: number | null; availableFreeSpace?: number | null } | null> | null
	ntp?: { offset?: number | null } | null
}

export type RouteStatusValue =
	'Pending' | 'Routed' | 'Errored' | 'TimedOut' | 'Removing' | 'Removed' | 'Clearing' | 'Cleared'

export interface RouteStatus {
	routeStatus: RouteStatusValue
	routeErrorMessage: string | null
}

export interface RawRouteStatus {
	routeStatus: RouteStatusValue
	routeErrorMessage?: string | null
}

export interface RouteRequestResponse {
	requestId: string | null
	status: RawRouteStatus | null
}

export interface RouteRequest {
	requestId: string
	/** The status the request was accepted with, so the first poll can be skipped if it already completed */
	status: RouteStatus | null
}
