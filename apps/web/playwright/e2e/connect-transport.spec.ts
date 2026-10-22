/*
Copyright 2026 Denis Zabozhanov

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/
import { test, expect } from "@playwright/test";

// CONNECT_TEST_URL is the isolated GET-only frontend from the gateway integration harness.
test("Connect controls the first page and transports fetch and XHR without VPN", async ({ page }) => {
    await page.goto(process.env.CONNECT_TEST_URL!);
    await expect(page.getByText("transport ready", { exact: true })).toBeVisible();
    const result = await page.evaluate(async () => {
        const login = await fetch("/_matrix/client/v3/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fixture: "login" }),
        });
        const loginBody = await login.json();
        const bytes = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
        const upload = await new Promise<string>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/_matrix/media/v3/upload?filename=fixture.bin");
            xhr.setRequestHeader("Authorization", "Bearer fixture");
            xhr.onload = () => (xhr.status === 200 ? resolve(xhr.responseText) : reject(new Error(String(xhr.status))));
            xhr.onerror = () => reject(new Error("XHR failed"));
            xhr.send(bytes);
        });
        const logout = await fetch("/_matrix/client/v3/logout", { method: "POST" });
        return { loginStatus: login.status, loginBody, upload: JSON.parse(upload), logoutStatus: logout.status };
    });
    expect(result).toEqual({
        loginStatus: 200,
        loginBody: { fixture: "login" },
        upload: { size: 1024 * 1024, valid: true },
        logoutStatus: 204,
    });
});
