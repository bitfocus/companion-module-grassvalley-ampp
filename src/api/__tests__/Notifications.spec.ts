import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumer, producer } from './fixtures.js'
import {
	MATRIX_TOPICS,
	NotificationListener,
	parseClusterEvent,
	parseMatrixEvent,
	type NotificationHub,
	type NotificationListenerOptions,
	type PlatformNotification,
} from '../Notifications.js'

const FABRIC = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const TOPIC = 'gv.cluster.matrix.consumer.updated'

describe('parseMatrixEvent', () => {
	// Trimmed from a real notification
	const content = JSON.stringify({
		consumer: {
			id: 'c1',
			name: 'mult-01 - Input 4',
			alias: 'mult-01 - Input 4',
			fabricId: FABRIC,
			groupName: 'IN',
			type: 'Fabric',
			tallyState: 'Off',
			locked: false,
			flags: 0,
			routedProducerId: 'p1',
			enabled: true,
		},
		eTag: 'cbcc3a5fe94140a884f315203d7ae435',
		action: 'updated',
		siteId: null,
	})

	it('reads the action from the topic and the consumer from the JSON content', () => {
		expect(parseMatrixEvent({ topic: TOPIC, content })).toEqual({
			kind: 'consumer',
			action: 'updated',
			fabricId: FABRIC,
			endpoint: consumer({
				id: 'c1',
				name: 'mult-01 - Input 4',
				alias: 'mult-01 - Input 4',
				tallyState: 'Off',
				routedProducerId: 'p1',
			}),
		})
	})

	it('accepts content that is already an object', () => {
		expect(parseMatrixEvent({ topic: TOPIC, content: { consumer: { id: 'c1', locked: true } } })).toMatchObject({
			fabricId: null,
			endpoint: { id: 'c1', name: 'c1', locked: true },
		})
	})

	it.each<[string, PlatformNotification]>([
		['invalid JSON', { topic: TOPIC, content: '{nope' }],
		['no consumer', { topic: TOPIC, content: '{"consumerId":"c1"}' }],
		['a consumer without an id', { topic: TOPIC, content: '{"consumer":{"name":"x"}}' }],
		['null content', { topic: TOPIC, content: null }],
	])('keeps the action but no consumer for %s', (_name, message) => {
		expect(parseMatrixEvent(message)).toEqual({ kind: 'consumer', action: 'updated', fabricId: null, endpoint: null })
	})

	it('reads a producer update', () => {
		expect(
			parseMatrixEvent({
				topic: 'gv.cluster.matrix.producer.updated',
				content: JSON.stringify({
					producer: { id: 'p1', name: 'clock', alias: null, fabricId: FABRIC, routedConsumerIds: ['c1'] },
					action: 'updated',
				}),
			}),
		).toEqual({
			kind: 'producer',
			action: 'updated',
			fabricId: FABRIC,
			endpoint: producer({ id: 'p1', name: 'clock' }),
		})
	})

	it('does not read a consumer from a producer topic', () => {
		expect(parseMatrixEvent({ topic: 'gv.cluster.matrix.producer.updated', content })).toMatchObject({
			kind: 'producer',
			endpoint: null,
		})
	})

	it.each<[string, PlatformNotification]>([
		['another kind of topic', { topic: 'gv.cluster.matrix.route.updated', content }],
		['a routemade topic', { topic: `gv.cluster.matrix.${FABRIC}.routemade`, content }],
		['a topic with extra parts', { topic: 'gv.cluster.matrix.consumer.x.updated', content }],
		['no topic', { topic: null, content }],
	])('ignores %s', (_name, message) => {
		expect(parseMatrixEvent(message)).toBeNull()
	})
})

/** Stands in for a SignalR HubConnection, letting tests fire its events */
class FakeHub implements NotificationHub {
	readonly start = vi.fn(async () => {})
	readonly invoke = vi.fn(async (_method: string, ..._args: unknown[]) => undefined as never)
	readonly stop = vi.fn(async () => {
		this.#close?.(undefined)
	})
	#handlers = new Map<string, (...args: never[]) => void>()
	#close: ((e?: Error) => void) | null = null
	#reconnecting: ((e?: Error) => void) | null = null
	#reconnected: ((id?: string) => void) | null = null

	on(name: string, handler: (...args: never[]) => void): void {
		this.#handlers.set(name, handler)
	}
	onclose(callback: (e?: Error) => void): void {
		this.#close = callback
	}
	onreconnecting(callback: (e?: Error) => void): void {
		this.#reconnecting = callback
	}
	onreconnected(callback: (id?: string) => void): void {
		this.#reconnected = callback
	}

