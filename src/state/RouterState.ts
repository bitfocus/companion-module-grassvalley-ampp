import type { DropdownChoice } from '@companion-module/base'
import type {
	AmppConsumer,
	AmppEndpoint,
	AmppFabric,
	AmppNode,
	AmppProducer,
	AmppWorkload,
	NodeMetrics,
	WorkloadUpdate,
} from '../api/types.js'

export interface RouterSource extends AmppProducer {
	fabricId: string
	/** Its name as the user knows it, and its fabric's when there are several */
	label: string
	/** Its name as the user knows it, without the fabric */
	shortLabel: string
}

export interface RouterDestination extends AmppConsumer {
	fabricId: string
	/** Its name as the user knows it, and its fabric's when there are several */
	label: string
	/** Its name as the user knows it, without the fabric */
	shortLabel: string
}

export interface RouterNode extends AmppNode {
	/** The latest performance metrics, once the node has sent some */
	metrics: NodeMetrics | null
}

export interface FabricEndpoints {
	fabric: AmppFabric
	producers: AmppProducer[]
	consumers: AmppConsumer[]
}

/** `list` means the set of endpoints or nodes, or a label, changed, so the definitions need regenerating */
export type UpsertResult = 'unchanged' | 'state' | 'list'

/** What changed since the last `takeChanges()`, for publishing to Companion */
export interface StateChanges {
	/** Endpoints or nodes were added, removed or relabelled, so the definitions need regenerating */
	lists: boolean
	/** The lists were (re)loaded or cleared, so every value needs publishing */
	all: boolean
	/** Destinations whose state changed, including the app state behind them */
	destinations: RouterDestination[]
	/** Sources whose state changed, including the app state behind them */
	sources: RouterSource[]
	/** Nodes whose online state or workload counts changed */
	nodes: RouterNode[]
	/** Nodes whose metrics changed */
	nodeMetrics: RouterNode[]
	/** Apps whose state or error changed, including through one of their engines */
	apps: AmppWorkload[]
}

/** An app's name as the user knows it: its alias, if it has one of its own */
export function appName(app: AmppWorkload): string {
	return distinctAlias(app) ?? app.name
}

const ENDPOINT_FIELDS = [
	'name',
	'alias',
	'enabled',
	'tallyState',
	'workloadId',
	'packageName',
] as const satisfies ReadonlyArray<keyof AmppEndpoint>

const CONSUMER_FIELDS = [
	...ENDPOINT_FIELDS,
	'locked',
	'routedProducerId',
	'pendingProducerId',
] as const satisfies ReadonlyArray<keyof AmppConsumer>

const PRODUCER_FIELDS = [...ENDPOINT_FIELDS, 'format'] as const satisfies ReadonlyArray<keyof AmppProducer>

/** The fields an endpoint's label is made from (with its app, found from its workload) */
const LABEL_FIELDS = ['name', 'alias', 'workloadId'] as const satisfies ReadonlyArray<keyof AmppEndpoint>

const METRIC_FIELDS = [
	'cpu',
	'memory',
	'gpu',
	'gpuEncoder',
	'gpuDecoder',
	'gpuMemory',
	'diskFree',
	'ntpOffset',
] as const satisfies ReadonlyArray<keyof NodeMetrics>

/** After an app's name, the rest of an endpoint's name starts with a separator (`multiview-01 - Input 1`) */
const AFTER_APP_NAME = /^[\s\-_.:]/

/** The alias, when it's set to something other than the name */
export function distinctAlias(item: { name: string; alias: string | null }): string | null {
	return item.alias && item.alias !== item.name ? item.alias : null
}

/**
 * An endpoint's name as the user knows it. Its own alias wins, as that's what renaming a source or destination sets.
 * Otherwise it comes from the app it belongs to: the app's alias, else its name, when the endpoint is the app's only
 * source (or only destination), so `clock-01 - Graphic Engine` reads `clock-01`. One of several keeps its own name,
 * with the app's alias in place of the app's name it starts with (`MV Wall - Input 1`).
 */
