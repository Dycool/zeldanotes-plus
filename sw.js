/**
 * Zelda Notes Plus - Same-Origin Service Worker Proxy
 * Proxies Nintendo's Zelda Notes through the local origin so custom scripts,
 * styles, DOM transformations, and features can be injected with zero CORS restrictions.
 */

const ZELDA_TARGET = 'https://api.lp1.87abc152.srv.nintendo.net';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. Intercept embedded entry point /zelda-app/
    if (url.pathname === '/zelda-app' || url.pathname === '/zelda-app/') {
        event.respondWith(handleMainHtml(event.request));
        return;
    }

    // 2. Intercept any Nintendo font requests to prevent 401 / CORS errors
    if (url.pathname.includes('/common/font/') || url.pathname.endsWith('.woff2') || url.pathname.endsWith('.woff')) {
        event.respondWith(
            new Response(new ArrayBuffer(0), {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'font/woff2',
                    'Cache-Control': 'public, max-age=31536000'
                }
            })
        );
        return;
    }

    // 3. Forward Zelda Notes static assets and API requests
    if (url.pathname.startsWith('/_next/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/zelda-app/')) {
        const targetPath = url.pathname.replace(/^\/zelda-app/, '');
        const targetUrl = new URL(targetPath + url.search, ZELDA_TARGET);

        event.respondWith(
            fetch(targetUrl.href, {
                method: event.request.method,
                headers: event.request.headers,
                body: ['GET', 'HEAD'].includes(event.request.method) ? undefined : event.request.body,
                credentials: 'include'
            }).then(async (response) => {
                // If this is a CSS stylesheet, sanitize @font-face declarations
                if (url.pathname.endsWith('.css')) {
                    try {
                        let cssText = await response.text();
                        cssText = cssText.replace(/@font-face\s*\{[\s\S]*?\}/gi, '');
                        return new Response(cssText, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: {
                                'Content-Type': 'text/css; charset=utf-8',
                                'Access-Control-Allow-Origin': '*'
                            }
                        });
                    } catch (_) {}
                }
                return response;
            }).catch(() => {
                return fetch(event.request);
            })
        );
    }
});

async function handleMainHtml(request) {
    try {
        const response = await fetch(ZELDA_TARGET + '/', {
            headers: request.headers,
            credentials: 'include'
        });

        let html = await response.text();

        // Strip font preloads and font-faces
        html = html.replace(/<link[^>]+(?:common\/font|\.woff2?)[^>]*>/gi, '');
        html = html.replace(/<link[^>]+as=["']font["'][^>]*>/gi, '');
        html = html.replace(/@font-face\s*\{[\s\S]*?\/common\/font\/[\s\S]*?\}/gi, '');

        // Inject custom script and CSS into the HTML before browser parsing
        const injection = `
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            <link rel="stylesheet" href="/css/inject.css">
            <script src="/js/inject.js"></script>
        `;

        if (html.includes('</head>')) {
            html = html.replace('</head>', `${injection}</head>`);
        } else {
            html = injection + html;
        }

        return new Response(html, {
            status: response.status,
            statusText: response.statusText,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache'
            }
        });
    } catch (err) {
        return new Response(`<!DOCTYPE html><html><body><h2>Failed to load Zelda Notes: ${err.message}</h2></body></html>`, {
            status: 502,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }
}
