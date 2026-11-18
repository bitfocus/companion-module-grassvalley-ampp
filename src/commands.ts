import type { InstanceBase } from '@companion-module/base'
import type { Session } from './api/Connection.js'
import type { AppCommand } from './api/ControlApi.js'
import {
	classifyClearStatus,
	classifyRouteStatus,
	describeRouteRequestError,
	pollRouteStatus,
	type RouteStatusResult,
} from './api/routeStatus.js'
import type { RouteRequest } from './api/types.js'
import type { ModuleSchema } from './main.js'
import { DISCONNECT_SOURCE } from './options.js'
import { appName, type RouterDestination, type RouterSource, type RouterState } from './state/RouterState.js'
import { errorMessage } from './util/errorMessage.js'

const ROUTE_STATUS_POLL_MS = 500
const ROUTE_STATUS_TIMEOUT_MS = 10_000

/** What the commands need from the module */
export interface CommandContext extends Pick<
	InstanceBase<ModuleSchema>,
	'log' | 'setVariableValues' | 'getVariableValue'
> {
	readonly state: RouterState
	readonly selection: Selection
	/** Push what changed in the state out to variables and feedbacks */
	publishChanges(): void
	/** Push the selected destination and selected source out to variables and feedbacks */
	selectionChanged(): void
}

/** A source's id from its id, name or alias, or DISCONNECT_SOURCE itself; undefined for an unknown source */
function resolveSource(state: RouterState, sourceRef: string): string | undefined {
	return sourceRef.trim() === DISCONNECT_SOURCE ? DISCONNECT_SOURCE : state.findSource(sourceRef)?.id
}

/**
 * The destination that source buttons route to, and a source waiting for Take. Held by id, so it follows the
 * endpoints through reloads and renames.
 */
export class Selection {
	readonly #state: RouterState
	#destinationId: string | null = null
	/** A source id, or DISCONNECT_SOURCE to clear the destination */
	#sourceId: string | null = null

	constructor(state: RouterState) {
		this.#state = state
	}

	get destination(): RouterDestination | undefined {
		return this.#destinationId ? this.#state.findDestination(this.#destinationId) : undefined
	}

	/** The source waiting for Take: a source id, or DISCONNECT_SOURCE */
	get sourceId(): string | null {
		return this.#sourceId
	}

	get source(): RouterSource | undefined {
		return this.#sourceId && this.#sourceId !== DISCONNECT_SOURCE ? this.#state.sourceById(this.#sourceId) : undefined
	}

