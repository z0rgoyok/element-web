/*
Copyright 2026 Denis Zabozhanov

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Require a controlling transport worker before Element can send its first login request. */
export async function prepareConnectTransport(): Promise<boolean> {
    const response = await fetch("connect-transport.json", { cache: "no-store" });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("Cannot load Connect transport configuration");
    const config = await response.json();
    if (config.enabled !== true) return false;
    if (!("serviceWorker" in navigator)) throw new Error("Connect requires Service Worker support");
    await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve, reject) => {
            const listener = (): void => {
                if (navigator.serviceWorker.controller) {
                    clearTimeout(timeout);
                    navigator.serviceWorker.removeEventListener("controllerchange", listener);
                    resolve();
                }
            };
            const timeout = setTimeout(() => {
                navigator.serviceWorker.removeEventListener("controllerchange", listener);
                reject(new Error("Connect worker did not take control"));
            }, 15_000);
            navigator.serviceWorker.addEventListener("controllerchange", listener);
            listener();
        });
    }
    await new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => {
            channel.port1.close();
            reject(new Error("Connect worker handshake timed out"));
        }, 15_000);
        channel.port1.onmessage = (event): void => {
            clearTimeout(timeout);
            channel.port1.close();
            if (event.data?.connectTransport === 1) resolve();
            else reject(new Error("Connect transport is unavailable"));
        };
        navigator.serviceWorker.controller!.postMessage({ type: "connect-transport-ready" }, [channel.port2]);
    });
    return true;
}