export function displayName(endpoint: AmppEndpoint, app: AmppWorkload | undefined, onlyOneOnApp: boolean): string {
	const ownAlias = distinctAlias(endpoint)
	if (ownAlias) return ownAlias
	if (!app) return endpoint.name

	const appAlias = distinctAlias(app)
	if (onlyOneOnApp) return appAlias ?? app.name
	if (appAlias && endpoint.name.startsWith(app.name)) {
		const rest = endpoint.name.slice(app.name.length)
		if (rest === '' || AFTER_APP_NAME.test(rest)) return appAlias + rest
	}
	return endpoint.name
}

function byLabel(a: { label: string }, b: { label: string }): number {
	return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
}

/** Endpoints by id, name and alias; for a shared name or alias, the first in the (grouped and sorted) list */
interface EndpointIndex<T extends RouterSource | RouterDestination> {
	byId: Map<string, T>
	byName: Map<string, T>
	byAlias: Map<string, T>
}

function indexEndpoints<T extends RouterSource | RouterDestination>(list: readonly T[]): EndpointIndex<T> {
	const index: EndpointIndex<T> = { byId: new Map(), byName: new Map(), byAlias: new Map() }
	for (const endpoint of list) {
		index.byId.set(endpoint.id, endpoint)
		if (!index.byName.has(endpoint.name)) index.byName.set(endpoint.name, endpoint)
		if (endpoint.alias && !index.byAlias.has(endpoint.alias)) index.byAlias.set(endpoint.alias, endpoint)
	}
	return index
}

/**
 * Find an endpoint by id, then name, then alias. Users can type a name or alias into an expression, so the
 * fallbacks make `Camera 1` work as well as the opaque id the dropdown stores.
 */
function findEndpoint<T extends RouterSource | RouterDestination>(index: EndpointIndex<T>, ref: string): T | undefined {
	const value = ref.trim()
	if (!value) return undefined
	return index.byId.get(value) ?? index.byName.get(value) ?? index.byAlias.get(value)
}

/** The endpoint already known with this id, updated with the latest, or a new one */
function reuse<T extends RouterSource | RouterDestination>(
	known: ReadonlyMap<string, T>,
	item: Omit<T, 'fabricId' | 'label' | 'shortLabel'>,
	fabricId: string,
): T {
	const existing = known.get(item.id)
	return existing
		? Object.assign(existing, item, { fabricId })
		: ({ ...item, fabricId, label: '', shortLabel: '' } as T)
}

export class RouterState {
	fabrics: AmppFabric[] = []
	// Changed only through the methods below, which keep the lookup indexes in step
	#sources: RouterSource[] = []
	#destinations: RouterDestination[] = []
	#index: { sources: EndpointIndex<RouterSource>; destinations: EndpointIndex<RouterDestination> } | null = null
	/** Every node in the account, sorted by name */
	nodes: RouterNode[] = []
	readonly workloads = new Map<string, AmppWorkload>()

	#listsChanged = false
	// The definitions key before the first load or clear since the last takeChanges(); null if there was none
	#keyBeforeLoad: string | null = null
	readonly #changedDestinations = new Set<RouterDestination>()
	readonly #changedSources = new Set<RouterSource>()
	readonly #changedNodes = new Set<RouterNode>()
	readonly #changedNodeMetrics = new Set<RouterNode>()
	readonly #changedAppIds = new Set<string>()

	/** Every source, grouped by fabric and sorted by label */
	get sources(): readonly RouterSource[] {
		return this.#sources
	}

	/** Every destination, grouped by fabric and sorted by label */
	get destinations(): readonly RouterDestination[] {
		return this.#destinations
	}

