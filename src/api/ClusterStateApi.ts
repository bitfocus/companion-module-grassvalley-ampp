import type { AmppClient } from './AmppClient.js'
import { withIdAndName } from './MatrixApi.js'
import type {
	AmppNode,
	AmppWorkload,
	NodeMetrics,
	NodesResponse,
	RawNodeMetrics,
	RawNodeState,
	RawWorkload,
	WorkloadUpdate,
	WorkloadsResponse,
} from './types.js'

/** Maps a node from the list endpoint or a `nodestate.changed` notification */
export function toNode(id: string, name: string, nodeState: RawNodeState | null | undefined): AmppNode {
	return {
		id,
		name,
		online: !!nodeState?.online,
		runningWorkloads: nodeState?.runningWorkloadCount ?? null,
		totalWorkloads: nodeState?.totalWorkloadCount ?? null,
	}
}

/** The first failure its node states report: the reason, else just its code (e.g. `Unplaced`) */
function workloadError(workload: RawWorkload): string | null {
	for (const nodeState of [workload.state, ...(workload.states ?? [])]) {
		const error = nodeState?.errorReason || nodeState?.errorReasonCode
		if (error) return error
	}
	return null
}

function toWorkload(workload: RawWorkload & { id: string; name: string }): AmppWorkload {
	return {
		id: workload.id,
		name: workload.name,
		alias: workload.alias || null,
		parentId: workload.parentId || null,
		state: workload.state?.state || null,
		desiredState: workload.desiredState?.state || null,
		error: workloadError(workload),
		nodeName: workload.state?.nodeName || null,
		packageName: workload.packageName || null,
	}
}

/**
 * Only the fields the notification carries, so the rest keep their last known values. Notifications carry the whole
 * workload, desired state and node states included; older ones may carry less.
 */
export function toWorkloadUpdate(id: string, workload: RawWorkload, state: string | null | undefined): WorkloadUpdate {
	const hasNodeStates = 'state' in workload || 'states' in workload
	return {
		id,
		...(workload.name ? { name: workload.name } : {}),
		...('alias' in workload ? { alias: workload.alias || null } : {}),
		...('parentId' in workload ? { parentId: workload.parentId || null } : {}),
		...('packageName' in workload ? { packageName: workload.packageName || null } : {}),
		...('desiredState' in workload ? { desiredState: workload.desiredState?.state || null } : {}),
		...(hasNodeStates ? { error: workloadError(workload), nodeName: workload.state?.nodeName || null } : {}),
		...(state !== undefined ? { state } : {}),
	}
}

function average(values: ReadonlyArray<number | null | undefined>): number | null {
	const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
	return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null
}

/** One decimal place is plenty for a button */
function round(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

/** CPU and memory average the node's NUMA nodes; the GPU and disk figures are for the first one listed */
export function toNodeMetrics(raw: RawNodeMetrics): NodeMetrics {
	const gpu = raw.gpu?.[0]
	const drive = raw.drive?.[0]
	const diskFree =
		drive?.totalSpace && typeof drive.availableFreeSpace === 'number'
			? (drive.availableFreeSpace / drive.totalSpace) * 100
			: null
	return {
		cpu: round(average(raw.numa?.map((n) => n?.totalCPU) ?? [])),
		memory: round(average(raw.numa?.map((n) => n?.totalMemory) ?? [])),
		gpu: round(gpu?.gpuUsage),
		gpuEncoder: round(gpu?.videoEncoderUsage),
		gpuDecoder: round(gpu?.videoDecoderUsage),
		gpuMemory: round(gpu?.memoryUsagePercentage),
		diskFree: round(diskFree),
		ntpOffset: round(typeof raw.ntp?.offset === 'number' ? raw.ntp.offset * 1e6 : null),
	}
}

/** The cluster state service: which nodes are online and which workloads (the apps behind endpoints) are running */
export class ClusterStateApi {
	readonly #client: AmppClient
	readonly #signal: AbortSignal

	/** Requests are cancelled when `signal` is aborted */
	constructor(client: AmppClient, signal: AbortSignal) {
		this.#client = client
		this.#signal = signal
	}

	async listNodes(): Promise<AmppNode[]> {
		const res = await this.#client.get<NodesResponse>('/cluster/state/api/v1/nodes', null, this.#signal)
		return (res.nodes ?? []).flatMap((node) => {
			const id = node?.nodeId || node?.nodeState?.nodeProperties?.nodeId
			if (!id) return []
			return [toNode(id, node.nodeName || node.nodeState?.nodeProperties?.nodeName || id, node.nodeState)]
		})
	}

	async listWorkloads(): Promise<AmppWorkload[]> {
		const res = await this.#client.get<WorkloadsResponse>('/cluster/state/api/v1/workloads', null, this.#signal)
		return withIdAndName((res.workloads ?? []).map((w) => w?.workload ?? null)).map(toWorkload)
	}
}
