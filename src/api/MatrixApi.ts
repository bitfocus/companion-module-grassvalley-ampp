import type { AmppClient, QueryParams } from './AmppClient.js'
import type {
	AmppConsumer,
	AmppEndpoint,
	AmppFabric,
	AmppProducer,
	ConsumersResponse,
	FabricsResponse,
	PagedResponse,
	ProducersResponse,
	RawConsumer,
	RawFlow,
	RawFlowDescriptor,
	RawProducer,
	RawRouteStatus,
	RouteRequest,
	RouteRequestResponse,
	RouteStatus,
} from './types.js'

const PAGE_SIZE = 500
// Guards against a server that keeps returning hasMore with the same token
const MAX_PAGES = 100

function toRouteStatus(raw: RawRouteStatus): RouteStatus {
	return { routeStatus: raw.routeStatus, routeErrorMessage: raw.routeErrorMessage || null }
}

/** Drops entries without an id (they can't be routed) and falls back to the id when there is no name */
export function withIdAndName<T extends { id?: string | null; name?: string | null }>(
	items: readonly (T | null)[],
): Array<T & { id: string; name: string }> {
	return items.flatMap((item) => (item?.id ? [{ ...item, id: item.id, name: item.name || item.id }] : []))
}

function toNumber(value: number | string | null | undefined): number | null {
	const n = typeof value === 'string' ? Number(value) : value
	return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function parseRate(rate: RawFlowDescriptor['rate']): number | null {
	let value: unknown = rate
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return null
		}
	}
	const { num, den } = (value ?? {}) as { num?: unknown; den?: unknown }
	return typeof num === 'number' && typeof den === 'number' && num > 0 && den > 0 ? num / den : null
}

/** The first picture flow's format, e.g. `1080p59.94` or `1080i59.94`, or null if it isn't described */
export function videoFormat(flows: ReadonlyArray<RawFlow | null> | null | undefined): string | null {
	for (const flow of flows ?? []) {
		if (flow?.dataType !== 'Pic' || !flow.descriptor) continue
		const height = toNumber(flow.descriptor.height)
		const rate = parseRate(flow.descriptor.rate)
		if (!height || !rate) continue
		const progressive = flow.descriptor.progressive !== false && flow.descriptor.progressive !== 'False'
		// The rate is per frame; interlaced formats are conventionally named by their field rate
		const displayRate = Math.round((progressive ? rate : rate * 2) * 100) / 100
		return `${height}${progressive ? 'p' : 'i'}${displayRate}`
	}
	return null
}

const NIL_ID = '00000000-0000-0000-0000-000000000000'

/** Virtual producers have no workload of their own, and report the nil id for it */
function optionalId(id: string | null | undefined): string | null {
	return id && id !== NIL_ID ? id : null
}

function toEndpoint(endpoint: RawProducer & { id: string; name: string }): AmppEndpoint {
	return {
		id: endpoint.id,
		name: endpoint.name,
		alias: endpoint.alias || null,
		enabled: endpoint.enabled !== false,
		tallyState: endpoint.tallyState || null,
		workloadId: optionalId(endpoint.workloadId),
		packageName: endpoint.properties?.packageName || null,
	}
}

/** Maps a producer from the list endpoint or a `producer.updated` notification */
export function toProducer(producer: RawProducer & { id: string; name: string }): AmppProducer {
	return { ...toEndpoint(producer), format: videoFormat(producer.stream?.flows) }
}

/** Maps a consumer from the list endpoint or a `consumer.updated` notification, defaulting missing fields */
export function toConsumer(consumer: RawConsumer & { id: string; name: string }): AmppConsumer {
	return {
		...toEndpoint(consumer),
		locked: !!consumer.locked,
		routedProducerId: consumer.routedProducerId || null,
		pendingProducerId: consumer.pendingProducerId || null,
	}
}

export class MatrixApi {
	readonly #client: AmppClient
	readonly #signal: AbortSignal

	/** Requests are cancelled when `signal` is aborted */
	constructor(client: AmppClient, signal: AbortSignal) {
		this.#client = client
		this.#signal = signal
	}

