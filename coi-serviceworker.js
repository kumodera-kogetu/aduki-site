/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// 妖孽奇譚サイトでの変更（2026-10-22）:
// - 登録範囲を BGM圧縮ツールのページだけにする（下の register の scope 指定）
// - 以前の「サイト全体（/）」の登録は、ページに手を加えずに自分で登録を解除する
//   （サイト全体に COEP が付き、ブロック崩しの埋め込みが拒否されていたため）
let coepCredentialless = false;
if (typeof window === 'undefined') {
    const isLegacyRootScope = new URL(self.registration.scope).pathname === "/";

    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => {
        if (isLegacyRootScope) {
            event.waitUntil(
                self.registration
                    .unregister()
                    .then(() => self.clients.matchAll({ type: "window" }))
                    .then(clients => {
                        clients.forEach((client) => client.navigate(client.url).catch(() => {}));
                    })
            );
            return;
        }
        event.waitUntil(self.clients.claim());
    });

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        if (isLegacyRootScope) {
            return;
        }

        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const controlling = n.serviceWorker && n.serviceWorker.controller;

        // Record the failure if the page is served by serviceWorker.
        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

        if (controlling) {
            // Reload only on the first failure.
            const reloadToDegrade = coi.coepDegrade() && !(
                coepDegrading || window.crossOriginIsolated
            );
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || coepHasFailed && coi.coepDegrade())
                    ? false
                    : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                !coi.quiet && console.log("Reloading page to degrade COEP.");
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or COOP/COEP are
        // already set from the origin server. Also if the browser has no notion of crossOriginIsolated, just give up here.
        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Firefox private mode) this won't be available
        if (!n.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        // 範囲を、このスクリプトを読み込んだページ（BGM圧縮ツール）だけにする
        n.serviceWorker.register(window.document.currentScript.src, { scope: window.location.pathname }).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                // 再読み込みは、SWが動き始めて（activated）から1回だけ行う
                // （動き始める前に再読み込みすると、再読み込み後のページがSWの管理下に入らず、
                //   初回だけ高速モードにならないことがあったため）
                let reloadScheduled = false;
                const reloadWhenActivated = (worker, reason) => {
                    if (reloadScheduled) {
                        return;
                    }
                    reloadScheduled = true;
                    const reload = () => {
                        !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                        window.sessionStorage.setItem("coiReloadedBySelf", reason);
                        coi.doReload();
                    };
                    if (worker.state === "activated") {
                        reload();
                        return;
                    }
                    worker.addEventListener("statechange", () => {
                        if (worker.state === "activated") {
                            reload();
                        }
                    });
                };

                registration.addEventListener("updatefound", () => {
                    if (registration.installing) {
                        reloadWhenActivated(registration.installing, "updatefound");
                    }
                });
                if (registration.installing) {
                    reloadWhenActivated(registration.installing, "updatefound");
                }

                // If the registration is active, but it's not controlling the page
                if (registration.active && !n.serviceWorker.controller) {
                    reloadWhenActivated(registration.active, "notcontrolling");
                }
            },
            (err) => {
                !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
            }
        );
    })();
}
