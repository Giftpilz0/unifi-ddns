import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import worker from "../src/index";

type Call = { method: string; path: string; body?: unknown };

// Fake Cloudflare API: answers per "METHOD /path" (query string ignored) and records every call.
let routes: Record<string, unknown>;
let calls: Call[];

beforeEach(() => {
	calls = [];
	routes = {
		"GET /user/tokens/verify": { status: "active" },
		"GET /zones": [{ id: "zone" }],
		"GET /zones/zone/dns_records": [{ id: "record" }],
		"PATCH /zones/zone/dns_records/record": {},
	};
	spyOn(console, "log").mockImplementation(() => {});
	spyOn(globalThis, "fetch").mockImplementation((async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input.toString());
		const method = init?.method ?? "GET";
		const path = url.pathname.replace("/client/v4", "");
		calls.push({
			method,
			path: path + url.search,
			body: init?.body ? JSON.parse(init.body as string) : undefined,
		});
		const result = routes[`${method} ${path}`];
		if (result instanceof Error) throw result;
		if (result === undefined)
			return Response.json(
				{ success: false, errors: [{ message: "not found" }] },
				{ status: 404 },
			);
		return Response.json({ success: true, result });
	}) as typeof fetch);
});

afterEach(() => {
	(globalThis.fetch as unknown as { mockRestore(): void }).mockRestore();
	(console.log as unknown as { mockRestore(): void }).mockRestore();
});

const auth = { Authorization: "Basic " + btoa("email@example.com:token") };

async function call(query: string, headers: Record<string, string> = auth) {
	const response = await worker.fetch(
		new Request("https://ddns.example.workers.dev/update?" + query, {
			headers,
		}),
	);
	return { status: response.status, text: await response.text() };
}

const updates = () =>
	calls.filter((c) => c.method === "PATCH").map((c) => c.body);
const lookups = () =>
	calls
		.filter((c) => c.path.startsWith("/zones/zone/dns_records?"))
		.map((c) => c.path.split("?")[1]);