	/** Built when first needed after the lists, a name or alias, or their order changed */
	#lookup(): { sources: EndpointIndex<RouterSource>; destinations: EndpointIndex<RouterDestination> } {
		this.#index ??= { sources: indexEndpoints(this.#sources), destinations: indexEndpoints(this.#destinations) }
		return this.#index
	}

	/** Everything that changed since the last call, which starts collecting afresh */
	takeChanges(): StateChanges {
		const all = this.#keyBeforeLoad !== null
		const changes: StateChanges = {
			lists: this.#listsChanged || (all && this.definitionsKey() !== this.#keyBeforeLoad),
			all,
			// Not one updated then removed
			destinations: [...this.#changedDestinations].filter((d) => this.#lookup().destinations.byId.get(d.id) === d),
			sources: [...this.#changedSources].filter((s) => this.#lookup().sources.byId.get(s.id) === s),
			nodes: [...this.#changedNodes],
			nodeMetrics: [...this.#changedNodeMetrics],
			apps: [...this.#changedAppIds].flatMap((id) => {
				const app = this.workloads.get(id)
				return app && !app.parentId ? [app] : []
			}),
		}
		this.#listsChanged = false
		this.#keyBeforeLoad = null
		this.#changedDestinations.clear()
		this.#changedSources.clear()
		this.#changedNodes.clear()
		this.#changedNodeMetrics.clear()
		this.#changedAppIds.clear()
		return changes
	}

	/** Called before a load or clear changes anything, so takeChanges() can tell whether the definitions changed */
	#loading(): void {
		this.#keyBeforeLoad ??= this.definitionsKey()
	}

	/** Replaces the endpoints, updating those still there in place so references held to them stay current */
	setEndpoints(lists: readonly FabricEndpoints[]): void {
		this.#loading()
		this.fabrics = lists.map((l) => l.fabric)
		const sources = new Map(this.#sources.map((s) => [s.id, s]))
		const destinations = new Map(this.#destinations.map((d) => [d.id, d]))
		this.#sources = lists.flatMap(({ fabric, producers }) => producers.map((p) => reuse(sources, p, fabric.id)))
		this.#destinations = lists.flatMap(({ fabric, consumers }) =>
			consumers.map((c) => reuse(destinations, c, fabric.id)),
		)
		this.#relabel()
		// Relabelling only sorts the lists when a label changed, and the fabrics may have been renamed
		this.#sortEndpoints(this.#sources)
		this.#sortEndpoints(this.#destinations)
		this.#index = null
	}

	/** The app an endpoint belongs to: its workload's parent, or the workload itself when it has none */
	#appOf(endpoint: AmppEndpoint): AmppWorkload | undefined {
		const workload = endpoint.workloadId ? this.workloads.get(endpoint.workloadId) : undefined
		return (workload?.parentId && this.workloads.get(workload.parentId)) || workload
	}

	#fabricName(fabricId: string): string {
		return this.fabrics.find((f) => f.id === fabricId)?.name ?? fabricId
	}

	/**
	 * Group the endpoints by fabric, then sort them by label. Dropdowns list them in this order, so each fabric's
	 * endpoints stay together.
	 */
	#sortEndpoints(list: Array<RouterSource | RouterDestination>): void {
		const fabricNames = new Map(this.fabrics.map((f) => [f.id, f.name]))
		const fabricOf = (e: RouterSource | RouterDestination) => ({ label: fabricNames.get(e.fabricId) ?? e.fabricId })
		list.sort((a, b) => byLabel(fabricOf(a), fabricOf(b)) || byLabel(a, b))
	}

	/**
	 * Recompute every label, as one endpoint's label depends on how many others share its app (and on the app's
	 * name), then re-sort. With more than one fabric, a label ends with the fabric's name, after the endpoint's own
	 * so the part that tells endpoints apart comes first. Returns whether any changed.
	 */
	#relabel(): boolean {
		let changed = false
		const relabel = <T extends RouterSource | RouterDestination>(list: T[]): void => {
			const perApp = new Map<string, number>()
			for (const endpoint of list) {
				const appId = this.#appOf(endpoint)?.id
				if (appId) perApp.set(appId, (perApp.get(appId) ?? 0) + 1)
			}
			let listChanged = false
			for (const endpoint of list) {
				const app = this.#appOf(endpoint)
				const name = displayName(endpoint, app, !!app && perApp.get(app.id) === 1)
				const label = this.fabrics.length < 2 ? name : `${name} (${this.#fabricName(endpoint.fabricId)})`
				endpoint.shortLabel = name
				if (label !== endpoint.label) {
					endpoint.label = label
					listChanged = true
				}
			}
			if (listChanged) {
				this.#sortEndpoints(list)
				this.#index = null
			}
			changed ||= listChanged
		}
		relabel(this.#sources)
		relabel(this.#destinations)
		return changed
	}

	/** Whether these fabrics differ from the loaded ones by id or name, in any order */
	fabricsDiffer(fabrics: readonly AmppFabric[]): boolean {
		if (fabrics.length !== this.fabrics.length) return true
		return fabrics.some((f) => this.fabrics.find((known) => known.id === f.id)?.name !== f.name)
	}

	/** The id of a known fabric, matched without case as notifications may differ; null if it isn't one */
	findFabricId(fabricId: string): string | null {
		const lower = fabricId.toLowerCase()
		return this.fabrics.find((f) => f.id.toLowerCase() === lower)?.id ?? null
	}

	/** The fabric an endpoint we know is on */
	endpointFabricId(id: string): string | null {
		const { sources, destinations } = this.#lookup()
		return (destinations.byId.get(id) ?? sources.byId.get(id))?.fabricId ?? null
	}

	/** Changes to this mean the dropdowns and per-endpoint and per-node variable definitions need regenerating */
	definitionsKey(): string {
		return JSON.stringify([
			this.#sources.map((s) => [s.id, s.label]),
			this.#destinations.map((d) => [d.id, d.label]),
			this.nodes.map((n) => [n.id, n.name]),
			this.apps.map((a) => [a.id, appName(a)]),
		])
	}

	/** Record a completed route (null for a cleared one), returning whether it changed anything */
	setRoute(destinationId: string, sourceId: string | null): boolean {
		const destination = this.#lookup().destinations.byId.get(destinationId)
		if (!destination) return false

		const pendingProducerId = destination.pendingProducerId === sourceId ? null : destination.pendingProducerId
		if (destination.routedProducerId === sourceId && destination.pendingProducerId === pendingProducerId) return false

		destination.routedProducerId = sourceId
		destination.pendingProducerId = pendingProducerId
		this.#changedDestinations.add(destination)
		return true
	}

	/** Record a destination's lock state, returning whether it changed */
	setLocked(destinationId: string, locked: boolean): boolean {
		const destination = this.#lookup().destinations.byId.get(destinationId)
		if (!destination || destination.locked === locked) return false
		destination.locked = locked
		this.#changedDestinations.add(destination)
		return true
	}

	/** Apply a destination's latest state, adding it if it isn't in the list */
	upsertConsumer(fabricId: string, consumer: AmppConsumer): UpsertResult {
		const { destinations } = this.#lookup()
		return this.#upsert(
			this.#destinations,
			destinations,
			CONSUMER_FIELDS,
			fabricId,
			consumer,
			this.#changedDestinations,
		)
	}

	/** Apply a source's latest state, adding it if it isn't in the list */
	upsertProducer(fabricId: string, producer: AmppProducer): UpsertResult {
		const { sources } = this.#lookup()
		return this.#upsert(this.#sources, sources, PRODUCER_FIELDS, fabricId, producer, this.#changedSources)
	}

	#upsert<T extends RouterSource | RouterDestination>(
		list: T[],
		index: EndpointIndex<T>,
		fields: ReadonlyArray<keyof T>,
		fabricId: string,
		item: Omit<T, 'fabricId' | 'label' | 'shortLabel'>,
		changed: Set<T>,
	): UpsertResult {
		const existing = index.byId.get(item.id)
		if (!existing) {
			list.push({ ...item, fabricId, label: '', shortLabel: '' } as T)
			this.#index = null
			this.#relabel()
			this.#listsChanged = true
			return 'list'
		}
		const latest = item as T
		if (fields.every((field) => existing[field] === latest[field])) return 'unchanged'

		const labelInputsChanged = LABEL_FIELDS.some((field) => existing[field] !== latest[field])
		// Updated in place, so references callers hold stay current
		Object.assign(existing, item)
		if (labelInputsChanged) this.#index = null
		if (labelInputsChanged && this.#relabel()) {
			this.#listsChanged = true
			return 'list'
		}
		changed.add(existing)
		return 'state'
	}

	/** Returns whether the destination was in the list */
	removeConsumer(id: string): boolean {
		return this.#remove(this.#destinations, id)
	}

	/** Returns whether the source was in the list */
	removeProducer(id: string): boolean {
		return this.#remove(this.#sources, id)
	}

	#remove(list: Array<RouterSource | RouterDestination>, id: string): boolean {
		const index = list.findIndex((e) => e.id === id)
		if (index === -1) return false
		list.splice(index, 1)
		this.#index = null
		// One left on its app now reads as the app
		this.#relabel()
		this.#listsChanged = true
		return true
	}

	clear(): void {
		this.#loading()
		this.fabrics = []
		this.#sources = []
		this.#destinations = []
		this.#index = null
		this.nodes = []
		this.workloads.clear()
	}

	/** Replaces the nodes, updating those still there in place, so they keep their metrics */
	setNodes(nodes: readonly AmppNode[]): void {
		this.#loading()
		const known = new Map(this.nodes.map((n) => [n.id, n]))
		this.nodes = nodes.map((node) => {
			const existing = known.get(node.id)
			return existing ? Object.assign(existing, node) : { ...node, metrics: null }
		})
		this.#sortNodes()
	}

	#sortNodes(): void {
		this.nodes.sort((a, b) => byLabel({ label: a.name }, { label: b.name }))
	}

	/**
	 * Apply a node's latest state, adding it if it isn't in the list. Without a name (a notification may not carry
	 * one), the node keeps the one it has.
	 */
	upsertNode(update: Omit<AmppNode, 'name'> & { name: string | null }): UpsertResult {
		const existing = this.findNode(update.id)
		const node: AmppNode = { ...update, name: update.name ?? existing?.name ?? update.id }
		if (!existing) {
			this.nodes.push({ ...node, metrics: null })
			this.#sortNodes()
			this.#listsChanged = true
			return 'list'
		}
		if (existing.name !== node.name) {
			Object.assign(existing, node)
			this.#sortNodes()
			this.#listsChanged = true
			return 'list'
		}
		if (
			existing.online === node.online &&
			existing.runningWorkloads === node.runningWorkloads &&
			existing.totalWorkloads === node.totalWorkloads
		) {
			return 'unchanged'
		}
		Object.assign(existing, node)
		this.#changedNodes.add(existing)
		return 'state'
	}

	/** Returns whether the metrics changed. A node we don't know yet is skipped; its next state update adds it */
	setNodeMetrics(nodeId: string, metrics: NodeMetrics): boolean {
		const node = this.findNode(nodeId)
		if (!node || (node.metrics && METRIC_FIELDS.every((field) => node.metrics?.[field] === metrics[field]))) {
			return false
		}
		node.metrics = metrics
		this.#changedNodeMetrics.add(node)
		return true
	}

	findNode(id: string): RouterNode | undefined {
		return this.nodes.find((n) => n.id === id)
	}

	/** A node by id, then name, as typed into an expression */
	findNodeByRef(ref: string): RouterNode | undefined {
		const value = ref.trim()
		if (!value) return undefined
		return this.findNode(value) ?? this.nodes.find((n) => n.name === value)
	}

	nodeChoices(): DropdownChoice<string>[] {
		return this.nodes.map((n) => ({ id: n.id, label: n.name }))
	}

	setWorkloads(workloads: readonly AmppWorkload[]): void {
		this.#loading()
		this.workloads.clear()
		for (const workload of workloads) this.workloads.set(workload.id, workload)
		this.#relabel()
	}

	/**
	 * Apply what a notification says about a workload. `list` when a rename or new parent relabelled endpoints,
	 * `state` when only its running state changed.
	 */
	upsertWorkload(update: WorkloadUpdate): UpsertResult {
		const existing = this.workloads.get(update.id)
		const known = <K extends keyof AmppWorkload>(field: K, fallback: AmppWorkload[K]): AmppWorkload[K] =>
			update[field] !== undefined ? update[field] : (existing?.[field] ?? fallback)
		const workload: AmppWorkload = {
			id: update.id,
			name: update.name ?? existing?.name ?? update.id,
			alias: known('alias', null),
			parentId: known('parentId', null),
			state: known('state', null),
			desiredState: known('desiredState', null),
			error: known('error', null),
			nodeName: known('nodeName', null),
			packageName: known('packageName', null),
		}
		this.workloads.set(workload.id, workload)

		const renamed =
			existing?.name !== workload.name || existing.alias !== workload.alias || existing.parentId !== workload.parentId
		// A new, renamed or reparented app changes the app dropdowns and variable definitions
		const isApp = !workload.parentId
		const wasApp = !!existing && !existing.parentId
		const appListChanged = isApp !== wasApp || (isApp && renamed)
		const relabelled = renamed && this.#relabel()
		if (appListChanged || relabelled) {
			this.#listsChanged = true
			return 'list'
		}

		const stateChanged = existing?.state !== workload.state
		const appChanged =
			stateChanged ||
			existing?.desiredState !== workload.desiredState ||
			existing?.error !== workload.error ||
			existing?.nodeName !== workload.nodeName
		if (!appChanged) return 'unchanged'

		this.#changedAppIds.add(workload.parentId ?? workload.id)
		if (stateChanged) {
			// The endpoints show their own workload's state
			for (const d of this.#destinations) if (d.workloadId === workload.id) this.#changedDestinations.add(d)
			for (const s of this.#sources) if (s.workloadId === workload.id) this.#changedSources.add(s)
		}
		return 'state'
	}

	/** The apps (workloads that aren't an app's engine), sorted by name */
	get apps(): AmppWorkload[] {
		return [...this.workloads.values()]
			.filter((w) => !w.parentId)
			.sort((a, b) => byLabel({ label: appName(a) }, { label: appName(b) }))
	}

	/** An app by id, then name or alias, as typed into an expression */
	findApp(ref: string): AmppWorkload | undefined {
		const value = ref.trim()
		if (!value) return undefined
		const app = this.workloads.get(value)
		if (app && !app.parentId) return app
		const apps = this.apps
		return apps.find((a) => a.name === value) ?? apps.find((a) => a.alias === value)
	}

	appChoices(): DropdownChoice<string>[] {
		return this.apps.map((a) => ({ id: a.id, label: appName(a) }))
	}

	#engines(app: AmppWorkload): AmppWorkload[] {
		return [...this.workloads.values()].filter((w) => w.parentId === app.id)
	}

	/** The error reason the app reports, else the first of its engines' */
	appError(app: AmppWorkload): string | null {
		return app.error ?? this.#engines(app).find((e) => e.error)?.error ?? null
	}

	/** Whether the app or one of its engines is in the `Error` state, or reports an error reason */
	appHasError(app: AmppWorkload): boolean {
		return [app, ...this.#engines(app)].some((w) => w.state === 'Error' || !!w.error)
	}

	/** The running state of the workload behind an endpoint, e.g. `Running`; null if it isn't known */
	workloadState(endpoint: AmppEndpoint): string | null {
		return (endpoint.workloadId && this.workloads.get(endpoint.workloadId)?.state) || null
	}

	/** A source or destination, by id, name or alias, looking through the sources first */
	findAnyEndpoint(ref: string): RouterSource | RouterDestination | undefined {
		const { sources, destinations } = this.#lookup()
		return findEndpoint(sources, ref) ?? findEndpoint(destinations, ref)
	}

	/** Sources then destinations, labelled with which they are */
	endpointChoices(): DropdownChoice<string>[] {
		return [
			...this.#sources.map((s) => ({ id: s.id, label: `Source: ${s.label}` })),
			...this.#destinations.map((d) => ({ id: d.id, label: `Destination: ${d.label}` })),
		]
	}

	/** A source by its id alone, as a destination's routed source is */
	sourceById(id: string): RouterSource | undefined {
		return this.#lookup().sources.byId.get(id)
	}

	findSource(ref: string): RouterSource | undefined {
		return findEndpoint(this.#lookup().sources, ref)
	}

	findDestination(ref: string): RouterDestination | undefined {
		return findEndpoint(this.#lookup().destinations, ref)
	}

	sourceChoices(): DropdownChoice<string>[] {
		return this.#sources.map((s) => ({ id: s.id, label: s.label }))
	}

	destinationChoices(): DropdownChoice<string>[] {
		return this.#destinations.map((d) => ({ id: d.id, label: d.label }))
	}
}
