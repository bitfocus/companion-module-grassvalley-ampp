module.exports = {
	// @microsoft/signalr loads ws, eventsource and tough-cookie with a require esbuild can't follow, so it has to ship
	// on disk with its dependencies rather than inside the bundle
	externals: ['@microsoft/signalr'],
}
