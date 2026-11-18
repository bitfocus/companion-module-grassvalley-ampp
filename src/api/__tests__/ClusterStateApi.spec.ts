import { describe, expect, it, vi } from 'vitest'
import type { AmppClient, QueryParams } from '../AmppClient.js'
import { ClusterStateApi, toNodeMetrics } from '../ClusterStateApi.js'

type GetFn = (path: string, query: QueryParams | null) => Promise<unknown>

function makeApi(get: GetFn) {
	return new ClusterStateApi({ get } as unknown as AmppClient, new AbortController().signal)
}

describe('ClusterStateApi', () => {
	it('lists nodes with their online state and workload counts', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({
			nodes: [
				{
					nodeId: 'n1',
					nodeName: 'aws-project-gvampp-mesh',
					nodeState: { online: true, runningWorkloadCount: 5, totalWorkloadCount: 6 },
				},
				{ nodeState: { online: false, nodeProperties: { nodeId: 'n2' } } },
				{ nodeName: 'no id' },
				null,
			],
		})

		await expect(makeApi(get).listNodes()).resolves.toEqual([
			{ id: 'n1', name: 'aws-project-gvampp-mesh', online: true, runningWorkloads: 5, totalWorkloads: 6 },
			{ id: 'n2', name: 'n2', online: false, runningWorkloads: null, totalWorkloads: null },
		])
		expect(get).toHaveBeenCalledWith('/cluster/state/api/v1/nodes', null, expect.any(AbortSignal))
	})

	it('lists workloads with their state, desired state, node and any error', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({
			workloads: [
				{
					workload: {
						id: 'w1',
						name: 'signal-gen-01 - Live Engine',
						alias: null,
						parentId: 'a1',
						packageName: 'GV.AMPP.Engines.TSG',
						desiredState: { state: 'Running' },
						state: { state: 'Running', nodeName: 'mesh-1', errorReason: null, errorReasonCode: null },
						states: [{ state: 'Running', nodeName: 'mesh-1', errorReason: null, errorReasonCode: null }],
					},
				},
				{
					// As AMPP reports an app no node could run
					workload: {
						id: 'a1',
						name: 'signal-gen-01',
						alias: 'Bars',
						parentId: null,
						packageName: 'GV.AMPP.Apps.TestSignalGenerator',
						desiredState: { state: 'Running' },
						state: null,
						states: [{ state: null, nodeName: null, errorReason: null, errorReasonCode: 'Unplaced' }],
					},
				},
				{ workload: null },
				null,
			],
		})

		await expect(makeApi(get).listWorkloads()).resolves.toEqual([
			{
				id: 'w1',
				name: 'signal-gen-01 - Live Engine',
				alias: null,
				parentId: 'a1',
				state: 'Running',
				desiredState: 'Running',
				error: null,
				nodeName: 'mesh-1',
				packageName: 'GV.AMPP.Engines.TSG',
			},
			{
				id: 'a1',
				name: 'signal-gen-01',
				alias: 'Bars',
				parentId: null,
				state: null,
				desiredState: 'Running',
				error: 'Unplaced',
				nodeName: null,
				packageName: 'GV.AMPP.Apps.TestSignalGenerator',
			},
		])
		expect(get).toHaveBeenCalledWith('/cluster/state/api/v1/workloads', null, expect.any(AbortSignal))
	})

	it('treats null lists as empty', async () => {
		const get = vi.fn<GetFn>().mockResolvedValue({ nodes: null, workloads: null })

		await expect(makeApi(get).listNodes()).resolves.toEqual([])
		await expect(makeApi(get).listWorkloads()).resolves.toEqual([])
	})
})

describe('toNodeMetrics', () => {
	it('averages NUMA nodes, takes the first GPU and drive, and rounds percentages', () => {
		expect(
			toNodeMetrics({
				numa: [
					{ totalCPU: 4.81, totalMemory: 25.01 },
					{ totalCPU: 10.2, totalMemory: 30 },
				],
				gpu: [
					{ gpuUsage: 22.5, videoEncoderUsage: 15, videoDecoderUsage: 0, memoryUsagePercentage: 8.85 },
					{ gpuUsage: 99 },
				],
				drive: [{ totalSpace: 50884108288, availableFreeSpace: 13104164864 }],
				ntp: { offset: 7.783999999999999e-6 },
			}),
		).toEqual({
			cpu: 7.5,
			memory: 27.5,
			gpu: 22.5,
			gpuEncoder: 15,
			gpuDecoder: 0,
			gpuMemory: 8.9,
			diskFree: 25.8,
			ntpOffset: 7.8,
		})
	})

	it('gives null for whatever the node does not report', () => {
		expect(toNodeMetrics({ numa: [], gpu: null, drive: [{ totalSpace: 0, availableFreeSpace: 0 }] })).toEqual({
			cpu: null,
			memory: null,
			gpu: null,
			gpuEncoder: null,
			gpuDecoder: null,
			gpuMemory: null,
			diskFree: null,
			ntpOffset: null,
		})
	})
})