	async #getAllPages<TResponse extends PagedResponse, TItem>(
		path: string,
		query: QueryParams,
		getItems: (res: TResponse) => TItem[] | null,
	): Promise<TItem[]> {
		const items: TItem[] = []
		let pageToken: string | null = null

		for (let page = 0; page < MAX_PAGES; page++) {
			const res: TResponse = await this.#client.get<TResponse>(
				path,
				{ ...query, pageSize: String(PAGE_SIZE), ...(pageToken ? { pageToken } : {}) },
				this.#signal,
			)
			items.push(...(getItems(res) ?? []))

			if (!res.hasMore || !res.nextPageToken || res.nextPageToken === pageToken) return items
			pageToken = res.nextPageToken
		}

		throw new Error(`${path} returned more than ${MAX_PAGES} pages`)
	}

	async listFabrics(): Promise<AmppFabric[]> {
		const res = await this.#client.get<FabricsResponse>('/cluster/fabric/api/v1/fabrics', null, this.#signal)
		return withIdAndName((res.fabrics ?? []).map((f) => f.fabric)).map((f) => ({ id: f.id, name: f.name }))
	}

	async listProducers(fabricId: string): Promise<AmppProducer[]> {
		const producers = await this.#getAllPages<ProducersResponse, { producer: RawProducer | null }>(
			'/cluster/matrix/api/v2/producers',
			{ fabricId, type: 'Fabric' },
			(res) => res.producers,
		)
		return withIdAndName(producers.map((p) => p.producer)).map(toProducer)
	}

	async listConsumers(fabricId: string): Promise<AmppConsumer[]> {
		const consumers = await this.#getAllPages<ConsumersResponse, { consumer: RawConsumer | null }>(
			'/cluster/matrix/api/v1/consumers',
			{ fabricId, type: 'Fabric', includeRoutedProducerIds: 'true' },
			(res) => res.consumers,
		)
		return withIdAndName(consumers.map((c) => c.consumer)).map(toConsumer)
	}

	/** Returns the request id to check with getRouteStatus, and the status it was accepted with */
	async requestRoute(sourceId: string, destinationId: string): Promise<RouteRequest> {
		return this.#routingRequest('requestroute', { sourceId, destinationId }, 'Route request')
	}

	/** Takes the destination's source away; followed with getRouteStatus like a route request */
	async clearRoute(destinationId: string): Promise<RouteRequest> {
		return this.#routingRequest('clearroute', { destinationId }, 'Clear route request')
	}

	async #routingRequest(action: string, body: unknown, what: string): Promise<RouteRequest> {
		const res = await this.#client.post<RouteRequestResponse>(
			`/cluster/matrix/api/v1/routing/${action}`,
			body,
			this.#signal,
		)
		if (!res?.requestId) throw new Error(`${what} returned no request id`)
		return { requestId: res.requestId, status: res.status?.routeStatus ? toRouteStatus(res.status) : null }
	}

	async setLocked(destinationId: string, locked: boolean): Promise<void> {
		const action = locked ? 'lock' : 'unlock'
		await this.#client.post(
			`/cluster/matrix/api/v1/routing/destination/${encodeURIComponent(destinationId)}/${action}`,
			undefined,
			this.#signal,
		)
	}

	/** Sets a source's (producer) or destination's (consumer) alias; the API only accepts the alias here */
	async setAlias(kind: 'producer' | 'consumer', id: string, alias: string): Promise<void> {
		// Any version, rather than the eTag of one we've read
		await this.#client.put(
			`/cluster/matrix/api/v1/${kind}/${encodeURIComponent(id)}`,
			{ alias },
			{ 'If-Match': '"*"' },
			this.#signal,
		)
	}

	async getRouteStatus(requestId: string): Promise<RouteStatus> {
		const res = await this.#client.get<RawRouteStatus>(
			`/cluster/matrix/api/v1/routing/routestatus/${encodeURIComponent(requestId)}`,
			null,
			this.#signal,
		)
		return toRouteStatus(res)
	}
}