describe("UniFi DDNS Worker", () => {
	it("responds with 401 when API token is missing", async () => {
		expect(await call("ip=192.0.2.1&hostname=home.example.com", {})).toEqual({
			status: 401,
			text: "API token missing.",
		});
	});

	it("responds with 401 when API token is invalid", async () => {
		const res = await call("ip=192.0.2.1&hostname=home.example.com", {
			Authorization: "Basic " + btoa("no-colon"),
		});
		expect(res).toEqual({ status: 401, text: "Invalid API key or token." });
		expect(
			await call("ip=192.0.2.1&hostname=home.example.com", {
				Authorization: "Basic %%%",
			}),
		).toEqual(res);
	});

	it("responds with 401 when token is not active", async () => {
		routes["GET /user/tokens/verify"] = { status: "disabled" };
		expect(await call("ip=192.0.2.1&hostname=home.example.com")).toEqual({
			status: 401,
			text: "This API Token is disabled",
		});
	});

	it("responds with 422 when IP is missing", async () => {
		const res = await call("hostname=home.example.com");
		expect(res.status).toBe(422);
		expect(res.text).toContain('"ip" parameter is required');
	});

	it("responds with 500 when IP is set to auto and is missing", async () => {
		const res = await call("ip=auto&hostname=home.example.com");
		expect(res.status).toBe(500);
		expect(res.text).toContain("client IP address cannot be determined");
	});

	it("responds with 422 when hostname is missing", async () => {
		for (const query of [
			"ip=192.0.2.1",
			"ip=192.0.2.1&hostname=",
			"ip=192.0.2.1&hostname=,%20,",
		]) {
			expect(await call(query)).toEqual({
				status: 422,
				text: 'The "hostname" parameter is required and cannot be empty.',
			});
		}
	});

	it("responds with 200 on valid update", async () => {
		expect(await call("ip=192.0.2.1&hostname=home.example.com")).toEqual({
			status: 200,
			text: "OK",
		});
		expect(lookups()).toEqual(["name=home.example.com&type=A"]);
		expect(updates()).toEqual([{ content: "192.0.2.1", ttl: 1 }]);
	});

	it("accepts myip as an alias for ip", async () => {
		expect(
			(await call("myip=192.0.2.1&hostname=home.example.com")).status,
		).toBe(200);
		expect(updates()).toEqual([{ content: "192.0.2.1", ttl: 1 }]);
	});

	it("responds with 200 on valid update when IP is set to auto", async () => {
		const res = await call("ip=auto&hostname=home.example.com", {
			...auth,
			"CF-Connecting-IP": "198.51.100.7",
		});
		expect(res.status).toBe(200);
		expect(updates()).toEqual([{ content: "198.51.100.7", ttl: 1 }]);
	});

	it("responds with 200 on valid multi-hostname update", async () => {
		expect(
			(await call("ip=192.0.2.1&hostname=a.example.com,%20b.example.com"))
				.status,
		).toBe(200);
		expect(lookups()).toEqual([
			"name=a.example.com&type=A",
			"name=b.example.com&type=A",
		]);
		expect(updates()).toHaveLength(2);
	});

	it("responds with 200 on multi-hostname dual-stack update", async () => {
		expect(
			(
				await call(
					"ip=192.0.2.1&ip6=2001:db8::1&hostname=a.example.com,b.example.com",
				)
			).status,
		).toBe(200);
		expect(lookups()).toEqual([
			"name=a.example.com&type=A",
			"name=a.example.com&type=AAAA",
			"name=b.example.com&type=A",
			"name=b.example.com&type=AAAA",
		]);
		expect(updates()).toEqual([
			{ content: "192.0.2.1", ttl: 1 },
			{ content: "2001:db8::1", ttl: 1 },
			{ content: "192.0.2.1", ttl: 1 },
			{ content: "2001:db8::1", ttl: 1 },
		]);
	});

	it("responds with 400 when multiple zones are found", async () => {
		routes["GET /zones"] = [{ id: "zone" }, { id: "other" }];
		const res = await call("ip=192.0.2.1&hostname=home.example.com");
		expect(res.status).toBe(400);
		expect(res.text).toContain("More than one zone");
	});

	it("responds with 400 when no zones are found", async () => {
		routes["GET /zones"] = [];
		const res = await call("ip=192.0.2.1&hostname=home.example.com");
		expect(res.status).toBe(400);
		expect(res.text).toContain("No zones found");
	});

	it("responds with 400 when multiple records are found", async () => {
		routes["GET /zones/zone/dns_records"] = [{ id: "record" }, { id: "other" }];
		expect(await call("ip=192.0.2.1&hostname=home.example.com")).toEqual({
			status: 400,
			text: "More than one matching record found!",
		});
		expect(updates()).toEqual([]);
	});

	it("responds with 400 when no records are found", async () => {
		routes["GET /zones/zone/dns_records"] = [];
		const res = await call("ip=192.0.2.1&hostname=home.example.com");
		expect(res).toEqual({
			status: 400,
			text: "No record found! You must first manually create the record.",
		});
	});

	it("responds with 500 for an unforeseen internal server error", async () => {
		routes["GET /zones"] = new Error("network down");
		expect(await call("ip=192.0.2.1&hostname=home.example.com")).toEqual({
			status: 500,
			text: "Internal Server Error",
		});
	});

	it("responds with 500 when the Cloudflare API rejects the token", async () => {
		delete routes["GET /user/tokens/verify"];
		expect(await call("ip=192.0.2.1&hostname=home.example.com")).toEqual({
			status: 500,
			text: "Internal Server Error",
		});
	});

	it("responds with 200 on valid IPv6 update", async () => {
		expect(
			(await call("ip=2001:db8::1&hostname=home.example.com")).status,
		).toBe(200);
		expect(lookups()).toEqual(["name=home.example.com&type=AAAA"]);
		expect(updates()).toEqual([{ content: "2001:db8::1", ttl: 1 }]);
	});

	it("responds with 200 on valid dual-stack update with ip6 parameter", async () => {
		expect(
			(await call("ip=192.0.2.1&ip6=2001:db8::1&hostname=home.example.com"))
				.status,
		).toBe(200);
		expect(lookups()).toEqual([
			"name=home.example.com&type=A",
			"name=home.example.com&type=AAAA",
		]);
	});

	it("responds with 422 when ip6 parameter is not a valid IPv6 address", async () => {
		expect(
			await call("ip=192.0.2.1&ip6=192.0.2.2&hostname=home.example.com"),
		).toEqual({
			status: 422,
			text: 'The "ip6" parameter must be a valid IPv6 address.',
		});
		expect(calls).toEqual([]);
	});

	it("ignores the path, so /nic/update works too", async () => {
		const response = await worker.fetch(
			new Request(
				"https://ddns.example.workers.dev/nic/update?system=dyndns&hostname=home.example.com&myip=192.0.2.1",
				{ headers: auth },
			),
		);
		expect(response.status).toBe(200);
	});
});
