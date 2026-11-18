import type { SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	platformUrl: string
}

export type ModuleSecrets = {
	apiKey: string
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'platformUrl',
			label: 'Platform URL',
			description: 'For example https://<region>.gvampp.com',
			width: 8,
			default: '',
		},
		{
			type: 'secret-text',
			id: 'apiKey',
			label: 'API Key',
			width: 8,
			default: '',
			description: 'An AMPP Control API Key. See the connection help for instructions.',
		},
	]
}
