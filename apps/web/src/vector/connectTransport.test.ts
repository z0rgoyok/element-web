/*
Copyright 2026 Denis Zabozhanov

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareConnectTransport } from "./connectTransport";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("Connect startup", () => {
    it("leaves an unconfigured deployment unchanged", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
        expect(await prepareConnectTransport()).toBe(false);
    });

    it("fails before login when configuration or worker support is unavailable", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
        await expect(prepareConnectTransport()).rejects.toThrow("configuration");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"enabled":true}')));
        vi.stubGlobal("navigator", {});
        await expect(prepareConnectTransport()).rejects.toThrow("Service Worker support");
    });

    it.each([1, 0])("requires an enabled controlling worker handshake (%s)", async (version) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"enabled":true}')));
        const register = vi.fn().mockResolvedValue({});
        const worker = {
            register,
            ready: Promise.resolve({}),
            controller: {
                postMessage: (_: unknown, ports: MessagePort[]) => ports[0].postMessage({ connectTransport: version }),
            },
        };
        vi.stubGlobal("navigator", { serviceWorker: worker });
        if (version === 1) expect(await prepareConnectTransport()).toBe(true);
        else await expect(prepareConnectTransport()).rejects.toThrow("unavailable");
        expect(register).toHaveBeenCalledWith("sw.js", { updateViaCache: "none" });
    });

    it("bounds a stalled worker registration", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"enabled":true}')));
        vi.stubGlobal("navigator", { serviceWorker: { register: () => new Promise(() => {}) } });
        const result = expect(prepareConnectTransport()).rejects.toThrow("startup timed out");
        await vi.advanceTimersByTimeAsync(15_001);
        await result;
    });
});
