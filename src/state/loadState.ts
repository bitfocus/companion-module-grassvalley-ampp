import { classifyFailure } from '../api/AmppClient.js'
import type { Apis } from '../api/Connection.js'
import type { AmppNode, AmppWorkload } from '../api/types.js'
import { errorMessage } from '../util/errorMessage.js'
import type { FabricEndpoints, RouterState } from './RouterState.js'

export interface LoadedState {
	lists: FabricEndpoints[]
	/** Null when the node and app state couldn't be read */
	cluster: { nodes: AmppNode[]; workloads: AmppWorkload[] } | null
}

/** Load the sources and destinations of every fabric, and the nodes and workloads behind them */
export async function loadState({ matrix, cluster }: Apis, warn: (message: string) => void): Promise<LoadedState> {
	const loadLists = async () => {
		// Listing fabrics needs the cluster scope, so this also checks the key can route
		const fabrics = await matrix.listFabrics()
		return Promise.all(
			fabrics.map(async (fabric) => {
				const [producers, consumers] = await Promise.all([
					matrix.listProducers(fabric.id),
					matrix.listConsumers(fabric.id),
				])
				return { fabric, producers, consumers }
			}),
		)
	}

	/**
	 * Node and app state only adds feedbacks and variables, so a key that can't read it (or a failure) still routes;
	 * credential and network failures are thrown, as the matrix lists would fail too
	 */
	const loadClusterState = async () => {
		try {
			const [nodes, workloads] = await Promise.all([cluster.listNodes(), cluster.listWorkloads()])
			return { nodes, workloads }
		} catch (e) {
			const kind = classifyFailure(e)
			if (kind === 'auth' || kind === 'connection') throw e
			warn(`Could not load node and app state: ${errorMessage(e)}`)
			return null
		}
	}

	const [lists, clusterState] = await Promise.all([loadLists(), loadClusterState()])
	return { lists, cluster: clusterState }
}

/** Replace the state with what was loaded; the state records what changed */
export function applyLoadedState(state: RouterState, loaded: LoadedState): void {
	// Workloads first, as endpoint labels come from their apps
	if (loaded.cluster) {
		state.setNodes(loaded.cluster.nodes)
		state.setWorkloads(loaded.cluster.workloads)
	}
	state.setEndpoints(loaded.lists)
}
