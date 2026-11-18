import { describe, expect, it, vi } from 'vitest'
import { consumer, node, producer, workload } from '../../api/__tests__/fixtures.js'
import { AmppConnectionError, AmppHttpError } from '../../api/AmppClient.js'
import type { Apis } from '../../api/Connection.js'
import type { AmppNode } from '../../api/types.js'
import { applyLoadedState, loadState, type LoadedState } from '../loadState.js'
import { RouterState } from '../RouterState.js'

const NODE = node({ id: 'n1', name: 'Node A' })

function makeApis(listNodes: () => Promise<AmppNode[]> = async () => [NODE]): Apis {
	return {
		matrix: {
			listFabrics: async () => [
				{ id: 'f1', name: 'Studio' },
				{ id: 'f2', name: 'Gallery' },
			],
			listProducers: async (fabricId: string) => [producer({ id: `${fabricId}-p`, name: 'Cam' })],
			listConsumers: async (fabricId: string) => [consumer({ id: `${fabricId}-c`, name: 'Monitor' })],
		},
		cluster: { listNodes, listWorkloads: async () => [workload({ id: 'w1', name: 'engine' })] },
	} as unknown as Apis
}

describe('loadState', () => {
	it("loads every fabric's endpoints, and the nodes and workloads", async () => {
		const loaded = await loadState(makeApis(), vi.fn())

		expect(loaded.lists.map((l) => [l.fabric.id, l.producers[0]?.id, l.consumers[0]?.id])).toEqual([
			['f1', 'f1-p', 'f1-c'],
			['f2', 'f2-p', 'f2-c'],
		])
		expect(loaded.cluster?.nodes).toEqual([NODE])
		expect(loaded.cluster?.workloads.map((w) => w.id)).toEqual(['w1'])
	})

	it("still loads the lists when the key can't read node state", async () => {
		const warn = vi.fn()
		const loaded = await loadState(
			makeApis(async () => Promise.reject(new AmppHttpError(403, null, 'Forbidden'))),
			warn,
		)

		expect(loaded.lists).toHaveLength(2)
		expect(loaded.cluster).toBeNull()
		expect(warn).toHaveBeenCalledWith('Could not load node and app state: Forbidden')
	})

	it('throws when the platform is unreachable', async () => {
		await expect(
			loadState(
				makeApis(async () => Promise.reject(new AmppConnectionError('ECONNREFUSED'))),
				vi.fn(),
			),
		).rejects.toThrow('ECONNREFUSED')
	})
})

describe('applyLoadedState', () => {
	const loaded = (cluster: LoadedState['cluster']): LoadedState => ({
		lists: [{ fabric: { id: 'f1', name: 'Studio' }, producers: [producer({ id: 'p1', name: 'Cam' })], consumers: [] }],
		cluster,
	})

	it('records a load, and whether the definitions changed', () => {
		const state = new RouterState()

		applyLoadedState(state, loaded({ nodes: [NODE], workloads: [] }))
		expect(state.takeChanges()).toMatchObject({ all: true, lists: true })
		applyLoadedState(state, loaded({ nodes: [NODE], workloads: [] }))
		expect(state.takeChanges()).toMatchObject({ all: true, lists: false })
	})

	it('updates the endpoints and nodes already loaded in place', () => {
		const state = new RouterState()
		applyLoadedState(state, loaded({ nodes: [NODE], workloads: [] }))
		const source = state.findSource('p1')
		const node = state.findNode('n1')

		applyLoadedState(state, {
			lists: [
				{
					fabric: { id: 'f1', name: 'Studio' },
					producers: [producer({ id: 'p1', name: 'Cam', tallyState: 'High' })],
					consumers: [],
				},
			],
			cluster: { nodes: [{ ...NODE, online: false }], workloads: [] },
		})

		expect(state.findSource('p1')).toBe(source)
		expect(source?.tallyState).toBe('High')
		expect(state.findNode('n1')).toBe(node)
		expect(node?.online).toBe(false)
	})

	it('keeps the nodes it had when node state could not be read', () => {
		const state = new RouterState()
		applyLoadedState(state, loaded({ nodes: [NODE], workloads: [] }))

		applyLoadedState(state, loaded(null))

		expect(state.nodes.map((n) => n.id)).toEqual(['n1'])
	})
})
