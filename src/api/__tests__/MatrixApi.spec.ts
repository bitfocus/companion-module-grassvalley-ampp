import { describe, expect, it, vi } from 'vitest'
import type { AmppClient, QueryParams } from '../AmppClient.js'
import { MatrixApi, toProducer, videoFormat } from '../MatrixApi.js'
import { consumer, producer } from './fixtures.js'

const SIGNAL = new AbortController().signal

type GetFn = (path: string, query: QueryParams | null) => Promise<unknown>

function makeApi(
	get: GetFn,
	post: (path: string, body: unknown) => Promise<unknown> = vi.fn(),
	put: (path: string, body: unknown, headers: Record<string, string> | null) => Promise<unknown> = vi.fn(),
) {
	const client = { get, post, put } as unknown as AmppClient
	return new MatrixApi(client, SIGNAL)
}

describe('MatrixApi', () => {
	it('follows page tokens until hasMore is false', async () => {
		const get = vi
			.fn<GetFn>()
			.mockResolvedValueOnce({
				producers: [{ producer: { id: 'p1', name: 'One', alias: '' } }],
				hasMore: true,
				nextPageToken: 't1',
			})
			.mockResolvedValueOnce({
				producers: [{ producer: { id: 'p2', name: 'Two', alias: 'Second' } }],
				hasMore: false,
				nextPageToken: null,
			})

		const producers = await makeApi(get).listProducers('fab')

		expect(producers).toEqual([
			producer({ id: 'p1', name: 'One' }),
			producer({ id: 'p2', name: 'Two', alias: 'Second' }),
		])
		expect(get.mock.calls[0]).toEqual([
			'/cluster/matrix/api/v2/producers',
			{ fabricId: 'fab', type: 'Fabric', pageSize: '500' },
			SIGNAL,
		])
		expect(get.mock.calls[1][1]).toMatchObject({ pageToken: 't1' })
	})

	it('stops if the server repeats the same page token', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({ consumers: [], hasMore: true, nextPageToken: 'same' })

		await makeApi(get).listConsumers('fab')

		expect(get).toHaveBeenCalledTimes(2)
	})

	it('requests routed source ids for consumers and maps them', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({
			consumers: [
				{
					consumer: {
						id: 'c1',
						name: 'MV',
						alias: null,
						locked: true,
						enabled: true,
						tallyState: 'High',
						routedProducerId: 'p1',
						pendingProducerId: null,
					},
				},
			],
			hasMore: false,
		})

		const consumers = await makeApi(get).listConsumers('fab')

		expect(get.mock.calls[0][1]).toMatchObject({ includeRoutedProducerIds: 'true' })
		expect(consumers[0]).toMatchObject({ routedProducerId: 'p1', locked: true, tallyState: 'High' })
	})

	it('treats a null list as empty', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({ producers: null })

		await expect(makeApi(get).listProducers('fab')).resolves.toEqual([])
	})

	it('drops entries without an id and falls back to the id for a missing name', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({
			producers: [
				{ producer: { id: 'p1', name: null, alias: null } },
				{ producer: { id: null, name: 'Ghost' } },
				{ producer: null },
			],
		})

		await expect(makeApi(get).listProducers('fab')).resolves.toEqual([producer({ id: 'p1', name: 'p1' })])
	})

	it('defaults missing consumer fields', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({ consumers: [{ consumer: { id: 'c1' } }] })

		await expect(makeApi(get).listConsumers('fab')).resolves.toEqual([consumer({ id: 'c1', name: 'c1' })])
	})

	it('handles fabrics with a null list or missing names', async () => {
		const get = vi
			.fn<GetFn>()
			.mockResolvedValueOnce({ fabrics: null })
			.mockResolvedValueOnce({ fabrics: [{ fabric: { id: 'f1', name: null } }, { fabric: null }] })
		const api = makeApi(get)

		await expect(api.listFabrics()).resolves.toEqual([])
		await expect(api.listFabrics()).resolves.toEqual([{ id: 'f1', name: 'f1' }])
	})

	it('clears a route, returning the request to follow', async () => {
		const post = vi.fn().mockResolvedValue({ requestId: 'r2', status: { routeStatus: 'Clearing' } })

		await expect(makeApi(vi.fn<GetFn>(), post).clearRoute('d')).resolves.toEqual({
			requestId: 'r2',
			status: { routeStatus: 'Clearing', routeErrorMessage: null },
		})
		expect(post).toHaveBeenCalledWith('/cluster/matrix/api/v1/routing/clearroute', { destinationId: 'd' }, SIGNAL)
	})

	it('locks and unlocks a destination', async () => {
		const post = vi.fn().mockResolvedValue(undefined)
		const api = makeApi(vi.fn<GetFn>(), post)

		await api.setLocked('d1', true)
		await api.setLocked('d1', false)
		expect(post.mock.calls.map((c) => c[0])).toEqual([
			'/cluster/matrix/api/v1/routing/destination/d1/lock',
			'/cluster/matrix/api/v1/routing/destination/d1/unlock',
		])
	})

	it('puts only the alias, for any version', async () => {
		const put = vi.fn().mockResolvedValue(undefined)

		await makeApi(vi.fn<GetFn>(), vi.fn(), put).setAlias('consumer', 'c1', 'MV 1')
		expect(put).toHaveBeenCalledWith(
			'/cluster/matrix/api/v1/consumer/c1',
			{ alias: 'MV 1' },
			{ 'If-Match': '"*"' },
			SIGNAL,
		)
	})

	it('returns the request id and initial status from a route request', async () => {
		const post = vi.fn().mockResolvedValue({ requestId: 'r1', status: { routeStatus: 'Pending' } })

		await expect(makeApi(vi.fn<GetFn>(), post).requestRoute('s', 'd')).resolves.toEqual({
			requestId: 'r1',
			status: { routeStatus: 'Pending', routeErrorMessage: null },
		})
		expect(post).toHaveBeenCalledWith(
			'/cluster/matrix/api/v1/routing/requestroute',
			{ sourceId: 's', destinationId: 'd' },
			SIGNAL,
		)
	})

	it('returns a null initial status when the route response has none', async () => {
		const post = vi.fn().mockResolvedValue({ requestId: 'r1', status: null })

		await expect(makeApi(vi.fn<GetFn>(), post).requestRoute('s', 'd')).resolves.toEqual({
			requestId: 'r1',
			status: null,
		})
	})

	it('reads the flat route status shape', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({ routeStatus: 'Routed', routeErrorMessage: '' })

		await expect(makeApi(get).getRouteStatus('r1')).resolves.toEqual({
			routeStatus: 'Routed',
			routeErrorMessage: null,
		})
	})
})

