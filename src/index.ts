// Dynamic DNS endpoint for UniFi OS: updates existing A/AAAA records through the Cloudflare API.
// Username/password come as HTTP Basic auth; only the password (a zone-scoped API token) is used.

const API = "https://api.cloudflare.com/client/v4";

class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

type DnsRecord = { name: string; type: "A" | "AAAA"; content: string };

function token(request: Request): string {
	const authorization = request.headers.get("Authorization");
	if (!authorization) {
		throw new HttpError(401, "API token missing.");
	}
	let decoded: string;
	try {
		decoded = atob(authorization.split(" ")[1] ?? "");
	} catch {
		throw new HttpError(401, "Invalid API key or token.");
	}
	const index = decoded.indexOf(":");
	if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
		throw new HttpError(401, "Invalid API key or token.");
	}
	return decoded.substring(index + 1);
}

function records(request: Request): DnsRecord[] {
	const params = new URL(request.url).searchParams;
	let ip = (params.get("ip") || params.get("myip"))?.trim();
	const ip6 = params.get("ip6")?.trim();
	const hostnames = (params.get("hostname") ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);

	if (!ip) {
		throw new HttpError(
			422,
			'The "ip" parameter is required and cannot be empty. Specify ip=auto to use the client IP.',
		);
	}
	if (ip === "auto") {
		ip = request.headers.get("CF-Connecting-IP") ?? undefined;
		if (!ip) {
			throw new HttpError(
				500,
				"Request asked for ip=auto but client IP address cannot be determined.",
			);
		}
	}
	if (hostnames.length === 0) {
		throw new HttpError(
			422,
			'The "hostname" parameter is required and cannot be empty.',
		);
	}
	if (ip6 && !ip6.includes(":")) {
		throw new HttpError(
			422,
			'The "ip6" parameter must be a valid IPv6 address.',
		);
	}

	return hostnames.flatMap((name): DnsRecord[] => [
		{ name, type: ip.includes(".") ? "A" : "AAAA", content: ip },
		...(ip6 ? [{ name, type: "AAAA" as const, content: ip6 }] : []),
	]);
}

// Cloudflare API errors (bad token, network) are not the client's fault: they surface as 500.
async function api<T>(
	apiToken: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(API + path, {
		...init,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
		},
	});
	const body = (await response.json()) as {
		success: boolean;
		result: T;
		errors?: unknown;
	};
	if (!response.ok || !body.success) {
		throw new Error(
			`Cloudflare API ${init.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body.errors)}`,
		);
	}
	return body.result;
}

async function update(apiToken: string, wanted: DnsRecord[]): Promise<void> {
	const { status } = await api<{ status: string }>(
		apiToken,
		"/user/tokens/verify",
	);
	if (status !== "active") {
		throw new HttpError(401, "This API Token is " + status);
	}

	const zones = await api<{ id: string }[]>(apiToken, "/zones");
	if (zones.length > 1) {
		throw new HttpError(
			400,
			"More than one zone was found! You must supply an API Token scoped to a single zone.",
		);
	}
	if (zones.length === 0) {
		throw new HttpError(
			400,
			"No zones found! You must supply an API Token scoped to a single zone.",
		);
	}
	const zone = zones[0].id;

	for (const record of wanted) {
		const query = new URLSearchParams({ name: record.name, type: record.type });
		const existing = await api<{ id?: string }[]>(
			apiToken,
			`/zones/${zone}/dns_records?${query}`,
		);
		if (existing.length > 1) {
			throw new HttpError(400, "More than one matching record found!");
		}
		if (existing.length === 0 || !existing[0].id) {
			throw new HttpError(
				400,
				"No record found! You must first manually create the record.",
			);
		}
		// PATCH keeps proxied, comment and tags as they are.
		await api(apiToken, `/zones/${zone}/dns_records/${existing[0].id}`, {
			method: "PATCH",
			body: JSON.stringify({ content: record.content, ttl: 1 }),
		});
		console.log(
			`DNS record for ${record.name} (${record.type}) updated to ${record.content}`,
		);
	}
}

export default {
	async fetch(request: Request): Promise<Response> {
		console.log(
			`${request.method} ${request.url} from ${request.headers.get("CF-Connecting-IP")}`,
		);
		try {
			await update(token(request), records(request));
			return new Response("OK");
		} catch (error) {
			console.log(
				"Error updating DNS record: " +
					(error instanceof Error ? error.message : error),
			);
			if (error instanceof HttpError) {
				return new Response(error.message, { status: error.status });
			}
			return new Response("Internal Server Error", { status: 500 });
		}
	},
} satisfies ExportedHandler;
