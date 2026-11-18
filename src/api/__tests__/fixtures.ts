import type { AmppConsumer, AmppEndpoint, AmppNode, AmppProducer, AmppWorkload } from '../types.js'

const ENDPOINT: Omit<AmppEndpoint, 'id' | 'name'> = {
	alias: null,
	enabled: true,
	tallyState: null,
	workloadId: null,
	packageName: null,
}

export function producer(fields: Pick<AmppProducer, 'id' | 'name'> & Partial<AmppProducer>): AmppProducer {
	return { ...ENDPOINT, format: null, ...fields }
}

export function consumer(fields: Pick<AmppConsumer, 'id' | 'name'> & Partial<AmppConsumer>): AmppConsumer {
	return { ...ENDPOINT, locked: false, routedProducerId: null, pendingProducerId: null, ...fields }
}

export function node(fields: Pick<AmppNode, 'id' | 'name'> & Partial<AmppNode>): AmppNode {
	return { online: true, runningWorkloads: 1, totalWorkloads: 1, ...fields }
}

export function workload(fields: Pick<AmppWorkload, 'id' | 'name'> & Partial<AmppWorkload>): AmppWorkload {
	return {
		alias: null,
		parentId: null,
		state: null,
		desiredState: null,
		error: null,
		nodeName: null,
		packageName: null,
		...fields,
	}
}
