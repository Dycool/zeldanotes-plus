/**
 * Zelda Notes Plus - Standalone Client
 * Uses the exact authentication and token broker flow as nso-webapp.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------
const WORKER_URL = window.WORKER_URL || 'https://nso-worker-backend.diogoenes0.workers.dev';
const DEFAULT_NSO_EXTENSION_ID = 'bjcigdmffhlolfpaocccgclocgdnenfc';
const NSO_EXTENSION_ID = window.NSO_EXTENSION_ID || localStorage.getItem('nso_extension_id') || DEFAULT_NSO_EXTENSION_ID;

const DEFAULT_NXAPI_ZNCA_API_URL = 'https://nxapi-znca-api.fancy.org.uk/api/znca';
const NXAPI_ZNCA_API_URL = (window.NXAPI_ZNCA_API_URL || localStorage.getItem('nxapi_znca_api_url') || DEFAULT_NXAPI_ZNCA_API_URL).replace(/\/$/, '');
const NXAPI_AUTH_CLIENT_ID = window.NXAPI_AUTH_CLIENT_ID || 'JGN1is1KSmRMOL-g4qmgZA';
const NXAPI_CLIENT_VERSION = 'w8zSLBsxR7rVoGJA';
const ZNCA_PLATFORM = 'Android';
const ZNCA_PLATFORM_VERSION = '12';

const CORAL_CLIENT_ID = '71b963c1b7b6d119';
const ZELDA_SERVICE_ID = '5935781783175168';
const ZELDA_SERVICE_URI = 'https://api.lp1.87abc152.srv.nintendo.net';
const BUNDLED_ZNCA_VERSION = '3.4.1';
let ZNCA_VERSION = BUNDLED_ZNCA_VERSION;

// State variables
let userSession = null;
let loginInFlight = null;
let failedLoginRetry = null;
window.nsoBackendMode = 'detecting';
let extensionPingPromise = null;

// ---------------------------------------------------------------------------
// Backend Provider Detection (Extension vs Worker)
// ---------------------------------------------------------------------------
async function nsoDetectBackend() {
    if (extensionPingPromise) return extensionPingPromise;

    extensionPingPromise = (async () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            try {
                const response = await new Promise((resolve) => {
                    const timeout = setTimeout(() => resolve(null), 350);
                    try {
                        chrome.runtime.sendMessage(NSO_EXTENSION_ID, { type: 'NSO_PING' }, (res) => {
                            clearTimeout(timeout);
                            if (chrome.runtime?.lastError) resolve(null);
                            else resolve(res);
                        });
                    } catch (_) {
                        clearTimeout(timeout);
                        resolve(null);
                    }
                });

                if (response && (response.status === 'ok' || response.ok || response.version)) {
                    window.nsoBackendMode = 'extension';
                    console.log(`%c[backend:extension]%c Connected to browser extension (v${response.version || '1.0.0'})`, 'color: #10b981; font-weight: bold', 'color: inherit');
                    return 'extension';
                }
            } catch (_) {}
        }

        window.nsoBackendMode = 'worker';
        console.log('%c[backend:worker]%c Using Cloudflare Worker backend', 'color: #3b82f6; font-weight: bold', 'color: inherit');
        return 'worker';
    })();

    return extensionPingPromise;
}

// Evaluate backend detection immediately on load
void nsoDetectBackend();

async function nsoDispatchExtensionMessage(type, payload = {}) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        throw new Error('Chrome extension runtime is not available');
    }
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(NSO_EXTENSION_ID, { type, ...payload }, (res) => {
            if (chrome.runtime?.lastError) {
                reject(new Error(chrome.runtime.lastError.message || 'Extension communication error'));
            } else if (res && res.error) {
                resolve({ ok: false, status: res.status || 400, data: res });
            } else {
                resolve({ ok: true, status: res?.status || 200, data: res?.data ?? res });
            }
        });
    });
}

function tokenBrokerClientId() {
    const key = 'nso_token_broker_client_id';
    let value = sessionStorage.getItem(key);
    if (!value) {
        value = crypto.randomUUID().replace(/-/g, '_');
        try { sessionStorage.setItem(key, value); } catch (_) {}
    }
    return value;
}

// ---------------------------------------------------------------------------
// Extension Message Mapping & nsoFetch
// ---------------------------------------------------------------------------
function mapPathToExtensionMessage(pathname, body) {
    if (pathname === '/api/nso/remember/resume') return { type: 'NSO_RESUME_SESSION', ...(body || {}) };
    if (pathname === '/api/nso/remember/save') return { type: 'NSO_REMEMBER_SAVE', ...(body || {}) };
    if (pathname === '/api/nso/remember/forget') return { type: 'NSO_REMEMBER_FORGET', ...(body || {}) };
    if (pathname === '/api/nso/cache/session/start') return { type: 'NSO_SESSION_START', ...(body || {}) };
    if (pathname === '/api/nso/cache/session/release') return { type: 'NSO_SESSION_RELEASE', ...(body || {}) };
    if (pathname === '/api/nso/cache/coral/get-or-create') return { type: 'NSO_CORAL_SESSION', ...(body || {}) };
    if (pathname === '/api/nso/service/token') return { type: 'NSO_GAME_TOKEN', ...(body || {}) };
    if (pathname === '/api/nso/service/token/cache') return { type: 'NSO_GAME_TOKEN_CACHE', ...(body || {}) };
    if (pathname === '/api/nso/coral/call') return { type: 'NSO_CORAL_CALL', ...(body || {}) };
    if (pathname === '/api/nso/coral/batch') return { type: 'NSO_CORAL_BATCH', ...(body || {}) };
    if (pathname === '/api/nso/service/session/create') return { type: 'NSO_GAME_SESSION_CREATE', ...(body || {}) };
    if (pathname === '/api/nso/auth/logout') return { type: 'NSO_LOGOUT', ...(body || {}) };
    if (pathname === '/api/nso/proxy') return { type: 'NSO_PROXY', ...(body || {}) };
    return null;
}

async function nsoFetch(urlOrPath, init = {}) {
    const url = new URL(urlOrPath, WORKER_URL);
    const pathname = url.pathname;
    let parsedBody = {};
    if (init.body) {
        try {
            parsedBody = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
        } catch (_) {}
    }

    if (window.nsoBackendMode === 'extension') {
        const extMsg = mapPathToExtensionMessage(pathname, parsedBody);
        if (extMsg) {
            const extRes = await nsoDispatchExtensionMessage(extMsg.type, extMsg);
            const status = extRes.status || (extRes.ok ? 200 : 400);
            const raw = extRes.data !== undefined ? extRes.data : extRes;
            const bodyContent = typeof raw === 'string' ? raw : (raw?.body !== undefined ? raw.body : (raw?.text !== undefined ? raw.text : JSON.stringify(raw)));
            const headers = new Headers({
                'Content-Type': 'application/json',
                'X-NSO-Active-Backend': 'extension'
            });
            return new Response(bodyContent, { status, headers });
        }
    }

    return fetch(url.href, {
        ...init,
        credentials: 'include'
    });
}

// ---------------------------------------------------------------------------
// Proxy Fetch (for Nintendo Account endpoints)
// ---------------------------------------------------------------------------
async function proxyFetch(targetUrl, options = {}) {
    const proxyPayload = {
        targetUrl: targetUrl,
        method: options.method || 'GET',
        headers: options.headers || {}
    };
    if (options.bodyBase64) {
        proxyPayload.dataBase64 = options.bodyBase64;
    } else {
        proxyPayload.data = options.body || null;
    }

    if (window.nsoBackendMode === 'extension') {
        try {
            const extRes = await nsoDispatchExtensionMessage('NSO_PROXY', proxyPayload);
            const status = extRes?.status || (extRes?.ok ? 200 : (extRes?.data?.status || 200));
            const raw = extRes?.data !== undefined ? extRes.data : extRes;
            const textContent = extRes?.text || (typeof raw === 'string' ? raw : (raw?.raw !== undefined ? raw.raw : (raw?.text !== undefined ? raw.text : (raw?.body !== undefined ? raw.body : JSON.stringify(raw)))));
            const headers = new Headers({
                'Content-Type': typeof textContent === 'string' && (textContent.includes('<html') || textContent.includes('<!DOCTYPE')) ? 'text/html' : 'application/json',
                'X-NSO-Active-Backend': 'extension'
            });
            return new Response(textContent, { status, headers });
        } catch (extErr) {
            console.warn('[ProxyFetch] Extension NSO_PROXY failed, falling back to worker:', extErr);
        }
    }

    return fetch(`${WORKER_URL}/api/nso/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(proxyPayload)
    });
}

window.proxyFetch = proxyFetch;

// ---------------------------------------------------------------------------
// Crypto & PKCE Utilities
// ---------------------------------------------------------------------------
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const values = new Uint8Array(length);
    crypto.getRandomValues(values);
    return Array.from(values, (v) => chars[v % chars.length]).join('');
}

async function generatePKCE() {
    const verifier = generateRandomString(64);
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// nxapi Helpers
// ---------------------------------------------------------------------------
let nxapiAuthToken = null;
let nxapiTokenEndpoint = null;
let nxapiZncaConfig = null;

function validZncaVersion(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

async function getNxapiTokenEndpoint() {
    if (nxapiTokenEndpoint) return nxapiTokenEndpoint;
    try {
        const apiOrigin = new URL(NXAPI_ZNCA_API_URL).origin;
        const res1 = await proxyFetch(`${apiOrigin}/.well-known/oauth-protected-resource`, {
            headers: { Accept: 'application/json' }
        });
        const d1 = await res1.json().catch(() => ({}));
        if (d1?.authorization_servers?.[0]) {
            const authServer = new URL(d1.authorization_servers[0]);
            const res2 = await proxyFetch(`${authServer.origin}/.well-known/oauth-authorization-server`, {
                headers: { Accept: 'application/json' }
            });
            const d2 = await res2.json().catch(() => ({}));
            if (d2?.token_endpoint) {
                nxapiTokenEndpoint = d2.token_endpoint;
                return d2.token_endpoint;
            }
        }
    } catch (_) {}
    return 'https://auth.fancy.org.uk/token';
}

async function getNxapiAccessToken() {
    if (nxapiAuthToken && nxapiAuthToken.expiresAt > Date.now() + 60000) {
        return nxapiAuthToken.token;
    }
    const endpoint = await getNxapiTokenEndpoint();
    const resp = await proxyFetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: new URLSearchParams({
            client_id: NXAPI_AUTH_CLIENT_ID,
            grant_type: 'client_credentials',
            scope: 'ca:gf ca:er ca:dr'
        }).toString()
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
        throw new Error(`nxapi auth failed (HTTP ${resp.status}): ${data.error_description || data.error || ''}`);
    }
    nxapiAuthToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };
    return nxapiAuthToken.token;
}

async function getNxapiZncaConfig() {
    if (nxapiZncaConfig && nxapiZncaConfig.fetchedAt + 5 * 60 * 1000 > Date.now()) {
        return nxapiZncaConfig;
    }
    const accessToken = await getNxapiAccessToken();
    const response = await proxyFetch(`${NXAPI_ZNCA_API_URL}/config`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-znca-Client-Version': NXAPI_CLIENT_VERSION,
            'X-znca-Platform': ZNCA_PLATFORM
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error_description || data?.error || `Could not fetch nxapi znca config (HTTP ${response.status})`);
    }

    const version = String(data?.nso_version || '');
    if (validZncaVersion(version)) {
        ZNCA_VERSION = version;
    }
    nxapiZncaConfig = {
        version: ZNCA_VERSION,
        fetchedAt: Date.now()
    };
    return nxapiZncaConfig;
}

// ---------------------------------------------------------------------------
// Zelda Web Service Manager
// ---------------------------------------------------------------------------
class WebServiceManager {
    constructor() {
        this.tokenCache = new Map();
        this.activeSession = null;
        this.rehydratePersistentGameTokens();
        this.initPostMessageListener();
    }

    rehydratePersistentGameTokens() {
        try {
            const raw = localStorage.getItem('nso_gws_tokens');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return;
            const now = Date.now();
            for (const [id, entry] of parsed) {
                if (entry && Number(entry.expiresAt || 0) > now + 60000 && entry.token) {
                    this.tokenCache.set(String(id), { token: String(entry.token), expiresAt: Number(entry.expiresAt) });
                }
            }
        } catch (_) {}
    }

    savePersistentGameTokens() {
        try {
            const entries = [];
            const now = Date.now();
            for (const [id, entry] of this.tokenCache.entries()) {
                if (entry && Number(entry.expiresAt || 0) > now + 60000 && entry.token) {
                    entries.push([String(id), { token: String(entry.token), expiresAt: Number(entry.expiresAt) }]);
                }
            }
            if (entries.length) {
                localStorage.setItem('nso_gws_tokens', JSON.stringify(entries));
            } else {
                localStorage.removeItem('nso_gws_tokens');
            }
        } catch (_) {}
    }

    getCachedToken(serviceId) {
        const cached = this.tokenCache.get(String(serviceId));
        if (cached && cached.expiresAt > Date.now() + 60000) {
            return cached.token;
        }
        return null;
    }

    async getGameWebServiceToken(serviceId) {
        const cached = this.getCachedToken(serviceId);
        if (cached) {
            console.log(`%c[GWS:Cache HIT]%c Reusing cached token for service ${serviceId}`, 'color: #10b981; font-weight: bold', 'color: inherit');
            return cached;
        }

        const clientId = tokenBrokerClientId();
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        const naId = String(userSession?.nsoWebapp?.naId || userSession?.result?.user?.id || userSession?.user?.id || '');
        const coralToken = userSession?.result?.webApiServerCredential?.accessToken;

        // 1. Check Broker Cache first (Zero nxapi contact)
        try {
            const cacheResp = await nsoFetch(`${WORKER_URL}/api/nso/service/token/cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    clientId,
                    serviceId: String(serviceId),
                    coralUserId,
                    zncaVersion: ZNCA_VERSION,
                    forceFresh: false
                })
            });
            const cacheData = await cacheResp.json().catch(() => ({}));
            if (cacheResp.ok && cacheData?.token?.token) {
                const tokenStr = cacheData.token.token;
                const expiresAt = Number(cacheData.token.expiresAt || (Date.now() + 7200 * 1000));
                this.tokenCache.set(String(serviceId), { token: tokenStr, expiresAt });
                this.savePersistentGameTokens();
                return tokenStr;
            }
        } catch (_) {}

        // 2. Request generation on miss
        console.log(`%c[GWS:Cache MISS]%c Requesting GameWebServiceToken for service ${serviceId}...`, 'color: #f59e0b; font-weight: bold', 'color: inherit');
        const nxapiToken = await getNxapiAccessToken();
        const config = await getNxapiZncaConfig();

        const response = await nsoFetch(`${WORKER_URL}/api/nso/service/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                clientId,
                serviceId: String(serviceId),
                coralAccessToken: coralToken,
                nxapiAccessToken: nxapiToken,
                naId,
                coralUserId,
                zncaVersion: config.version,
                serviceIds: [String(serviceId), "4834290508791808", "5598642853249024", "4953919198265344", "5935781783175168", "5741031244955648"],
                forceFresh: false
            })
        });

        const data = await response.json().catch(() => ({}));
        const tokenStr = data.token?.token || data.accessToken || data.token;
        if (!response.ok || !tokenStr) {
            throw new Error(data.error_description || data.error || 'Nintendo did not return a valid GameWebServiceToken.');
        }

        const expiresIn = Number(data.token?.expiresAt ? (data.token.expiresAt - Date.now()) / 1000 : 7200);
        this.tokenCache.set(String(serviceId), {
            token: tokenStr,
            expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
        });
        this.savePersistentGameTokens();
        return tokenStr;
    }

    async launchZeldaNotes() {
        const overlay = document.getElementById('inAppGameWebview');
        const loginGate = document.getElementById('loginGate');
        const loading = document.getElementById('gwsNativeLoading');

        loginGate?.classList.add('hidden');
        overlay?.classList.remove('hidden');
        loading?.classList.remove('hidden', 'is-complete');

        try {
            const token = await this.getGameWebServiceToken(ZELDA_SERVICE_ID);
            const userProfile = userSession?.result?.user || userSession?.user;
            const language = userProfile?.language || 'en-GB';
            const country = userProfile?.country || 'GB';

            const createResp = await nsoFetch(`${WORKER_URL}/api/nso/service/session/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    serviceId: ZELDA_SERVICE_ID,
                    serviceUri: ZELDA_SERVICE_URI,
                    token: token,
                    language,
                    country
                })
            });

            const sessionData = await createResp.json().catch(() => ({}));
            this.activeSession = sessionData;

            let webviewUrl = ZELDA_SERVICE_URI;
            if (sessionData?.webviewUrl) {
                webviewUrl = sessionData.webviewUrl;
            } else if (window.nsoBackendMode === 'extension') {
                const targetUrl = new URL('/title-select', ZELDA_SERVICE_URI);
                targetUrl.searchParams.set('lang', language);
                targetUrl.searchParams.set('na_country', country);
                targetUrl.searchParams.set('na_lang', language);
                webviewUrl = targetUrl.toString();
            }

            this.mountFrame(webviewUrl);
        } catch (err) {
            console.error('[LaunchError]', err);
            loading?.classList.add('hidden');
            alert(`Could not open Zelda Notes: ${err.message || err}`);
            loginGate?.classList.remove('hidden');
            overlay?.classList.add('hidden');
        }
    }

    mountFrame(src) {
        const wrap = document.querySelector('.inapp-webview-frame-wrap');
        if (!wrap) return;

        const oldFrame = document.getElementById('inAppGameWebviewFrame');
        oldFrame?.remove();

        const frame = document.createElement('iframe');
        frame.id = 'inAppGameWebviewFrame';
        frame.name = 'inAppGameWebviewFrame';
        frame.title = 'Zelda Notes Service';
        frame.setAttribute('allow', 'screen-wake-lock');

        if (window.nsoBackendMode !== 'extension') {
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
        }

        frame.src = src;
        wrap.appendChild(frame);

        frame.addEventListener('load', () => {
            setTimeout(() => {
                document.getElementById('gwsNativeLoading')?.classList.add('is-complete');
                setTimeout(() => document.getElementById('gwsNativeLoading')?.classList.add('hidden'), 200);
            }, 300);

            try {
                const doc = frame.contentDocument || frame.contentWindow?.document;
                if (doc) {
                    const script = doc.createElement('script');
                    script.src = new URL('js/inject.js', window.location.href).href;
                    doc.head?.appendChild(script);

                    const link = doc.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = new URL('css/inject.css', window.location.href).href;
                    doc.head?.appendChild(link);
                }
            } catch (_) {}
        });
    }

    initPostMessageListener() {
        window.addEventListener('message', async (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'NSO_LOGOUT' || data.type === 'NSO_CLOSE_WEBVIEW' || data.type === 'close') {
                console.log('[ZeldaNotesPlus] Received logout/close message from Zelda Notes webview');
                await performLogout();
                return;
            }

            if (data.type === 'completeLoading' || data.type === 'serviceReady' || data.type === 'NSO_COMPLETE_LOADING') {
                document.getElementById('gwsNativeLoading')?.classList.add('is-complete');
                setTimeout(() => document.getElementById('gwsNativeLoading')?.classList.add('hidden'), 150);
            }

            if (data.type === 'getGameWebToken' || data.type === 'requestTokenRefresh' || data.type === 'NSO_REQUEST_GAME_WEB_TOKEN') {
                try {
                    const freshToken = await this.getGameWebServiceToken(ZELDA_SERVICE_ID);
                    const frame = document.getElementById('inAppGameWebviewFrame');
                    frame?.contentWindow?.postMessage({
                        type: 'gameWebTokenResponse',
                        token: freshToken
                    }, '*');
                } catch (e) {
                    console.warn('[Bridge] Token refresh error:', e);
                }
            }
        });
    }
}

async function performLogout() {
    console.log('[Auth] Performing complete logout...');
    try {
        sessionStorage.removeItem('nso_user_session');
        localStorage.removeItem('nso_user_session');
        localStorage.removeItem('nso_gws_tokens');
        localStorage.removeItem('nso_has_remembered_account');
        localStorage.removeItem('nso_remember_expires_at');
        localStorage.removeItem('nso_pkce_verifier');
        localStorage.removeItem('nso_auth_state');
    } catch (_) {}

    userSession = null;
    failedLoginRetry = null;
    window.webServiceManager?.tokenCache?.clear();

    const frame = document.getElementById('inAppGameWebviewFrame');
    frame?.remove();

    document.getElementById('inAppGameWebview')?.classList.add('hidden');
    const loginGate = document.getElementById('loginGate');
    loginGate?.classList.remove('hidden');

    const input = document.getElementById('idTokenGateInput');
    if (input) input.value = '';

    const beginBtn = document.getElementById('beginSignInBtn');
    beginBtn?.classList.remove('hidden');
    document.getElementById('loginWorkflow')?.classList.add('hidden');

    const submitBtn = document.getElementById('submitAuthGateBtn');
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
    }
}

window.performLogout = performLogout;
window.webServiceManager = new WebServiceManager();

// ---------------------------------------------------------------------------
// Authentication & Startup Session
// ---------------------------------------------------------------------------
function hasRememberedAccount() {
    return localStorage.getItem('nso_has_remembered_account') === 'true';
}

function checkStartupSession() {
    let stored = sessionStorage.getItem('nso_user_session');
    if (!stored && hasRememberedAccount()) {
        const persistent = localStorage.getItem('nso_user_session');
        if (persistent) {
            try {
                const parsed = JSON.parse(persistent);
                const expiresAt = Number(parsed?.nsoWebapp?.coralExpiresAt || 0);
                if (expiresAt > Date.now() + 60000 && parsed?.result?.webApiServerCredential?.accessToken) {
                    stored = persistent;
                    try { sessionStorage.setItem('nso_user_session', persistent); } catch (_) {}
                }
            } catch (_) {}
        }
    }

    if (stored) {
        try {
            userSession = JSON.parse(stored);
            const expiresAt = Number(userSession?.nsoWebapp?.coralExpiresAt || 0);
            if (expiresAt > Date.now() + 60000 && userSession?.result?.webApiServerCredential?.accessToken) {
                console.log('%c[Auth:Startup]%c Resumed session -> Launching Zelda Notes directly', 'color: #10b981; font-weight: bold', 'color: inherit');
                window.webServiceManager.launchZeldaNotes();
                return;
            }
        } catch (_) {}
    }

    // Show login gate
    document.getElementById('loginGate')?.classList.remove('hidden');
    document.getElementById('inAppGameWebview')?.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Full Authentication Flow (Exact Match with nso-webapp)
// ---------------------------------------------------------------------------
function extractCodeFromInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    if (raw.includes('#')) {
        const hash = raw.substring(raw.indexOf('#') + 1);
        const params = new URLSearchParams(hash);
        const code = params.get('session_token_code');
        if (code) return code;
    }

    if (raw.includes('session_token_code=')) {
        const match = raw.match(/session_token_code=([a-zA-Z0-9_-]+)/);
        if (match) return match[1];
    }

    if (/^[a-zA-Z0-9_-]{30,}$/.test(raw)) {
        return raw;
    }

    return null;
}

async function performFullAuthentication() {
    if (loginInFlight) return loginInFlight;

    const submitBtn = document.getElementById('submitAuthGateBtn');

    loginInFlight = (async () => {
        try {
            const input = document.getElementById('idTokenGateInput')?.value?.trim();
            const rememberMe = document.getElementById('rememberMeCheckbox')?.checked === true;
            const consent = document.getElementById('nxapiConsentCheckbox')?.checked === true;

            if (!consent) {
                alert('Please accept the nxapi third-party service disclosure before continuing.');
                document.getElementById('nxapiConsentCheckbox')?.focus();
                return;
            }

            const code = extractCodeFromInput(input);
            if (!code) {
                alert('Please paste the "Select this account" link or code into the text area.');
                document.getElementById('idTokenGateInput')?.focus();
                return;
            }

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
            }

            const verifier = localStorage.getItem('nso_pkce_verifier');
            let sessionToken = failedLoginRetry?.input === input ? failedLoginRetry.sessionToken : code;

            // Step 1: Exchange code -> session_token if needed
            if (!failedLoginRetry && (code.length < 100 || input.includes('session_token_code='))) {
                const formBody = new URLSearchParams({
                    client_id: CORAL_CLIENT_ID,
                    session_token_code: code,
                    session_token_code_verifier: verifier || ''
                });

                const step1Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/session_token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                    },
                    body: formBody.toString()
                });

                const step1Data = await step1Resp.json().catch(() => ({}));
                if (!step1Resp.ok || !step1Data.session_token) {
                    throw new Error(step1Data.error_description || step1Data.error || 'Nintendo session token exchange failed.');
                }
                sessionToken = step1Data.session_token;
                failedLoginRetry = { input, sessionToken };
            }

            // Step 2: Exchange session_token -> id_token & access_token
            const step2Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                },
                body: JSON.stringify({
                    client_id: CORAL_CLIENT_ID,
                    session_token: sessionToken,
                    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token'
                })
            });

            const step2Data = await step2Resp.json().catch(() => ({}));
            if (!step2Resp.ok || !step2Data.id_token) {
                throw new Error(step2Data.error_description || step2Data.error || 'Nintendo id_token exchange failed.');
            }

            const idToken = step2Data.id_token;
            const accessToken = step2Data.access_token;

            // Step 3: Start Broker Session (Fetches profile & checks Coral cache)
            const brokerResp = await nsoFetch(`${WORKER_URL}/api/nso/cache/session/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    nintendoAccessToken: accessToken,
                    clientId: tokenBrokerClientId()
                })
            });

            const brokerData = await brokerResp.json().catch(() => ({}));
            let userInfo = brokerData.profile;

            // Ensure complete Nintendo user profile with country, language & birthday
            if (!userInfo?.id || !userInfo?.country || !userInfo?.birthday) {
                try {
                    const userResp = await proxyFetch('https://api.accounts.nintendo.com/2.0.0/users/me', {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'User-Agent': 'NASDKAPI; Android',
                            'Accept': 'application/json'
                        }
                    });
                    if (userResp.ok) {
                        const freshUser = await userResp.json().catch(() => ({}));
                        userInfo = Object.assign({}, userInfo || {}, freshUser);
                    }
                } catch (_) {}
            }

            if (!userInfo?.id) {
                throw new Error(brokerData.error_description || brokerData.error || 'Failed to start account session broker.');
            }

            const naId = userInfo.id;
            let coralSessionData = null;

            if (brokerData.coral?.session?.result?.webApiServerCredential?.accessToken) {
                coralSessionData = brokerData.coral.session;
            } else {
                // Step 4: Generate Coral via Token Broker
                const nxapiToken = await getNxapiAccessToken();
                const config = await getNxapiZncaConfig();
                const coralResp = await nsoFetch(`${WORKER_URL}/api/nso/cache/coral/get-or-create`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({
                        clientId: tokenBrokerClientId(),
                        idToken,
                        nxapiAccessToken: nxapiToken,
                        naId,
                        language: userInfo.language || 'en-GB',
                        country: userInfo.country || 'GB',
                        birthday: userInfo.birthday || '1990-01-01',
                        zncaVersion: config.version
                    })
                });

                const coralData = await coralResp.json().catch(() => ({}));
                if (!coralResp.ok || !coralData.coral?.session?.result?.webApiServerCredential?.accessToken) {
                    throw new Error(coralData.error_description || coralData.error || 'Could not create Coral session.');
                }
                coralSessionData = coralData.coral.session;
            }

            const coralCredential = coralSessionData.result.webApiServerCredential;
            userSession = {
                result: coralSessionData.result,
                user: userInfo,
                nsoWebapp: {
                    idToken,
                    sessionToken,
                    naId,
                    coralExpiresAt: Date.now() + Number(coralCredential.expiresIn || 7200) * 1000
                }
            };

            // Save session
            sessionStorage.setItem('nso_user_session', JSON.stringify(userSession));
            if (rememberMe) {
                localStorage.setItem('nso_has_remembered_account', 'true');
                localStorage.setItem('nso_user_session', JSON.stringify(userSession));
            }

            // Launch Zelda Notes directly!
            window.webServiceManager.launchZeldaNotes();
        } catch (err) {
            console.error('[AuthError]', err);
            alert(`Sign in error: ${err.message || err}`);
        } finally {
            loginInFlight = null;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
            }
        }
    })();

    return loginInFlight;
}

// ---------------------------------------------------------------------------
// Nintendo OAuth Popup Flow
// ---------------------------------------------------------------------------
async function openNintendoOAuth(e) {
    if (e) e.preventDefault();
    const consent = document.getElementById('nxapiConsentCheckbox')?.checked === true;
    if (!consent) {
        alert('Please accept the nxapi third-party service disclosure before continuing.');
        document.getElementById('nxapiConsentCheckbox')?.focus();
        return;
    }

    let popup = null;
    try {
        popup = window.open('about:blank', '_blank');
    } catch (_) {}

    try {
        const { verifier, challenge } = await generatePKCE();
        const state = generateRandomString(50);

        localStorage.setItem('nso_pkce_verifier', verifier);
        localStorage.setItem('nso_auth_state', state);

        const oauthUrl = `https://accounts.nintendo.com/connect/1.0.0/authorize?state=${state}&redirect_uri=npf71b963c1b7b6d119%3A%2F%2Fauth&client_id=${CORAL_CLIENT_ID}&scope=openid+user+user.birthday+user.screenName&response_type=session_token_code&session_token_code_challenge=${challenge}&session_token_code_challenge_method=S256&theme=login_form`;

        if (popup && !popup.closed) {
            popup.location.href = oauthUrl;
        } else {
            window.location.href = oauthUrl;
        }
    } catch (err) {
        if (popup && !popup.closed) popup.close();
        alert(`Failed to open Nintendo sign in: ${err.message || err}`);
    }
}

// ---------------------------------------------------------------------------
// DOM Event Listeners & Initialization
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    await nsoDetectBackend();

    const beginSignInBtn = document.getElementById('beginSignInBtn');
    const loginWorkflow = document.getElementById('loginWorkflow');
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn') || document.getElementById('pasteTokenBtn');
    const submitAuthGateBtn = document.getElementById('submitAuthGateBtn');
    const idTokenGateInput = document.getElementById('idTokenGateInput');
    const closeWebviewBtn = document.getElementById('closeWebviewBtn');

    beginSignInBtn?.addEventListener('click', () => {
        beginSignInBtn.classList.add('hidden');
        loginWorkflow?.classList.remove('hidden');
        loginWorkflow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    oauthGateBtn?.addEventListener('click', openNintendoOAuth);

    const checkAndAutoSubmit = () => {
        setTimeout(() => {
            const val = idTokenGateInput?.value?.trim() || '';
            if (val && (val.includes('session_token_code=') || val.length >= 30)) {
                performFullAuthentication();
            }
        }, 100);
    };

    idTokenGateInput?.addEventListener('paste', checkAndAutoSubmit);

    pasteAuthGateBtn?.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text && idTokenGateInput) {
                idTokenGateInput.value = text.trim();
                checkAndAutoSubmit();
            }
        } catch (_) {
            idTokenGateInput?.focus();
        }
    });

    submitAuthGateBtn?.addEventListener('click', () => {
        performFullAuthentication();
    });

    idTokenGateInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            performFullAuthentication();
        }
    });

    closeWebviewBtn?.addEventListener('click', () => {
        performLogout();
    });

    // Register Service Worker for Same-Origin Zelda Notes Proxy & DOM injection
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).then(() => {
            console.log('%c[SW]%c Zelda Notes Plus Service Worker registered for live DOM injection', 'color: #10b981; font-weight: bold', 'color: inherit');
        }).catch((err) => {
            console.warn('[SW] Registration failed:', err);
        });
    }

    // Check startup cache or saved session
    checkStartupSession();
});