	/** Whether this source (or DISCONNECT_SOURCE) is what's routed to the selected destination */
	isRoutedToSelected(sourceRef: string): boolean {
		const destination = this.destination
		const sourceId = resolveSource(this.#state, sourceRef)
		if (!destination || !sourceId) return false
		return destination.routedProducerId === (sourceId === DISCONNECT_SOURCE ? null : sourceId)
	}

	/** Whether this source (or DISCONNECT_SOURCE) is waiting for Take */
	isSourceSelected(sourceRef: string): boolean {
		return !!this.#sourceId && resolveSource(this.#state, sourceRef) === this.#sourceId
	}

	/** Returns whether it changed; a different destination drops the source selected for the last one */
	setDestination(destinationId: string): boolean {
		if (destinationId === this.#destinationId) return false
		this.#destinationId = destinationId
		this.#sourceId = null
		return true
	}

	/** Returns whether it changed */
	setSource(sourceId: string | null): boolean {
		if (sourceId === this.#sourceId) return false
		this.#sourceId = sourceId
		return true
	}

	/** Forget a selected destination or source that's no longer in the lists; returns whether it did */
	prune(): boolean {
		let changed = false
		if (this.#destinationId && !this.destination) {
			this.#destinationId = null
			this.#sourceId = null
			changed = true
		}
		if (this.#sourceId && this.#sourceId !== DISCONNECT_SOURCE && !this.source) {
			this.#sourceId = null
			changed = true
		}
		return changed
	}
}

/** Log a failed request and rethrow it as `Could not <what>: <reason>` */
function fail(ctx: CommandContext, e: unknown, what: string, ids: string): never {
	const message = `Could not ${what}: ${errorMessage(e)}`
	ctx.log('warn', `${message} (${ids})`)
	throw new Error(message, { cause: e })
}

/**
 * Route a source to a destination, or clear the destination when the source is DISCONNECT_SOURCE. Resolves once
 * AMPP reports the route made, and throws if it's refused, fails or doesn't finish in time.
 */
export async function route(
	ctx: CommandContext,
	session: Session,
	sourceRef: string,
	destinationRef: string,
): Promise<void> {
	const { matrix } = session.apis
	const destination = ctx.state.findDestination(destinationRef)
	if (!destination) throw new Error(`Unknown destination: ${destinationRef}`)

	let source: RouterSource | null = null
	if (sourceRef.trim() !== DISCONNECT_SOURCE) {
		source = ctx.state.findSource(sourceRef) ?? null
		if (!source) throw new Error(`Unknown source: ${sourceRef}`)
		if (source.fabricId !== destination.fabricId) {
			throw new Error(`${source.label} and ${destination.label} are on different fabrics, so can't be routed`)
		}
	}

	const description = source ? `${source.label} → ${destination.label}` : `Disconnect ${destination.label}`
	const ids = source ? `${source.id} → ${destination.id}` : destination.id
	ctx.setVariableValues({ last_route: description, last_route_status: 'Requesting', last_route_error: '' })

	let request: RouteRequest
	try {
		request = source ? await matrix.requestRoute(source.id, destination.id) : await matrix.clearRoute(destination.id)
	} catch (e) {
		const message = describeRouteRequestError(e, destination.label)
		ctx.setVariableValues({ last_route_status: 'Failed', last_route_error: message })
		ctx.log('warn', `Route ${description} (${ids}) failed: ${message}`)
		throw new Error(message, { cause: e })
	}

	const isLatest = () => ctx.getVariableValue('last_route') === description
	let result: RouteStatusResult
	try {
		result = await pollRouteStatus(async () => matrix.getRouteStatus(request.requestId), {
			initialStatus: request.status,
			intervalMs: ROUTE_STATUS_POLL_MS,
			timeoutMs: ROUTE_STATUS_TIMEOUT_MS,
			signal: session.signal,
			classify: source ? classifyRouteStatus : classifyClearStatus,
			onStatusChange: (status) => {
				if (isLatest()) {
					ctx.setVariableValues({
						last_route_status: status.routeStatus,
						last_route_error: status.routeErrorMessage ?? '',
					})
				}
			},
		})
	} catch (e) {
		fail(ctx, e, `check the status of route ${description}`, ids)
	}

	if (result.outcome === 'success') {
		ctx.log('info', `Route ${description} (${ids}) done`)
		// The consumer.updated notification will say the same, but may be a second behind
		if (ctx.state.setRoute(destination.id, source?.id ?? null)) ctx.publishChanges()
		return
	}

	const message =
		result.outcome === 'failed'
			? `Route ${description} failed: ${result.status?.routeErrorMessage || result.status?.routeStatus}`
			: `Route ${description} still '${result.status?.routeStatus ?? 'unknown'}' after ${ROUTE_STATUS_TIMEOUT_MS / 1000}s`
	ctx.log('warn', `${message} (${ids})`)
	throw new Error(message)
}

export async function setLocked(
	ctx: CommandContext,
	session: Session,
	destinationRef: string,
	locked: boolean,
): Promise<void> {
	const destination = ctx.state.findDestination(destinationRef)
	if (!destination) throw new Error(`Unknown destination: ${destinationRef}`)

	try {
		await session.apis.matrix.setLocked(destination.id, locked)
	} catch (e) {
		fail(ctx, e, `${locked ? 'lock' : 'unlock'} ${destination.label}`, destination.id)
	}
	ctx.log('info', `${locked ? 'Locked' : 'Unlocked'} ${destination.label} (${destination.id})`)
	if (ctx.state.setLocked(destination.id, locked)) ctx.publishChanges()
}

/** Set a source's or destination's AMPP alias; an empty label resets it to the name. The hub reports the change */
export async function rename(
	ctx: CommandContext,
	session: Session,
	kind: 'source' | 'destination',
	ref: string,
	label: string,
): Promise<void> {
	const endpoint = kind === 'source' ? ctx.state.findSource(ref) : ctx.state.findDestination(ref)
	if (!endpoint) throw new Error(`Unknown ${kind}: ${ref}`)
	const alias = label.trim() || endpoint.name

	try {
		await session.apis.matrix.setAlias(kind === 'source' ? 'producer' : 'consumer', endpoint.id, alias)
	} catch (e) {
		fail(ctx, e, `rename ${endpoint.label}`, endpoint.id)
	}
	ctx.log('info', `Renamed ${kind} ${endpoint.label} to '${alias}' (${endpoint.id})`)
}

/** Choose the destination that source buttons route to */
export function selectDestination(ctx: CommandContext, destinationRef: string): void {
	const destination = ctx.state.findDestination(destinationRef)
	if (!destination) throw new Error(`Unknown destination: ${destinationRef}`)
	if (ctx.selection.setDestination(destination.id)) ctx.selectionChanged()
}

/**
 * Route a source (or DISCONNECT_SOURCE) to the selected destination, or select it to route on Take. Routing straight
 * away drops a source selected by another button, so Take can't route that one afterwards.
 */
export async function selectSource(
	ctx: CommandContext,
	session: Session,
	sourceRef: string,
	waitForTake: boolean,
): Promise<void> {
	const destination = ctx.selection.destination
	if (!destination) throw new Error('Select a destination first')

	if (!waitForTake) {
		if (ctx.selection.setSource(null)) ctx.selectionChanged()
		await route(ctx, session, sourceRef, destination.id)
		return
	}

	const sourceId = resolveSource(ctx.state, sourceRef)
	if (!sourceId) throw new Error(`Unknown source: ${sourceRef}`)
	if (ctx.selection.setSource(sourceId)) ctx.selectionChanged()
}

/** Route the selected source to the selected destination; it stays selected if the route fails, so Take can be retried */
export async function take(ctx: CommandContext, session: Session): Promise<void> {
	const destination = ctx.selection.destination
	const sourceId = ctx.selection.sourceId
	if (!destination || !sourceId) throw new Error('Nothing to take')

	await route(ctx, session, sourceId, destination.id)
	// Unless another source was selected while this one was routing
	if (ctx.selection.sourceId === sourceId && ctx.selection.setSource(null)) ctx.selectionChanged()
}

export function clearSelectedSource(ctx: CommandContext): void {
	if (ctx.selection.setSource(null)) ctx.selectionChanged()
}

/** Ask AMPP to start, stop or restart an app; its state follows as AMPP carries it out */
export async function controlApp(
	ctx: CommandContext,
	session: Session,
	command: AppCommand,
	appRef: string,
): Promise<void> {
	const app = ctx.state.findApp(appRef)
	if (!app) throw new Error(`Unknown app: ${appRef}`)

	try {
		await session.apis.control.command(command, app.id)
	} catch (e) {
		fail(ctx, e, `${command} ${appName(app)}`, app.id)
	}
	// AMPP has taken the command; the app's state shows it being carried out
	ctx.log('info', `Asked AMPP to ${command} ${appName(app)} (${app.id})`)
}
