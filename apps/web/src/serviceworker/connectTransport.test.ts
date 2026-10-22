/*
Copyright 2026 Denis Zabozhanov

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/
import { describe, expect, it } from "vitest";

import { connectTransport, isConnectMutation } from "./connectTransport";

describe("Connect transport", () => {
    it("restricts interception to same-origin Matrix mutations", () => {
        const origin = "https://connect.test";
        expect(isConnectMutation(new Request(origin + "/_matrix/client/v3/login", { method: "POST" }), origin)).toBe(
            true,
        );
        for (const url of [origin + "/_synapse/admin/v1/register", "https://other.test/_matrix/client/v3/login"]) {
            expect(isConnectMutation(new Request(url, { method: "POST" }), origin)).toBe(false);
        }
        expect(isConnectMutation(new Request(origin + "/_matrix/client/v3/sync"), origin)).toBe(false);
    });

    it("preserves bytes, headers and status while using GET without bodies", async () => {
        const chunks = new Map<number, Uint8Array>();
        let meta: { length: number; method: string; path: string; headers: Record<string, string> } | undefined;
        let executed = 0;
        let cancelled = false;
        const source = new Uint8Array(10_000).map((_, index) => index % 256);
        const send: typeof fetch = async (input, init) => {
            expect(init?.method).toBe("GET");
            expect(init?.body).toBeUndefined();
            expect(init?.cache).toBe("no-store");
            const headers = new Headers(init?.headers);
            const id = headers.get("X-Connect-Id")!;
            const path = new URL(String(input)).pathname;
            let reply: object = { id };
            if (path.endsWith("/begin"))
                meta = JSON.parse(Buffer.from(headers.get("X-Connect-Meta")!, "base64url").toString());
            if (path.endsWith("/chunk")) {
                const index = Number(headers.get("X-Connect-Index"));
                chunks.set(index, Buffer.from(headers.get("X-Connect-Chunk")!, "base64url"));
                reply = { id, index };
            }
            if (path.endsWith("/execute")) {
                executed++;
                reply = { id, status: 201, headers: { "Content-Type": "application/octet-stream" }, body: "AP8" };
            }
            if (path.endsWith("/cancel")) cancelled = true;
            return new Response(JSON.stringify(reply), { headers: { "X-Connect-Id": id } });
        };
        const response = await connectTransport(
            new Request("https://connect.test/_matrix/media/v3/upload?filename=x", {
                method: "POST",
                body: source,
                headers: { "Authorization": "Bearer fixture", "Content-Type": "application/octet-stream" },
            }),
            send,
        );
        expect(meta).toMatchObject({
            length: 10_000,
            method: "POST",
            path: "/_matrix/media/v3/upload?filename=x",
            headers: { authorization: "Bearer fixture" },
        });
        expect(Buffer.concat([...chunks.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes))).toEqual(
            Buffer.from(source),
        );
        expect(response.status).toBe(201);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255]);
        expect(executed).toBe(1);
        expect(cancelled).toBe(true);
    });

    it("rejects a mixed cached identity and bounds retries", async () => {
        let calls = 0;
        const send: typeof fetch = async () => {
            calls++;
            return new Response("{}", { headers: { "X-Connect-Id": "other" } });
        };
        await expect(
            connectTransport(new Request("https://connect.test/_matrix/client/v3/login", { method: "POST" }), send),
        ).rejects.toThrow("identity mismatch");
        expect(calls).toBe(6); // three begin attempts, three bounded cleanup attempts
    });

    it("keeps the operation ID after a lost execute response", async () => {
        const ids: string[] = [];
        const send: typeof fetch = async (input, init) => {
            const id = new Headers(init?.headers).get("X-Connect-Id")!;
            if (String(input).includes("/execute?")) {
                ids.push(id);
                if (ids.length === 1) throw new TypeError("connection lost");
                return new Response(JSON.stringify({ id, status: 204, headers: {}, body: "" }), {
                    headers: { "X-Connect-Id": id },
                });
            }
            return new Response(JSON.stringify({ id }), { headers: { "X-Connect-Id": id } });
        };
        const response = await connectTransport(
            new Request("https://connect.test/_matrix/client/v3/logout", { method: "POST" }),
            send,
        );
        expect(response.status).toBe(204);
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(ids[1]);
    });
});