describe('toProducer', () => {
	it('maps tally, enabled, workload, package and format', () => {
		expect(
			toProducer({
				id: 'p1',
				name: 'signal-gen-01',
				alias: 'signal-gen-01',
				enabled: false,
				tallyState: 'High',
				workloadId: 'w1',
				properties: { packageName: 'GV.Mocha.ClipPlayer' },
				stream: {
					flows: [
						{
							dataType: 'Pic',
							descriptor: { height: 1080, progressive: true, rate: { num: 60000, den: 1001 } },
						},
					],
				},
			}),
		).toEqual({
			id: 'p1',
			name: 'signal-gen-01',
			alias: 'signal-gen-01',
			enabled: false,
			tallyState: 'High',
			workloadId: 'w1',
			packageName: 'GV.Mocha.ClipPlayer',
			format: '1080p59.94',
		})
	})

	it("treats a virtual producer's nil workload id as none", () => {
		const nil = '00000000-0000-0000-0000-000000000000'
		expect(toProducer({ id: 'v1', name: 'virtual', workloadId: nil })).toMatchObject({ workloadId: null })
	})
})

describe('videoFormat', () => {
	const pic = (descriptor: object) => ({ dataType: 'Pic', descriptor })

	it('names progressive formats by frame rate, dropping trailing zeros', () => {
		expect(videoFormat([pic({ height: 1080, progressive: true, rate: { num: 60000, den: 1001 } })])).toBe('1080p59.94')
		expect(videoFormat([pic({ height: 2160, progressive: true, rate: { num: 50, den: 1 } })])).toBe('2160p50')
		expect(videoFormat([pic({ height: 1080, progressive: true, rate: { num: 24000, den: 1001 } })])).toBe('1080p23.98')
	})

	it('names interlaced formats by field rate', () => {
		expect(videoFormat([pic({ height: 1080, progressive: false, rate: { num: 30000, den: 1001 } })])).toBe('1080i59.94')
		expect(videoFormat([pic({ height: 1080, progressive: false, rate: { num: 25, den: 1 } })])).toBe('1080i50')
	})

	it('reads the string-encoded descriptor of a virtual producer', () => {
		expect(videoFormat([pic({ height: '1080', progressive: 'True', rate: '{"den":1001,"num":60000}' })])).toBe(
			'1080p59.94',
		)
		expect(videoFormat([pic({ height: '1080', progressive: 'False', rate: '{"den":1,"num":25}' })])).toBe('1080i50')
	})

	it('uses the first described picture flow', () => {
		expect(
			videoFormat([
				{ dataType: 'Snd', descriptor: { channelCount: 16 } as object },
				pic({}),
				pic({ height: 720, progressive: true, rate: { num: 50, den: 1 } }),
			]),
		).toBe('720p50')
	})

	it('is null without a described picture flow', () => {
		expect(videoFormat(null)).toBeNull()
		expect(videoFormat([{ dataType: 'Anc', descriptor: { rate: { num: 25, den: 1 } } }])).toBeNull()
		expect(videoFormat([pic({ height: 1080, rate: '{nope' })])).toBeNull()
		expect(videoFormat([pic({ height: 1080, rate: { num: 25, den: 0 } })])).toBeNull()
	})
})
