import { randomUUID } from 'node:crypto'
import { HubConnectionBuilder, LogLevel, type HubConnection } from '@microsoft/signalr'
import { toNode, toNodeMetrics, toWorkloadUpdate } from './ClusterStateApi.js'
import { toConsumer, toProducer, withIdAndName } from './MatrixApi.js'
import type {
	AmppConsumer,
	AmppNode,
	AmppProducer,
	WorkloadUpdate,
	NodeMetrics,
	RawConsumer,
	RawNodeState,
	RawWorkload,
} from './types.js'

/**
 * Source and destination changes on any fabric, e.g. `gv.cluster.matrix.consumer.updated`. The hub doesn't deliver
 * the `gv.cluster.matrix.<fabricId>.routemade` topic the SDK's mailbox uses, but a consumer update carries the routed
 * source, lock and tally state.
 */
export const MATRIX_TOPICS = ['gv.cluster.matrix.consumer.*', 'gv.cluster.matrix.producer.*']

/**
 * Node online state, workload (app) running state and renames, and node performance metrics (every few seconds per
 * node)
 */
export const CLUSTER_TOPICS = [
	'gv.cluster.nodestate.*.changed',
	'gv.cluster.workloadstate.*.changed',
	'gv.cluster.workload.*.updated',
	'gv.cluster.node.*.performancemetrics',
]

// After these the hub gives up and the connection is rebuilt from scratch
const HUB_RECONNECT_DELAYS_MS = [0, 2_000, 5_000, 10_000, 30_000]

export interface PlatformNotification {
	topic?: string | null
	/** A JSON string */
	content?: unknown
}

interface MatrixEventBase {
	/** The last part of the topic, e.g. `updated` */
	action: string
	fabricId: string | null
}

/** The endpoint is null when the content has no usable one */
export type MatrixEvent =
	| (MatrixEventBase & { kind: 'consumer'; endpoint: AmppConsumer | null })
	| (MatrixEventBase & { kind: 'producer'; endpoint: AmppProducer | null })

function parseContent(notification: PlatformNotification): unknown {
	const content = notification.content
	if (typeof content !== 'string') return content ?? null
	try {
		return JSON.parse(content)
	} catch {
		return null
	}
}

/** Reads a `gv.cluster.matrix.<consumer|producer>.<action>` notification, returning null for anything else */
export function parseMatrixEvent(notification: PlatformNotification): MatrixEvent | null {
	const parts = notification.topic?.split('.') ?? []
	if (parts.length !== 5 || parts[0] !== 'gv' || parts[2] !== 'matrix') return null
	const kind = parts[3]
	if (kind !== 'consumer' && kind !== 'producer') return null
	const action = parts[4]

	const raw = (parseContent(notification) as Record<string, RawConsumer | null | undefined> | null)?.[kind]
	const [item] = raw && typeof raw === 'object' ? withIdAndName([raw]) : []
	const fabricId = raw?.fabricId || null
	return kind === 'consumer'
		? { kind, action, fabricId, endpoint: item ? toConsumer(item) : null }
		: { kind, action, fabricId, endpoint: item ? toProducer(item) : null }
}

export type ClusterEvent =
	/** The name is null when the notification doesn't carry it */
	| { kind: 'node'; node: Omit<AmppNode, 'name'> & { name: string | null } }
	| { kind: 'workload'; workload: WorkloadUpdate }
	| { kind: 'metrics'; nodeId: string; metrics: NodeMetrics }

/**
 * Reads a `gv.cluster.nodestate.<id>.changed`, `gv.cluster.workloadstate.<id>.changed`,
 * `gv.cluster.workload.<id>.updated` or `gv.cluster.node.<id>.performancemetrics` notification, returning null for
 * anything else
 */
export function parseClusterEvent(notification: PlatformNotification): ClusterEvent | null {
	const parts = notification.topic?.split('.') ?? []
	if (parts.length !== 5 || parts[0] !== 'gv' || parts[1] !== 'cluster' || !parts[3]) return null
	const [, , kind, id, action] = parts
	const content = parseContent(notification) as Record<string, unknown> | null
	if (!content || typeof content !== 'object') return null

	if (kind === 'nodestate' && action === 'changed') {
		const nodeState = content.nodeState as RawNodeState | null | undefined
		if (!nodeState) return null
		return { kind: 'node', node: { ...toNode(id, id, nodeState), name: nodeState.nodeProperties?.nodeName || null } }
	}
	if (kind === 'workloadstate' && action === 'changed') {
		const workload = (content.workload ?? {}) as RawWorkload
		const state = typeof content.workloadState === 'string' ? content.workloadState : null
		return { kind: 'workload', workload: toWorkloadUpdate(id, workload, state) }
	}
	if (kind === 'workload' && action === 'updated') {
		const workload = content.workload as RawWorkload | null | undefined
		if (!workload) return null
		return { kind: 'workload', workload: toWorkloadUpdate(id, workload, workload.state?.state ?? undefined) }
	}
	if (kind === 'node' && action === 'performancemetrics') {
		return { kind: 'metrics', nodeId: id, metrics: toNodeMetrics(content) }
	}
	return null
}

