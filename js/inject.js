/**
 * Zelda Notes Plus - Injected Client Runtime
 * Transforms "Close ZELDA NOTES" into "Log Out" and communicates with host.
 */

(function initZeldaNotesPlusInject() {
    'use strict';

    if (window.__zeldaNotesPlusInjected) return;
    window.__zeldaNotesPlusInjected = true;

    // Polyfill URL constructor for about:srcdoc Next.js & RSC streaming compatibility
    try {
        const NativeURL = window.URL;
        const TARGET_BASE = 'https://api.lp1.87abc152.srv.nintendo.net/';

        function PatchedURL(url, base) {
            let effectiveBase = base;
            if (effectiveBase === undefined && typeof location !== 'undefined' && (location.href.startsWith('about:') || location.origin === 'null')) {
                effectiveBase = TARGET_BASE;
            } else if (typeof effectiveBase === 'string' && (effectiveBase.startsWith('about:') || effectiveBase === 'null')) {
                effectiveBase = TARGET_BASE;
            }
            try {
                return new NativeURL(url, effectiveBase);
            } catch (_) {
                return new NativeURL(url, TARGET_BASE);
            }
        }

        PatchedURL.prototype = NativeURL.prototype;
        Object.setPrototypeOf(PatchedURL, NativeURL);
        window.URL = PatchedURL;
    } catch (_) {}

    // Safe history.replaceState / pushState trap for srcdoc Next.js router
    try {
        const origReplace = window.history.replaceState.bind(window.history);
        const origPush = window.history.pushState.bind(window.history);

        window.history.replaceState = function (state, title, url) {
            try {
                let safeUrl = url;
                if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
                    try {
                        const parsed = new URL(url);
                        safeUrl = parsed.pathname + parsed.search + parsed.hash;
                    } catch (_) {
                        safeUrl = '';
                    }
                }
                const res = origReplace(state, title, safeUrl);
                setTimeout(replaceCloseWithLogout, 0);
                setTimeout(replaceCloseWithLogout, 150);
                return res;
            } catch (_) {}
        };

        window.history.pushState = function (state, title, url) {
            try {
                let safeUrl = url;
                if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
                    try {
                        const parsed = new URL(url);
                        safeUrl = parsed.pathname + parsed.search + parsed.hash;
                    } catch (_) {
                        safeUrl = '';
                    }
                }
                const res = origPush(state, title, safeUrl);
                setTimeout(replaceCloseWithLogout, 0);
                setTimeout(replaceCloseWithLogout, 150);
                return res;
            } catch (_) {}
        };
    } catch (_) {}

    // Intercept FontFace constructor & document.fonts to prevent CORS/401 font errors
    try {
        if (typeof window.FontFace !== 'undefined') {
            const NativeFontFace = window.FontFace;
            window.FontFace = function (family, source, descriptors) {
                if (typeof source === 'string' && (source.includes('/common/font/') || source.includes('nintendo_') || source.includes('srv.nintendo.net'))) {
                    return new NativeFontFace(family, 'local("Outfit"), local("Inter"), sans-serif', descriptors);
                }
                return new NativeFontFace(family, source, descriptors);
            };
            window.FontFace.prototype = NativeFontFace.prototype;
            Object.setPrototypeOf(window.FontFace, NativeFontFace);
        }
    } catch (_) {}

    // Intercept in-app fetch requests and route through parent proxyFetch to bypass CORS
    try {
        const nativeFetch = window.fetch.bind(window);

        window.fetch = async function (input, init) {
            const rawUrl = typeof input === 'string' ? input : (input instanceof Request ? input.url : input?.toString?.() || '');
            let targetUrl = rawUrl;
            try {
                targetUrl = new URL(rawUrl, 'https://api.lp1.87abc152.srv.nintendo.net/').href;
            } catch (_) {}

            // Suppress direct font fetches if any slip through
            if (targetUrl.includes('/common/font/') || (targetUrl.endsWith('.woff2') && targetUrl.includes('nintendo.net'))) {
                return new Response(new ArrayBuffer(0), { status: 200, headers: { 'Content-Type': 'font/woff2' } });
            }

            if (targetUrl.includes('87abc152.srv.nintendo.net') || targetUrl.includes('nintendo.net')) {
                if (window.parent && typeof window.parent.proxyFetch === 'function') {
                    const method = init?.method || (input instanceof Request ? input.method : 'GET');
                    const headers = {};
                    if (init?.headers) {
                        if (init.headers instanceof Headers) {
                            init.headers.forEach((v, k) => headers[k] = v);
                        } else if (Array.isArray(init.headers)) {
                            init.headers.forEach(([k, v]) => headers[k] = v);
                        } else {
                            Object.assign(headers, init.headers);
                        }
                    }

                    let body = init?.body;
                    if (input instanceof Request && !body && !['GET', 'HEAD'].includes(method)) {
                        try { body = await input.clone().text(); } catch (_) {}
                    }

                    try {
                        return await window.parent.proxyFetch(targetUrl, { method, headers, body });
                    } catch (_) {}
                }
            }

            return nativeFetch(input, init);
        };
    } catch (_) {}

    console.log('%c[ZeldaNotesPlus]%c Injected runtime active inside Zelda Notes', 'color: #10b981; font-weight: bold', 'color: inherit');

    function replaceCloseWithLogout() {
        const candidates = document.querySelectorAll('button, a, div, span, p, li, [role="button"], [role="menuitem"]');
        for (const el of candidates) {
            const rawText = (el.innerText || el.textContent || '').trim();
            // Match any casing or localized Close Zelda Notes
            const isCloseMatch = /close\s*zelda\s*notes/i.test(rawText) ||
                rawText === 'Close ZELDA NOTES' ||
                rawText === 'Close Zelda Notes' ||
                rawText === 'ZELDA NOTESを閉じる' ||
                rawText === 'Fermer ZELDA NOTES' ||
                rawText === 'Cerrar ZELDA NOTES' ||
                rawText === 'Fechar o ZELDA NOTES' ||
                rawText === 'Chiudi ZELDA NOTES';

            if (!isCloseMatch) continue;

            // If this is a parent container with child elements that also match, only transform the innermost element
            const hasMatchingChild = Array.from(el.children).some(child => {
                const cText = (child.innerText || child.textContent || '').trim();
                return /close\s*zelda\s*notes/i.test(cText) ||
                    cText === 'Close ZELDA NOTES' ||
                    cText === 'Close Zelda Notes' ||
                    cText === 'ZELDA NOTESを閉じる' ||
                    cText === 'Fermer ZELDA NOTES' ||
                    cText === 'Cerrar ZELDA NOTES' ||
                    cText === 'Fechar o ZELDA NOTES' ||
                    cText === 'Chiudi ZELDA NOTES';
            });
            if (hasMatchingChild) continue;

            // Replace all matching text nodes deeply using TreeWalker
            let replacedAny = false;
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
            let textNode;
            while ((textNode = walker.nextNode())) {
                const val = textNode.nodeValue || '';
                if (/close\s*zelda\s*notes/gi.test(val)) {
                    textNode.nodeValue = val.replace(/close\s*zelda\s*notes/gi, 'Log Out');
                    replacedAny = true;
                } else if (/ZELDA\s*NOTESを閉じる/g.test(val)) {
                    textNode.nodeValue = val.replace(/ZELDA\s*NOTESを閉じる/g, 'ログアウト');
                    replacedAny = true;
                } else if (/Fermer\s*ZELDA\s*NOTES/gi.test(val)) {
                    textNode.nodeValue = val.replace(/Fermer\s*ZELDA\s*NOTES/gi, 'Se déconnecter');
                    replacedAny = true;
                } else if (/Cerrar\s*ZELDA\s*NOTES/gi.test(val)) {
                    textNode.nodeValue = val.replace(/Cerrar\s*ZELDA\s*NOTES/gi, 'Cerrar sesión');
                    replacedAny = true;
                } else if (/Fechar\s*o\s*ZELDA\s*NOTES/gi.test(val)) {
                    textNode.nodeValue = val.replace(/Fechar\s*o\s*ZELDA\s*NOTES/gi, 'Terminar sessão');
                    replacedAny = true;
                } else if (/Chiudi\s*ZELDA\s*NOTES/gi.test(val)) {
                    textNode.nodeValue = val.replace(/Chiudi\s*ZELDA\s*NOTES/gi, 'Disconnettersi');
                    replacedAny = true;
                } else if (val.includes('Close') && val.includes('ZELDA')) {
                    textNode.nodeValue = val.replace(/Close/g, 'Log Out').replace(/ZELDA\s*NOTES/g, '');
                    replacedAny = true;
                }
            }

            if (!replacedAny && el.children.length === 0) {
                el.textContent = 'Log Out';
            }

            // Attach the click handler once to the clickable element
            const targetClickable = el.closest('button, a, [role="button"], [role="menuitem"]') || el;
            if (!targetClickable.dataset.zeldaPlusListenerAttached) {
                targetClickable.dataset.zeldaPlusListenerAttached = 'true';
                targetClickable.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('[ZeldaNotesPlus] In-App Log Out clicked');
                    try {
                        if (window.parent && typeof window.parent.performLogout === 'function') {
                            window.parent.performLogout();
                        } else {
                            window.parent.postMessage({ type: 'NSO_LOGOUT' }, '*');
                            window.parent.postMessage({ type: 'NSO_CLOSE_WEBVIEW' }, '*');
                        }
                    } catch (_) {}
                }, true);
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', replaceCloseWithLogout);
    } else {
        replaceCloseWithLogout();
    }

    const observer = new MutationObserver((mutations) => {
        // Strip any dynamically added font preload or stylesheet links
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1) {
                    const el = node;
                    if (el.tagName === 'LINK') {
                        const href = el.getAttribute('href') || '';
                        const as = el.getAttribute('as') || '';
                        if (as === 'font' || href.includes('/common/font/') || (href.includes('.woff2') && href.includes('nintendo.net'))) {
                            el.remove();
                        }
                    }
                }
            }
        }
        replaceCloseWithLogout();
    });

    try {
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    } catch (_) {}

    // Hook user interactions so navigating views or opening menus immediately refreshes
    window.addEventListener('click', () => setTimeout(replaceCloseWithLogout, 0), true);
    window.addEventListener('pointerdown', () => setTimeout(replaceCloseWithLogout, 0), true);
    window.addEventListener('touchstart', () => setTimeout(replaceCloseWithLogout, 0), true);
    window.addEventListener('popstate', () => setTimeout(replaceCloseWithLogout, 50), true);
})();
