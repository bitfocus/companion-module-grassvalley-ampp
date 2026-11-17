import { describe, expect, it } from 'vitest'
import { RouterState } from '../state/RouterState.js'
import {
	destinationVariablePrefix,
	destinationVariableValues,
	nodeVariableValues,
	sourceVariableValues,
} from '../variables.js'
import { consumer, producer, workload } from '../api/__tests__/fixtures.js'

const FABRIC = { id: 'f1', name: 'Studio' }

const out = (id: string, routedProducerId: string | null) => consumer({ id, name: `Out ${id}`, routedProducerId })

describe('destinationVariablePrefix', () => {
	it('keeps GUIDs as they are', () => {
		expect(destinationVariablePrefix('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe(
			'dest_0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
		)
	})

	it('replaces characters variable ids cannot use', () => {
		expect(destinationVariablePrefix('{a.b c}')).toBe('dest__a_b_c_')
	})
})

describe('destinationVariableValues', () => {
	it('gives each destination its name and routed source label', () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [producer({ id: 'p1', name: 'Cam 1', alias: 'Wide' })],
				consumers: [out('c1', 'p1'), out('c2', 'unknown'), out('c3', null)],
			},
		])

		expect(destinationVariableValues(state, state.destinations)).toMatchObject({
			dest_c1_name: 'Out c1',
			dest_c1_source: 'Wide',
			dest_c2_name: 'Out c2',
			dest_c2_source: 'unknown',
			dest_c3_name: 'Out c3',
			dest_c3_source: '',
		})
	})

	it("gives the router the routed source's id, the lock, the fabric and the user label", () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [producer({ id: 'p1', name: 'Cam 1' })],
				consumers: [
					consumer({ id: 'c1', name: 'MV', alias: 'Wall', routedProducerId: 'p1', locked: true }),
					consumer({ id: 'c2', name: 'Rec', alias: 'Rec' }),
				],
			},
		])

		expect(destinationVariableValues(state, state.destinations)).toMatchObject({
			dest_c1_source_id: 'p1',
			dest_c1_locked: true,
			dest_c1_fabric: 'f1',
			dest_c1_label: 'Wall',
			dest_c2_source_id: '',
			dest_c2_locked: false,
			// An alias that is just the name isn't a user label
			dest_c2_label: '',
		})
	})

	it('only covers the destinations given', () => {
		const state = new RouterState()
		state.setEndpoints([{ fabric: FABRIC, producers: [], consumers: [out('c1', null), out('c2', null)] }])

		const keys = Object.keys(destinationVariableValues(state, [state.destinations[1]]))
		expect(keys.every((key) => key.startsWith('dest_c2_'))).toBe(true)
	})

	it("gives the destination's package and app state", () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [],
				consumers: [
					consumer({ id: 'c1', name: 'MV', workloadId: 'w1', packageName: 'GV.Mocha.MultiViewer' }),
					consumer({ id: 'c2', name: 'Lost', workloadId: 'gone' }),
				],
			},
		])
		state.setWorkloads([workload({ id: 'w1', name: 'MV - engine', state: 'Running' })])

		expect(destinationVariableValues(state, state.destinations)).toMatchObject({
			dest_c1_app: 'GV.Mocha.MultiViewer',
			dest_c1_state: 'Running',
			dest_c2_app: '',
			dest_c2_state: '',
		})
	})
})

describe('sourceVariableValues', () => {
	it('gives each source its label, format and app details', () => {
		const state = new RouterState()
		state.setEndpoints([
			{
				fabric: FABRIC,
				producers: [
					producer({ id: 'p1', name: 'Cam 1', format: '1080p59.94', workloadId: 'w1' }),
					producer({ id: 'p2', name: 'Cam 2' }),
				],
				consumers: [],
			},
		])
		state.setWorkloads([
			workload({ id: 'a1', name: 'Cam 1' }),
			workload({ id: 'w1', name: 'Cam 1 - engine', parentId: 'a1', state: 'Stopped' }),
		])

		expect(sourceVariableValues(state, state.sources)).toEqual({
			src_p1_name: 'Cam 1',
			src_p1_app: '',
			src_p1_state: 'Stopped',
			src_p1_label: '',
			src_p1_fabric: 'f1',
			src_p1_format: '1080p59.94',
			src_p2_name: 'Cam 2',
			src_p2_app: '',
			src_p2_state: '',
			src_p2_label: '',
			src_p2_fabric: 'f1',
			src_p2_format: '',
		})
	})
})

describe('nodeVariableValues', () => {
	it('gives the state and metrics, with null for metrics not reported yet', () => {
		const state = new RouterState()
		state.setNodes([
			{ id: 'n1', name: 'Node A', online: true, runningWorkloads: 5, totalWorkloads: 5 },
			{ id: 'n2', name: 'Node B', online: false, runningWorkloads: null, totalWorkloads: null },
		])
		state.setNodeMetrics('n1', {
			cpu: 4.8,
			memory: 25,
			gpu: 22.5,
			gpuEncoder: 15,
			gpuDecoder: 0,
			gpuMemory: 8.9,
			diskFree: 25.8,
			ntpOffset: 1.3,
		})

		expect(nodeVariableValues(state.nodes)).toEqual({
			node_n1_name: 'Node A',
			node_n1_online: true,
			node_n1_running_workloads: 5,
			node_n1_total_workloads: 5,
			node_n1_cpu: 4.8,
			node_n1_memory: 25,
			node_n1_gpu: 22.5,
			node_n1_gpu_encoder: 15,
			node_n1_gpu_decoder: 0,
			node_n1_gpu_memory: 8.9,
			node_n1_disk_free: 25.8,
			node_n1_ntp_offset: 1.3,
			node_n2_name: 'Node B',
			node_n2_online: false,
			node_n2_running_workloads: null,
			node_n2_total_workloads: null,
			node_n2_cpu: null,
			node_n2_memory: null,
			node_n2_gpu: null,
			node_n2_gpu_encoder: null,
			node_n2_gpu_decoder: null,
			node_n2_gpu_memory: null,
			node_n2_disk_free: null,
			node_n2_ntp_offset: null,
		})
	})
})