/** The parts of a SignalR connection the listener uses */
export type NotificationHub = Pick<
	HubConnection,
	'start' | 'stop' | 'invoke' | 'on' | 'onclose' | 'onreconnecting' | 'onreconnected'
>

type HubLogLevel = 'debug' | 'warn' | 'error'

/** A connection to the platform's push-notification hub, which retries a few times by itself when it drops */
export function createNotificationHub(
	platformUrl: string,
	getAccessToken: () => Promise<string>,
	log: (level: HubLogLevel, message: string) => void,
): NotificationHub {
	return new HubConnectionBuilder()
		.withUrl(`${platformUrl}/pushnotificationshub`, { accessTokenFactory: getAccessToken })
		.withAutomaticReconnect(HUB_RECONNECT_DELAYS_MS)
		.configureLogging({
			log: (level, message) => {
				if (level >= LogLevel.Error) log('error', message)
				else if (level >= LogLevel.Warning) log('warn', message)
				else if (level >= LogLevel.Information) log('debug', message)
			},
		})
		.build()
}

/** As returned by the hub's Subscribe method, e.g. `{ status: 1, isSuccess: true, isError: false, errorResult: null }` */
interface SubscribeResult {
	isSuccess?: boolean
	isError?: boolean
	errorResult?: unknown
}

export interface NotificationListenerOptions {
	topics: string[]
	onNotifications: (notifications: PlatformNotification[]) => void
	/** The hub dropped and is retrying; anything sent until onResumed is missed */
	onInterrupted: (e: Error | undefined) => void
	/** The hub is back and resubscribed */
	onResumed: () => void
	/** The hub gave up reconnecting, or resubscribing failed; the listener needs closing and replacing */
	onError: (e: unknown) => void
}

/**
 * Receives platform notifications from the push-notification hub.
 * Lifecycle: `open()` connects and subscribes, the first `release()` begins delivering, `close()` disconnects.
 *
 * Notifications are held while a list load runs, so they're applied after (not overwritten by) the older snapshot it
 * returns: from construction until the first `release()`, and between each later `hold()` and its `release()`.
 */
export class NotificationListener {
	readonly #hub: NotificationHub
	readonly #options: NotificationListenerOptions
	readonly #correlationId = randomUUID()
	#closed = false
	#holds = 1
	#held: PlatformNotification[] = []

	constructor(hub: NotificationHub, options: NotificationListenerOptions) {
		this.#hub = hub
		this.#options = options
	}

	async open(): Promise<void> {
		this.#hub.on('ReceiveNotification', (notification: PlatformNotification) => this.#receive(notification))
		this.#hub.onreconnecting((e) => {
			if (!this.#closed) this.#options.onInterrupted(e)
		})
		// Subscriptions belong to the connection, so a reconnected one starts with none
		this.#hub.onreconnected(() => void this.#resubscribe())
		this.#hub.onclose((e) => {
			if (!this.#closed) this.#options.onError(e ?? new Error('Notification hub closed'))
		})

		await this.#hub.start()
		try {
			if (this.#closed) throw new Error('Listener closed while opening')
			await this.#subscribe()
		} catch (e) {
			await this.close()
			throw e
		}
	}

	hold(): void {
		this.#holds++
	}

	release(): void {
		if (this.#holds === 0) return
		this.#holds--
		if (this.#holds > 0) return
		const held = this.#held
		this.#held = []
		if (held.length && !this.#closed) this.#options.onNotifications(held)
	}

	async close(): Promise<void> {
		this.#closed = true
		this.#held = []
		try {
			await this.#hub.stop()
		} catch {
			// Already stopped or never connected
		}
	}

	#receive(notification: PlatformNotification): void {
		if (this.#closed) return
		if (this.#holds === 0) this.#options.onNotifications([notification])
		else this.#held.push(notification)
	}

	async #subscribe(): Promise<void> {
		const result = await this.#hub.invoke<SubscribeResult | null>('Subscribe', {
			Subscriptions: this.#options.topics,
			Context: { CorrelationId: this.#correlationId },
		})
		// The hub reports a refused subscription in the result rather than by throwing
		if (result?.isError || result?.isSuccess === false) {
			const reason = result.errorResult ? `: ${JSON.stringify(result.errorResult)}` : ''
			throw new Error(`Notification hub refused the subscription${reason}`)
		}
	}

	async #resubscribe(): Promise<void> {
		try {
			await this.#subscribe()
			if (!this.#closed) this.#options.onResumed()
		} catch (e) {
			if (!this.#closed) this.#options.onError(e)
		}
	}
}
