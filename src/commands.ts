import type { InstanceBase } from '@companion-module/base'
import type { Session } from './api/Connection.js'
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
import type { RouterSource, RouterState } from './state/RouterState.js'
import { errorMessage } from './util/errorMessage.js'

const ROUTE_STATUS_POLL_MS = 500
const ROUTE_STATUS_TIMEOUT_MS = 10_000

/** What the commands need from the module */
export interface CommandContext extends Pick<
	InstanceBase<ModuleSchema>,
	'log' | 'setVariableValues' | 'getVariableValue'
> {
	readonly state: RouterState
	/** Push what changed in the state out to variables and feedbacks */
	publishChanges(): void
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
