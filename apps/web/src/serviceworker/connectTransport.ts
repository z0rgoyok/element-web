/*
Copyright 2026 Denis Zabozhanov

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

const CHUNK_SIZE = 3072;
const MAX_BODY = 50 * 1024 * 1024;

function encode(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
    const text = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/** Send one Matrix mutation over GET/header packets without changing Matrix semantics. */
export async function connectTransport(request: Request, send: typeof fetch = fetch): Promise<Response> {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_BODY) throw new Error("Connect upload exceeds 50 MiB");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const random = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    const id = `${Date.now().toString(16).padStart(16, "0")}-${random}`;
    const headers: Record<string, string> = {};
    for (const name of ["authorization", "content-type"]) {
        const value = request.headers.get(name);
        if (value) headers[name] = value;
    }
    const meta = new TextEncoder().encode(
        JSON.stringify({
            method: request.method,
            path: url.pathname + url.search,
            headers,
            length: body.length,
            sha256,
        }),
    );
    if (meta.length > 4096) throw new Error("Connect request metadata exceeds limit");
    const controller = new AbortController();
    const abort = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("Connect request timed out")), 240_000);

    async function packet(
        action: string,
        extra: Record<string, string> = {},
        signal = controller.signal,
    ): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await send(`${url.origin}/_connect/v1/${action}?n=${crypto.randomUUID()}`, {
                    method: "GET",
                    headers: { "X-Connect-Version": "1", "X-Connect-Id": id, ...extra },
                    cache: "no-store",
                    credentials: "omit",
                    redirect: "error",
                    signal,
                });
                if (response.headers.get("X-Connect-Id") !== id) throw new Error("Connect response identity mismatch");
                return response;
            } catch (error) {
                if (signal.aborted || attempt >= 2) throw error;
            }
        }
    }
    async function acknowledged(action: string, extra: Record<string, string>): Promise<void> {
        const response = await packet(action, extra);
        if (!response.ok) throw new Error(`Connect ${action} failed (${response.status})`);
        const acknowledgement = await response.json();
        if (acknowledgement.id !== id) throw new Error("Connect acknowledgement mismatch");
        if (action === "chunk" && acknowledgement.index !== Number(extra["X-Connect-Index"])) {
            throw new Error("Connect chunk acknowledgement mismatch");
        }
    }
    try {
        await acknowledged("begin", { "X-Connect-Meta": encode(meta) });
        let next = 0;
        const count = Math.ceil(body.length / CHUNK_SIZE);
        await Promise.all(
            Array.from({ length: Math.min(4, count) }, async () => {
                while (next < count) {
                    const index = next++;
                    await acknowledged("chunk", {
                        "X-Connect-Index": String(index),
                        "X-Connect-Chunk": encode(body.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
                    });
                }
            }),
        );
        while (true) {
            const response = await packet("execute");
            if (response.status === 202) {
                await new Promise<void>((resolve) => setTimeout(resolve, 250));
                continue;
            }
            if (!response.ok)
                throw new Error(`Connect outcome unavailable (${response.status}); request was not replayed`);
            const envelope = await response.json();
            if (
                envelope.id !== id ||
                !Number.isInteger(envelope.status) ||
                envelope.status < 200 ||
                envelope.status > 599 ||
                typeof envelope.body !== "string" ||
                envelope.body.length > 12 * 1024 * 1024 ||
                !envelope.headers ||
                typeof envelope.headers !== "object"
            ) {
                throw new Error("Invalid Connect response envelope");
            }
            const responseHeaders = new Headers({ "Cache-Control": "no-store" });
            for (const name of ["Content-Type", "Retry-After", "WWW-Authenticate"]) {
                const value = envelope.headers[name];
                if (value !== undefined) {
                    if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid Connect header");
                    responseHeaders.set(name, value);
                }
            }
            const responseBody = decode(envelope.body);
            const emptyStatus = [204, 205, 304].includes(envelope.status);
            if (emptyStatus && responseBody.length !== 0) throw new Error("Invalid empty Connect response");
            return new Response(emptyStatus ? null : responseBody, {
                status: envelope.status,
                headers: responseHeaders,
            });
        }
    } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
        controller.abort();
        // Cleanup has its own bounded lifetime, including when the original request was cancelled.
        await packet("cancel", {}, AbortSignal.timeout(3000)).catch(() => undefined);
    }
}

/** Match only same-origin Matrix mutations; keep normal GET/media handling intact. */
export function isConnectMutation(request: Request, origin: string): boolean {
    const url = new URL(request.url);
    return (
        url.origin === origin &&
        ["POST", "PUT", "DELETE", "PATCH"].includes(request.method) &&
        (url.pathname.startsWith("/_matrix/client/") || url.pathname.startsWith("/_matrix/media/"))
    );
}
