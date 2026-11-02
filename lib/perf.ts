// Optional server-side request timing for slow-path diagnosis.
//
// Enabled only when PI_WEB_PERF=1. Every instrumented route creates a
// collector at the top of its handler, marks phases with span(), and attaches
// the result to the outgoing response. When disabled every call is a cheap
// no-op so the hot paths stay untouched.
//
// Security: logs never include message bodies, absolute file paths, cookies,
// Authorization headers, or model credentials — only route names, durations,
// and coarse memory numbers.

export interface ServerPerf {
	/** Record one phase: the duration since the previous span (or start). */
	span(name: string): void;
	/** Total wall-clock duration so far, in milliseconds. */
	totalMs(): number;
	/** Attach Server-Timing + a structured log line, then return the response. */
	attach<T extends { headers: Headers }>(response: T): T;
}

const PERF_ENABLED = process.env.PI_WEB_PERF === "1";
const BYTES_PER_MIB = 1024 * 1024;

type MemorySnapshot = {
	rss: number;
	heapUsed: number;
};

function readMemorySnapshot(): MemorySnapshot {
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed };
}

function toMiB(bytes: number): number {
	return Number((bytes / BYTES_PER_MIB).toFixed(1));
}

function deltaMiB(start: number, end: number): number {
	return Number((toMiB(end) - toMiB(start)).toFixed(1));
}

export function isServerPerfEnabled(): boolean {
	return PERF_ENABLED;
}

export function startServerPerf(route: string): ServerPerf | undefined {
	if (!PERF_ENABLED) return undefined;

	const requestId = crypto.randomUUID().slice(0, 8);
	const startedAt = performance.now();
	const startedMemory = readMemorySnapshot();
	let lastMark = startedAt;
	const spans = new Map<string, number>();

	const perf: ServerPerf = {
		span(name) {
			const now = performance.now();
			spans.set(name, (spans.get(name) ?? 0) + (now - lastMark));
			lastMark = now;
		},
		totalMs() {
			return performance.now() - startedAt;
		},
		attach(response) {
			const totalMs = performance.now() - startedAt;
			const timing = [...spans.entries()]
				.map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
				.join(", ");
			const headers = response.headers;
			headers.set(
				"Server-Timing",
				timing ? `${timing}, total;dur=${totalMs.toFixed(1)}` : `total;dur=${totalMs.toFixed(1)}`,
			);
			const phases: Record<string, number> = {};
			for (const [name, ms] of spans) phases[name] = Number(ms.toFixed(1));
			const endedMemory = readMemorySnapshot();
			const rssStartMiB = toMiB(startedMemory.rss);
			const rssEndMiB = toMiB(endedMemory.rss);
			const heapUsedStartMiB = toMiB(startedMemory.heapUsed);
			const heapUsedEndMiB = toMiB(endedMemory.heapUsed);
			console.log(JSON.stringify({
				perf: true,
				route,
				requestId,
				totalMs: Number(totalMs.toFixed(1)),
				phases,
				rssStartMiB,
				rssEndMiB,
				rssDeltaMiB: deltaMiB(startedMemory.rss, endedMemory.rss),
				heapUsedStartMiB,
				heapUsedEndMiB,
				heapUsedDeltaMiB: deltaMiB(startedMemory.heapUsed, endedMemory.heapUsed),
			}));
			return response;
		},
	};
	return perf;
}
