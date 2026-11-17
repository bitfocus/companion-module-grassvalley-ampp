import { combineRgb, type DropdownChoice } from '@companion-module/base'
import type { TallyState } from './api/types.js'
import type ModuleInstance from './main.js'
import { destinationOption, nodeOption, sourceOption, sourceOrDestinationOption } from './options.js'

export type TallyLevel = Exclude<TallyState, 'Off'> | 'any'

export type FeedbacksSchema = {
	routed: {
		type: 'boolean'
		options: {
			source: string
			destination: string
		}
	}
	locked: {
		type: 'boolean'
		options: {
			destination: string
		}
	}
	tally: {
		type: 'boolean'
		options: {
			destination: string
			level: TallyLevel
		}
	}
	source_tally: {
		type: 'boolean'
		options: {
			source: string
			level: TallyLevel
		}
	}
	endpoint_enabled: {
		type: 'boolean'
		options: {
			endpoint: string
		}
	}
	endpoint_running: {
		type: 'boolean'
		options: {
			endpoint: string
		}
	}
	node_online: {
		type: 'boolean'
		options: {
			node: string
		}
	}
}

/** Whether an endpoint's tally state counts as on for the chosen level */
export function tallyMatches(state: TallyState | null, level: TallyLevel): boolean {
	if (!state || state === 'Off') return false
	return level === 'any' || state === level
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const source = sourceOption(self.state.sourceChoices())
	const destination = destinationOption(self.state.destinationChoices())
	const endpoint = sourceOrDestinationOption(self.state.endpointChoices())

	const levelOption = {
		id: 'level',
		type: 'dropdown',
		label: 'Tally',
		choices: [
			{ id: 'High', label: 'High (on air)' },
			{ id: 'Low', label: 'Low (preview)' },
			{ id: 'any', label: 'High or low' },
		] as DropdownChoice<TallyLevel>[],
		default: 'High',
	} as const

	self.setFeedbackDefinitions({
		routed: {
			type: 'boolean',
			name: 'Source routed to destination',
			defaultStyle: { bgcolor: combineRgb(0, 204, 0), color: combineRgb(0, 0, 0) },
			options: [source, destination],
			callback: (feedback) => {
				const destination = self.state.findDestination(feedback.options.destination)
				const source = self.state.findSource(feedback.options.source)
				return !!destination && !!source && destination.routedProducerId === source.id
			},
		},
		locked: {
			type: 'boolean',
			name: 'Destination locked',
			defaultStyle: { bgcolor: combineRgb(204, 0, 0), color: combineRgb(255, 255, 255) },
			options: [destination],
			callback: (feedback) => !!self.state.findDestination(feedback.options.destination)?.locked,
		},
		tally: {
			type: 'boolean',
			name: 'Destination tally',
			defaultStyle: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
			options: [destination, levelOption],
			callback: (feedback) =>
				tallyMatches(
					self.state.findDestination(feedback.options.destination)?.tallyState ?? null,
					feedback.options.level,
				),
		},
		source_tally: {
			type: 'boolean',
			name: 'Source tally',
			defaultStyle: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
			options: [source, levelOption],
			callback: (feedback) =>
				tallyMatches(self.state.findSource(feedback.options.source)?.tallyState ?? null, feedback.options.level),
		},
		endpoint_enabled: {
			type: 'boolean',
			name: 'Source or destination enabled',
			defaultStyle: { bgcolor: combineRgb(0, 204, 0), color: combineRgb(0, 0, 0) },
			options: [endpoint],
			callback: (feedback) => !!self.state.findAnyEndpoint(feedback.options.endpoint)?.enabled,
		},
		endpoint_running: {
			type: 'boolean',
			name: "Source or destination's app running",
			description: 'Whether the AMPP app behind it is in the Running state',
			defaultStyle: { bgcolor: combineRgb(0, 204, 0), color: combineRgb(0, 0, 0) },
			options: [endpoint],
			callback: (feedback) => {
				const endpoint = self.state.findAnyEndpoint(feedback.options.endpoint)
				return !!endpoint && self.state.workloadState(endpoint) === 'Running'
			},
		},
		node_online: {
			type: 'boolean',
			name: 'Node online',
			description: 'Whether an AMPP node is online',
			defaultStyle: { bgcolor: combineRgb(0, 204, 0), color: combineRgb(0, 0, 0) },
			options: [nodeOption(self.state.nodeChoices())],
			callback: (feedback) => !!self.state.findNodeByRef(feedback.options.node)?.online,
		},
	})
}
