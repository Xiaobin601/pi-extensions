export type SitegeistBridgeConfig = {
	token: string;
	host: string;
	port: number;
};

export function loadSitegeistBridgeConfig():
	| { ok: true; config: SitegeistBridgeConfig }
	| { ok: false; error: string } {
	const token = process.env.SITEGEIST_BRIDGE_TOKEN?.trim();
	if (!token) {
		return { ok: false, error: "SITEGEIST_BRIDGE_TOKEN is not set or empty." };
	}
	const rawPort = process.env.SITEGEIST_BRIDGE_PORT;
	const port =
		rawPort !== undefined && rawPort !== ""
			? Number(rawPort)
			: 18766;
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		return { ok: false, error: "SITEGEIST_BRIDGE_PORT must be a valid TCP port (1–65535)." };
	}
	const host = process.env.SITEGEIST_BRIDGE_HOST?.trim() || "127.0.0.1";
	return { ok: true, config: { token, host, port } };
}

export function bridgeWsUrl(config: SitegeistBridgeConfig): string {
	const h = config.host.includes(":") ? `[${config.host}]` : config.host;
	return `ws://${h}:${config.port}`;
}
