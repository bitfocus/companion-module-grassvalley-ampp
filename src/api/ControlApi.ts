import type { AmppClient } from './AmppClient.js'

export type AppCommand = 'start' | 'stop' | 'restart'

/** The control service: starting, stopping and restarting apps */
export class ControlApi {
	readonly #client: AmppClient
	readonly #signal: AbortSignal

	/** Requests are cancelled when `signal` is aborted */
	constructor(client: AmppClient, signal: AbortSignal) {
		this.#client = client
		this.#signal = signal
	}

	/**
	 * Ask AMPP to start, stop or restart an app, returning the command's id. AMPP reports the command done once it has
	 * been passed on, before the app gets there; its progress shows in the app's own state.
	 */
	async command(command: AppCommand, workloadId: string): Promise<string> {
		const res = await this.#client.post<{ commandId?: string | null } | undefined>(
			`/cluster/control/api/v1/workload/${encodeURIComponent(workloadId)}/${command}`,
			command === 'start' ? { properties: {} } : undefined,
			this.#signal,
		)
		if (!res?.commandId) throw new Error(`The ${command} command returned no command id`)
		return res.commandId
	}
}