	receive(notification: PlatformNotification): void {
		;(this.#handlers.get('ReceiveNotification') as (n: PlatformNotification) => void)(notification)
	}
	dropAndRetry(): void {
		this.#reconnecting?.(new Error('socket closed'))
	}
	reconnect(): void {
		this.#reconnected?.('new-id')
	}
	giveUp(e?: Error): void {
		this.#close?.(e)
	}
}

describe('parseClusterEvent', () => {
	const NODE = 'd2fd7ecc-3d86-4b56-aa7b-2ce9ad210748'

	it('reads a node state change, with the name from its properties', () => {
		expect(
			parseClusterEvent({
				topic: `gv.cluster.nodestate.${NODE}.changed`,
				content: JSON.stringify({
					id: NODE,
					nodeState: {
						online: true,
						totalWorkloadCount: 5,
						runningWorkloadCount: 4,
						nodeProperties: { nodeId: NODE, nodeName: 'aws-project-gvampp-mesh' },
					},
					action: 'changed',
				}),
			}),
		).toEqual({
			kind: 'node',
			node: { id: NODE, name: 'aws-project-gvampp-mesh', online: true, runningWorkloads: 4, totalWorkloads: 5 },
		})
	})

	it('reads a workload state change, keeping only the fields it carries', () => {
		expect(
			parseClusterEvent({
				topic: 'gv.cluster.workloadstate.w1.changed',
				content: JSON.stringify({
					workloadId: 'w1',
					workloadState: 'Stopping',
					previousState: 'Running',
					workload: { id: 'w1', name: 'signal-gen-mesh-2 - Live Engine' },
				}),
			}),
		).toEqual({ kind: 'workload', workload: { id: 'w1', name: 'signal-gen-mesh-2 - Live Engine', state: 'Stopping' } })
	})

	it('reads a workload update, such as a rename', () => {
		expect(
			parseClusterEvent({
				topic: 'gv.cluster.workload.a1.updated',
				content: JSON.stringify({
					id: 'a1',
					workload: { id: 'a1', name: 'multiview-01', alias: 'MV Wall', parentId: null, state: { state: 'Running' } },
				}),
			}),
		).toEqual({
			kind: 'workload',
			workload: {
				id: 'a1',
				name: 'multiview-01',
				alias: 'MV Wall',
				parentId: null,
				state: 'Running',
				error: null,
				nodeName: null,
			},
		})
	})

	it('reads the desired state, node and error a workload update carries', () => {
		// Trimmed from a stop on a live system: AMPP sets the desired state, then reports each state on the way
		const content = {
			id: 'a1',
			action: 'updated',
			previousState: 'Running',
			workload: {
				id: 'a1',
				name: 'signal-gen-02',
				alias: null,
				parentId: null,
				packageName: 'GV.AMPP.Apps.TestSignalGenerator',
				desiredState: { state: 'Ready', startProperties: null },
				state: { nodeName: 'aws-project-gvampp-mesh', state: 'Stopping', errorReason: null, errorReasonCode: null },
				states: [{ nodeName: 'aws-project-gvampp-mesh', state: 'Stopping', errorReason: null, errorReasonCode: null }],
			},
		}

		expect(parseClusterEvent({ topic: 'gv.cluster.workload.a1.updated', content: JSON.stringify(content) })).toEqual({
			kind: 'workload',
			workload: {
				id: 'a1',
				name: 'signal-gen-02',
				alias: null,
				parentId: null,
				packageName: 'GV.AMPP.Apps.TestSignalGenerator',
				desiredState: 'Ready',
				error: null,
				nodeName: 'aws-project-gvampp-mesh',
				state: 'Stopping',
			},
		})
	})

	it('reads node performance metrics', () => {
		expect(
			parseClusterEvent({
				topic: `gv.cluster.node.${NODE}.performancemetrics`,
				content: JSON.stringify({ nodeId: NODE, numa: [{ totalCPU: 4.98, totalMemory: 24.98 }] }),
			}),
		).toMatchObject({ kind: 'metrics', nodeId: NODE, metrics: { cpu: 5, memory: 25, gpu: null } })
	})

	it.each<[string, PlatformNotification]>([
		['a matrix event', { topic: TOPIC, content: '{}' }],
		['node state without a nodeState', { topic: `gv.cluster.nodestate.${NODE}.changed`, content: '{}' }],
		['invalid JSON', { topic: `gv.cluster.nodestate.${NODE}.changed`, content: '{nope' }],
		['another node topic', { topic: `gv.cluster.node.${NODE}.downloadprogress`, content: '{}' }],
		['a workload update without the workload', { topic: 'gv.cluster.workload.w1.updated', content: '{}' }],
		['a keyframe', { topic: `gv.ampp.keyframe.${NODE}.f1.large`, content: 'image/jpeg' }],
	])('ignores %s', (_name, notification) => {
		expect(parseClusterEvent(notification)).toBeNull()
	})
})

const flush = async () => new Promise((resolve) => setImmediate(resolve))

describe('NotificationListener', () => {
	let hub: FakeHub
	const options = {
		topics: MATRIX_TOPICS,
		onNotifications: vi.fn<NotificationListenerOptions['onNotifications']>(),
		onInterrupted: vi.fn<NotificationListenerOptions['onInterrupted']>(),
		onResumed: vi.fn<NotificationListenerOptions['onResumed']>(),
		onError: vi.fn<NotificationListenerOptions['onError']>(),
	}

	beforeEach(() => {
		hub = new FakeHub()
		vi.clearAllMocks()
	})

	const message = (n: number): PlatformNotification => ({ topic: TOPIC, content: `{"n":${n}}` })

	it('connects, then subscribes to the topics', async () => {
		await new NotificationListener(hub, options).open()

		expect(hub.start).toHaveBeenCalled()
		expect(hub.invoke).toHaveBeenCalledWith('Subscribe', {
			Subscriptions: MATRIX_TOPICS,
			Context: { CorrelationId: expect.any(String) },
		})
	})

	it('disconnects if subscribing fails, without reporting it as a lost hub', async () => {
		hub.invoke.mockRejectedValueOnce(new Error('forbidden'))

		await expect(new NotificationListener(hub, options).open()).rejects.toThrow('forbidden')
		expect(hub.stop).toHaveBeenCalled()
		expect(options.onError).not.toHaveBeenCalled()
	})

	it('treats a subscription the hub refuses in its result as a failure', async () => {
		hub.invoke.mockResolvedValueOnce({ isSuccess: false, isError: true, errorResult: { code: 'Denied' } } as never)

		await expect(new NotificationListener(hub, options).open()).rejects.toThrow(
			'Notification hub refused the subscription: {"code":"Denied"}',
		)
		expect(hub.stop).toHaveBeenCalled()
	})

	it('accepts the success result the hub returns', async () => {
		hub.invoke.mockResolvedValueOnce({ status: 1, isSuccess: true, isError: false, errorResult: null } as never)

		await expect(new NotificationListener(hub, options).open()).resolves.toBeUndefined()
	})

	it('disconnects if closed while connecting', async () => {
		let finishStart: () => void = () => {}
		hub.start.mockImplementationOnce(async () => new Promise<void>((resolve) => (finishStart = resolve)))
		const listener = new NotificationListener(hub, options)

		const opening = listener.open()
		await listener.close()
		finishStart()

		await expect(opening).rejects.toThrow('closed')
		expect(hub.invoke).not.toHaveBeenCalled()
	})

	it('holds notifications until started, then delivers them in order', async () => {
		const listener = new NotificationListener(hub, options)
		await listener.open()

		hub.receive(message(1))
		hub.receive(message(2))
		expect(options.onNotifications).not.toHaveBeenCalled()

		listener.release()
		expect(options.onNotifications).toHaveBeenCalledWith([message(1), message(2)])

		hub.receive(message(3))
		expect(options.onNotifications).toHaveBeenLastCalledWith([message(3)])
	})

	it('holds notifications again until every hold is released', async () => {
		const listener = new NotificationListener(hub, options)
		await listener.open()
		listener.release()

		listener.hold()
		listener.hold()
		hub.receive(message(1))
		listener.release()
		expect(options.onNotifications).not.toHaveBeenCalled()

		listener.release()
		expect(options.onNotifications).toHaveBeenCalledWith([message(1)])
	})

	it('reports an interruption, then resubscribes and resumes after a reconnect', async () => {
		const listener = new NotificationListener(hub, options)
		await listener.open()
		listener.release()

		hub.dropAndRetry()
		expect(options.onInterrupted).toHaveBeenCalledWith(expect.any(Error))

		hub.reconnect()
		await flush()
		expect(hub.invoke).toHaveBeenCalledTimes(2)
		expect(options.onResumed).toHaveBeenCalled()
	})

	it('reports an error if resubscribing fails', async () => {
		const listener = new NotificationListener(hub, options)
		await listener.open()
		hub.invoke.mockRejectedValueOnce(new Error('forbidden'))

		hub.reconnect()
		await flush()

		expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'forbidden' }))
		expect(options.onResumed).not.toHaveBeenCalled()
	})

	it('reports an error when the hub gives up reconnecting', async () => {
		await new NotificationListener(hub, options).open()

		hub.giveUp()

		expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Notification hub closed' }))
	})

	it('goes quiet once closed', async () => {
		const listener = new NotificationListener(hub, options)
		await listener.open()
		hub.receive(message(1))

		await listener.close()
		listener.release()
		hub.receive(message(2))
		hub.dropAndRetry()
		hub.reconnect()
		hub.giveUp(new Error('late'))
		await flush()

		expect(hub.stop).toHaveBeenCalled()
		expect(options.onNotifications).not.toHaveBeenCalled()
		expect(options.onInterrupted).not.toHaveBeenCalled()
		expect(options.onResumed).not.toHaveBeenCalled()
		expect(options.onError).not.toHaveBeenCalled()
	})

	it('survives the hub failing to stop', async () => {
		hub.stop.mockRejectedValueOnce(new Error('already stopped'))
		const listener = new NotificationListener(hub, options)
		await listener.open()

		await expect(listener.close()).resolves.toBeUndefined()
	})
})
