/**
 * Zelda Notes Plus - Standalone Client
 * Full feature parity with nso-webapp authentication architecture:
 * Dual-mode (Worker & Extension), Simple POST Transport (CORS-free), Token Broker,
 * Remember Me Resume, Single-Use Code Retry Protection, OAuth State/PKCE Verification,
 * and nxapi Web Locks & Caching.
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
const DEFAULT_NXAPI_AUTH_CLIENT_ID = 'JGN1is1KSmRMOL-g4qmgZA';
const NXAPI_AUTH_CLIENT_ID = window.NXAPI_AUTH_CLIENT_ID || DEFAULT_NXAPI_AUTH_CLIENT_ID;
const NXAPI_AUTH_SCOPE = 'ca:gf ca:er ca:dr';
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
let pendingRememberedResume = false;
window.nsoBackendMode = 'detecting';
let extensionPingPromise = null;

// Memory-only nxapi session
let nxapiAuthSession = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
    coralNaId: null,
    zncaVersion: null
};
let nxapiAuthMetadata = null;
let nxapiZncaConfig = null;
let nxapiLoginWarmPromise = null;

// ---------------------------------------------------------------------------
// Typed Diagnostic Errors
// ---------------------------------------------------------------------------
class AuthStageError extends Error {
    constructor(stage, message, originalError = null, status = null) {
        super(message);
        this.name = 'AuthStageError';
        this.stage = stage;
        this.originalError = originalError;
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// Version and Format Helpers
// ---------------------------------------------------------------------------
function validZncaVersion(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function activeZncaVersion(session = userSession) {
    const pinned = session?.nsoWebapp?.zncaVersion;
    return validZncaVersion(pinned) ? pinned : (validZncaVersion(ZNCA_VERSION) ? ZNCA_VERSION : BUNDLED_ZNCA_VERSION);
}

function applySessionZncaVersion(session = userSession) {
    ZNCA_VERSION = validZncaVersion(session?.nsoWebapp?.zncaVersion)
        ? session.nsoWebapp.zncaVersion
        : BUNDLED_ZNCA_VERSION;
    return ZNCA_VERSION;
}

function zncaUserAgent() {
    return `com.nintendo.znca/${activeZncaVersion()}(${ZNCA_PLATFORM}/${ZNCA_PLATFORM_VERSION})`;
}

function coralAccessToken() {
    return userSession?.result?.webApiServerCredential?.accessToken ||
        userSession?.webApiServerCredential?.accessToken || userSession?.accessToken || null;
}

function clearNxapiAuthSession() {
    nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0, coralNaId: null, zncaVersion: null };
}

function clearNxapiZncaConfig() {
    nxapiZncaConfig = null;
}

function bindNxapiCoralContext(naId, zncaVersion = activeZncaVersion()) {
    const normalizedNaId = String(naId || '');
    const normalizedVersion = validZncaVersion(zncaVersion) ? zncaVersion : BUNDLED_ZNCA_VERSION;
    const boundUser = String(nxapiAuthSession.coralNaId || '');
    const boundVersion = String(nxapiAuthSession.zncaVersion || '');
    if ((boundUser && normalizedNaId && boundUser !== normalizedNaId) ||
        (boundVersion && boundVersion !== normalizedVersion)) {
        clearNxapiAuthSession();
    }
    if (normalizedNaId) nxapiAuthSession.coralNaId = normalizedNaId;
    nxapiAuthSession.zncaVersion = normalizedVersion;
    ZNCA_VERSION = normalizedVersion;
    return normalizedVersion;
}

function nxapiVersionContextMismatch(status, data) {
    return status === 400 && (
        data?.error === 'nxapi_version_context_mismatch' ||
        /X-znca-Version.*does not match token/i.test(String(data?.error_description || data?.error || ''))
    );
}

function userFacingErrorMessage(error, fallbackMsg = 'Authentication failed. Please try again.') {
    const message = String(error?.message || '');
    const code = String(error?.code || '');
    const status = Number(error?.status || 0);
    if (status === 429 || code.includes('rate_limit') || /rate.?limit/i.test(message)) {
        return 'nxapi is temporarily rate-limited. Please try again later.';
    }
    if (status === 406 || code === 'nxapi_unsupported_version' || /no matching workers/i.test(message) || /no workers available/i.test(message)) {
        return 'nxapi is temporarily unavailable (no matching workers). Please try again later.';
    }
    return message || fallbackMsg;
}

// ---------------------------------------------------------------------------
// Rate Limiting & Retry-After Helpers
// ---------------------------------------------------------------------------
const NXAPI_RATE_LIMIT_SCOPES = ['auth', 'f1', 'f2', 'encrypt', 'decrypt'];

function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const trimmed = String(headerValue).trim();
    const seconds = Number(trimmed);
    if (!isNaN(seconds) && seconds >= 0) return Date.now() + seconds * 1000;
    const parsedDate = Date.parse(trimmed);
    return !isNaN(parsedDate) && parsedDate > Date.now() ? parsedDate : null;
}

function getRateLimitUntil(scope = null) {
    try {
        const read = (name) => {
            const num = Number(localStorage.getItem(`nxapi_rate_limit_until_${name}`));
            return !isNaN(num) && num > Date.now() ? num : 0;
        };
        if (scope) return read(scope);
        return Math.max(0, ...NXAPI_RATE_LIMIT_SCOPES.map(read));
    } catch (_) {
        return 0;
    }
}

function setRateLimitUntil(scope, timestamp) {
    try {
        const key = `nxapi_rate_limit_until_${scope}`;
        if (timestamp > Date.now()) localStorage.setItem(key, String(timestamp));
        else localStorage.removeItem(key);
        updateRateLimitBanner();
    } catch (_) {}
}

let rateLimitTimer = null;
function updateRateLimitBanner() {
    const banner = document.getElementById('rateLimitBanner');
    const bannerText = document.getElementById('rateLimitBannerText');
    const active = NXAPI_RATE_LIMIT_SCOPES
        .map(scope => ({ scope, until: getRateLimitUntil(scope) }))
        .filter(item => item.until > Date.now())
        .sort((a, b) => a.until - b.until);

    if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
        rateLimitTimer = null;
    }

    if (active.length) {
        if (banner) banner.classList.remove('hidden');
        const first = active[0];
        const remainingSec = Math.ceil((first.until - Date.now()) / 1000);
        const timeStr = new Date(first.until).toLocaleTimeString();
        if (bannerText) {
            bannerText.textContent = `nxapi authentication temporarily rate-limited. Retry after ${timeStr} (${remainingSec}s)`;
        }
        rateLimitTimer = setTimeout(updateRateLimitBanner, 1000);
    } else {
        if (banner) banner.classList.add('hidden');
    }
}

// ---------------------------------------------------------------------------
// Crypto & PKCE Utilities
// ---------------------------------------------------------------------------
function generateRandomString(length = 50) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length];
    }
    return result;
}

async function generatePKCE() {
    const verifier = generateRandomString(50);
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);

    let binary = '';
    const bytes = new Uint8Array(hash);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const challenge = btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    return { verifier, challenge };
}

function tokenBrokerClientId() {
    const key = 'nso_token_broker_client_id';
    let value = null;
    try { value = sessionStorage.getItem(key); } catch (_) {}
    if (!value) {
        value = crypto.randomUUID().replace(/-/g, '_');
        try { sessionStorage.setItem(key, value); } catch (_) {}
    }
    return value;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

// ---------------------------------------------------------------------------
// Backend Provider Detection (Extension vs Worker)
// ---------------------------------------------------------------------------
async function nsoDetectBackend() {
    if (extensionPingPromise) return extensionPingPromise;

    extensionPingPromise = (async () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            try {
                const response = await new Promise((resolve) => {
                    const timeout = setTimeout(() => resolve(null), 300);
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

window.nsoDispatchExtensionMessage = nsoDispatchExtensionMessage;

// ---------------------------------------------------------------------------
// Worker Simple-POST Transport & Extension Interception
// Prevents CORS Preflights (OPTIONS) by transforming application/json to text/plain
// and directly bridges requests via extension in extension mode.
// ---------------------------------------------------------------------------
(function installWorkerSimplePostTransport() {
    if (window.__nsoWorkerSimplePostTransportInstalled) return;
    window.__nsoWorkerSimplePostTransportInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    const workerOrigin = new URL(WORKER_URL).origin;

    function installOneShotBrokerResume(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        const original = window.startTokenBrokerSession;
        if (typeof original !== 'function' || original.__nsoCombinedResumeOneShot) return;

        let restoreTimer = null;
        const restore = () => {
            if (window.startTokenBrokerSession === wrapped) {
                window.startTokenBrokerSession = original;
                try { startTokenBrokerSession = original; } catch (_) {}
            }
            if (restoreTimer) clearTimeout(restoreTimer);
            restoreTimer = null;
        };
        const wrapped = async function startTokenBrokerSessionFromCombinedResume() {
            restore();
            return snapshot;
        };
        wrapped.__nsoCombinedResumeOneShot = true;
        window.startTokenBrokerSession = wrapped;
        try { startTokenBrokerSession = wrapped; } catch (_) {}
        restoreTimer = setTimeout(restore, 30_000);
    }

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

        const renewMatch = pathname.match(/^\/api\/nso\/service\/session\/([a-zA-Z0-9-]+)\/renew-token$/);
        if (renewMatch) return { type: 'NSO_GAME_TOKEN_RENEW', sessionId: renewMatch[1], ...(body || {}) };

        const closeMatch = pathname.match(/^\/api\/nso\/service\/session\/([a-zA-Z0-9-]+)\/close$/);
        if (closeMatch) return { type: 'NSO_GAME_SESSION_CLOSE', sessionId: closeMatch[1], ...(body || {}) };

        return null;
    }

    async function dispatchExtensionFetch(msg, pathname) {
        try {
            const extRes = await window.nsoDispatchExtensionMessage(msg.type, msg);
            const status = extRes.status || (extRes.ok ? 200 : 400);
            const headers = new Headers({
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'X-NSO-Active-Backend': 'extension'
            });
            if (pathname === '/api/nso/remember/resume' && extRes.data?.brokerSession) {
                installOneShotBrokerResume(extRes.data.brokerSession);
            }
            const bodyContent = typeof extRes.text === 'string' ? extRes.text : JSON.stringify(extRes.data !== undefined ? extRes.data : extRes);
            return new Response(bodyContent, { status, headers });
        } catch (extErr) {
            console.warn('[NSO Transport] Extension request failed, falling back to worker:', extErr?.message);
            throw extErr;
        }
    }

    window.fetch = function nsoEfficientFetch(input, init) {
        try {
            if (!(input instanceof Request)) {
                const target = new URL(String(input), location.href);
                const method = String(init?.method || 'GET').toUpperCase();
                if (target.origin === workerOrigin && target.pathname.startsWith('/api/nso/') && method === 'POST') {
                    if (window.nsoBackendMode === 'extension' && typeof window.nsoDispatchExtensionMessage === 'function') {
                        let parsedBody = {};
                        try {
                            if (typeof init?.body === 'string') parsedBody = JSON.parse(init.body);
                        } catch (_) {}
                        const extMsg = mapPathToExtensionMessage(target.pathname, parsedBody);
                        if (extMsg) {
                            return dispatchExtensionFetch(extMsg, target.pathname).catch(() => nativeFetch(input, init));
                        }
                    }
                    const headers = new Headers(init?.headers || {});
                    let nextInit = { ...(init || {}), headers };
                    let combinedResume = false;

                    if (target.pathname === '/api/nso/remember/resume' && nextInit.body == null && typeof tokenBrokerClientId === 'function') {
                        const clientId = String(tokenBrokerClientId() || '');
                        if (/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) {
                            headers.set('Content-Type', 'text/plain;charset=UTF-8');
                            nextInit.body = JSON.stringify({ clientId });
                            combinedResume = true;
                        }
                    } else {
                        const contentType = String(headers.get('Content-Type') || '');
                        if (/^application\/json(?:\s*;|$)/i.test(contentType)) {
                            headers.set('Content-Type', 'text/plain;charset=UTF-8');
                        }
                    }

                    const requestPromise = nativeFetch(input, nextInit);
                    if (!combinedResume) return requestPromise;

                    return requestPromise.then(async response => {
                        if (!response.ok) return response;
                        try {
                            const data = await response.clone().json();
                            if (data?.brokerSession) installOneShotBrokerResume(data.brokerSession);
                        } catch (_) {}
                        return response;
                    });
                }
            }
        } catch (_) {}
        return nativeFetch(input, init);
    };
})();

// ---------------------------------------------------------------------------
// Proxy Fetch (for Nintendo Account and nxapi endpoints)
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
        body: JSON.stringify(proxyPayload),
        signal: options.signal
    });
}

window.proxyFetch = proxyFetch;

// ---------------------------------------------------------------------------
// nxapi Authentication & Pipeline (Extension / Client-Side Fallback)
// ---------------------------------------------------------------------------
const NXAPI_AUTH_METADATA_CACHE_KEY = 'nso_nxapi_auth_metadata_v1';
const NXAPI_AUTH_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NXAPI_ZNCA_CONFIG_MAX_AGE_MS = 5 * 60 * 1000;

function readCachedNxapiAuthMetadata() {
    try {
        const record = JSON.parse(localStorage.getItem(NXAPI_AUTH_METADATA_CACHE_KEY) || 'null');
        if (!record || Number(record.expiresAt || 0) <= Date.now()) return null;
        const endpoint = String(record.tokenEndpoint || '');
        const url = new URL(endpoint);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('fancy.org.uk')) return null;
        return { token_endpoint: endpoint };
    } catch (_) { return null; }
}

function writeCachedNxapiAuthMetadata(metadata) {
    try {
        const endpoint = String(metadata?.token_endpoint || '');
        if (!endpoint) return;
        localStorage.setItem(NXAPI_AUTH_METADATA_CACHE_KEY, JSON.stringify({
            tokenEndpoint: endpoint,
            expiresAt: Date.now() + NXAPI_AUTH_METADATA_MAX_AGE_MS
        }));
    } catch (_) {}
}

function nxapiUrl(path) {
    return `${NXAPI_ZNCA_API_URL}/${path.replace(/^\//, '')}`;
}

function hasNxapiConsent() {
    return document.getElementById('nxapiConsentCheckbox')?.checked === true;
}

async function prepareNxapi() {
    if (window.nsoBackendMode === 'extension' && !hasNxapiConsent()) {
        throw new AuthStageError('NXAPI_AUTH', 'Please accept the nxapi third-party service disclosure before continuing.');
    }
}

async function getNxapiAccessToken(options = {}) {
    const rateLimitUntil = getRateLimitUntil('auth');
    if (rateLimitUntil > Date.now()) {
        const timeStr = new Date(rateLimitUntil).toLocaleTimeString();
        const remainingSec = Math.ceil((rateLimitUntil - Date.now()) / 1000);
        throw new AuthStageError(
            'NXAPI_AUTH',
            `nxapi authentication temporarily rate-limited. Retry after ${timeStr} (${remainingSec}s remaining).`
        );
    }

    if (nxapiAuthSession.accessToken && nxapiAuthSession.expiresAt > Date.now() + 10000) {
        return nxapiAuthSession.accessToken;
    }

    return await navigator.locks.request('nxapi-token', async () => {
        if (nxapiAuthSession.accessToken && nxapiAuthSession.expiresAt > Date.now() + 10000) {
            return nxapiAuthSession.accessToken;
        }

        const clientId = NXAPI_AUTH_CLIENT_ID.trim();
        if (!nxapiAuthMetadata) nxapiAuthMetadata = readCachedNxapiAuthMetadata();

        if (!nxapiAuthMetadata) {
            const apiOrigin = new URL(NXAPI_ZNCA_API_URL).origin;
            const protectedResourceResp = await proxyFetch(`${apiOrigin}/.well-known/oauth-protected-resource`, {
                headers: { Accept: 'application/json' },
                signal: options.signal
            });
            const protectedResource = await protectedResourceResp.json().catch(() => ({}));
            if (!protectedResourceResp.ok || !protectedResource.authorization_servers?.[0]) {
                throw new AuthStageError('NXAPI_AUTH', protectedResource.error_description || 'Could not discover nxapi authentication metadata.');
            }

            const authorizationServer = new URL(protectedResource.authorization_servers[0]);
            const authorizationMetadataResp = await proxyFetch(
                `${authorizationServer.origin}/.well-known/oauth-authorization-server`,
                {
                    headers: { Accept: 'application/json' },
                    signal: options.signal
                }
            );
            nxapiAuthMetadata = await authorizationMetadataResp.json().catch(() => ({}));
            if (!authorizationMetadataResp.ok || !nxapiAuthMetadata.token_endpoint) {
                throw new AuthStageError('NXAPI_AUTH', nxapiAuthMetadata.error_description || 'Could not discover the nxapi token endpoint.');
            }
            writeCachedNxapiAuthMetadata(nxapiAuthMetadata);
        }

        const isRefresh = Boolean(nxapiAuthSession.refreshToken);
        const tokenRequest = isRefresh ? {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: nxapiAuthSession.refreshToken
        } : {
            grant_type: 'client_credentials',
            client_id: clientId,
            scope: NXAPI_AUTH_SCOPE
        };

        const tokenResp = await proxyFetch(nxapiAuthMetadata.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body: new URLSearchParams(tokenRequest).toString(),
            signal: options.signal
        });

        if (tokenResp.status === 429) {
            const retryAfterHeader = tokenResp.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil('auth', until);
            const timeStr = new Date(until).toLocaleTimeString();
            throw new AuthStageError('NXAPI_AUTH', `nxapi authentication rate-limited (HTTP 429). Retry after ${timeStr}.`, null, 429);
        }

        let tokenData = {};
        try { tokenData = await tokenResp.json(); } catch (_) {}

        if (!tokenResp.ok || !tokenData.access_token) {
            if (isRefresh) clearNxapiAuthSession();
            const errMsg = tokenData.error_description || tokenData.error || `nxapi authentication failed (HTTP ${tokenResp.status}).`;
            throw new AuthStageError('NXAPI_AUTH', errMsg, null, tokenResp.status);
        }

        nxapiAuthSession = {
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + Math.max(1, Number(tokenData.expires_in || 300)) * 1000,
            refreshToken: tokenData.refresh_token || nxapiAuthSession.refreshToken || null,
            coralNaId: nxapiAuthSession.coralNaId || null,
            zncaVersion: nxapiAuthSession.zncaVersion || null
        };

        return nxapiAuthSession.accessToken;
    });
}

async function getNxapiZncaConfig(options = {}) {
    if (nxapiZncaConfig && nxapiZncaConfig.fetchedAt + NXAPI_ZNCA_CONFIG_MAX_AGE_MS > Date.now()) {
        return nxapiZncaConfig;
    }
    return await navigator.locks.request('nxapi-config', async () => {
        if (nxapiZncaConfig && nxapiZncaConfig.fetchedAt + NXAPI_ZNCA_CONFIG_MAX_AGE_MS > Date.now()) {
            return nxapiZncaConfig;
        }
        const accessToken = options.accessToken || await getNxapiAccessToken({ signal: options.signal });
        const response = await proxyFetch(nxapiUrl('config'), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${accessToken}`,
                'X-znca-Client-Version': NXAPI_CLIENT_VERSION,
                'X-znca-Platform': ZNCA_PLATFORM
            },
            signal: options.signal
        });
        const data = await response.json().catch(() => ({}));

        if (response.status === 401) clearNxapiAuthSession();
        if (!response.ok) {
            throw new AuthStageError(
                'NXAPI_CONFIG',
                data?.error_description || data?.error || `Could not read nxapi ZNCA configuration (HTTP ${response.status}).`,
                null,
                response.status
            );
        }

        const version = String(data?.nso_version || '');
        if (!validZncaVersion(version)) {
            throw new AuthStageError('NXAPI_CONFIG', 'nxapi returned an invalid or missing nso_version.');
        }

        nxapiZncaConfig = {
            version,
            fetchedAt: Date.now()
        };
        ZNCA_VERSION = version;
        nxapiAuthSession.zncaVersion = version;
        return nxapiZncaConfig;
    });
}

async function warmNxapiForLogin() {
    if (nxapiLoginWarmPromise) return nxapiLoginWarmPromise;
    nxapiLoginWarmPromise = (async () => {
        const nxapiAccessToken = await getNxapiAccessToken();
        const config = await getNxapiZncaConfig({ accessToken: nxapiAccessToken });
        return { nxapiAccessToken, zncaVersion: config.version };
    })();
    try {
        return await nxapiLoginWarmPromise;
    } finally {
        nxapiLoginWarmPromise = null;
    }
}

async function nxapiFetch(path, options = {}) {
    const token = await getNxapiAccessToken({ signal: options.signal });
    if (!userSession && !validZncaVersion(nxapiAuthSession.zncaVersion)) {
        await getNxapiZncaConfig({ accessToken: token, signal: options.signal });
    }
    const response = await proxyFetch(nxapiUrl(path), {
        ...options,
        headers: {
            'X-znca-Client-Version': NXAPI_CLIENT_VERSION,
            'X-znca-Platform': ZNCA_PLATFORM,
            'X-znca-Version': activeZncaVersion(),
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
        }
    });

    if (response.status === 401) clearNxapiAuthSession();
    if (response.status === 406) clearNxapiZncaConfig();

    return response;
}

async function nxapiGenerateF(method, token, userData = {}, requestOptions = {}) {
    if (userData?.na_id && !userSession) {
        const accessToken = await getNxapiAccessToken({ signal: requestOptions.signal });
        const config = await getNxapiZncaConfig({ accessToken, signal: requestOptions.signal });
        bindNxapiCoralContext(userData.na_id, config.version);
    } else if (userData?.na_id) {
        bindNxapiCoralContext(userData.na_id, activeZncaVersion());
    }

    console.log(`%c[nxapi:f${method}]%c Generating Method ${method} attestation`, "color: #f97316; font-weight: bold", "color: inherit");
    const response = await nxapiFetch('f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ hash_method: String(method), token, ...userData }),
        signal: requestOptions.signal
    });

    let data = {};
    try { data = await response.json(); } catch (_) {}

    if (!response.ok || !data.f || !data.request_id || !Number.isFinite(Number(data.timestamp))) {
        if (nxapiVersionContextMismatch(response.status, data)) clearNxapiAuthSession();
        const errorMsg = data?.error_description || data?.error || 'nxapi did not return a complete attestation result.';
        if (response.status === 429 || errorMsg.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil(method === 1 ? 'f1' : 'f2', until);
            const timeStr = new Date(until).toLocaleTimeString();
            const sec = Math.ceil((until - Date.now()) / 1000);
            throw new AuthStageError('NXAPI_AUTH', `nxapi authentication temporarily rate-limited. Retry after ${timeStr} (${sec}s remaining).`, null, 429);
        }
        const stage = method === 1 ? 'NXAPI_F_METHOD_1' : 'NXAPI_F_METHOD_2';
        throw new AuthStageError(stage, errorMsg, null, response.status);
    }
    return { f: data.f, timestamp: Number(data.timestamp), requestId: data.request_id };
}

async function nxapiEncryptRequest(url, bearerToken, body, requestOptions = {}) {
    if (userSession?.nsoWebapp?.naId) bindNxapiCoralContext(userSession.nsoWebapp.naId, activeZncaVersion());
    const response = await nxapiFetch('encrypt-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url, token: bearerToken || null, data: body }),
        signal: requestOptions.signal
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}

    if (!response.ok || !data.data) {
        if (nxapiVersionContextMismatch(response.status, data)) clearNxapiAuthSession();
        const errorMsg = data?.error_description || data?.error || 'nxapi request encryption failed.';
        if (response.status === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil('encrypt', until);
            throw new AuthStageError('NXAPI_AUTH', 'nxapi request encryption temporarily rate-limited.', null, 429);
        }
        throw new AuthStageError('NXAPI_ENCRYPT_ACCOUNT_LOGIN', errorMsg, null, response.status);
    }
    return data.data.replace(/-/g, '+').replace(/_/g, '/');
}

async function nxapiDecryptResponse(encryptedBase64, requestOptions = {}) {
    if (userSession?.nsoWebapp?.naId) bindNxapiCoralContext(userSession.nsoWebapp.naId, activeZncaVersion());
    const response = await nxapiFetch('decrypt-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify({ data: encryptedBase64 }),
        signal: requestOptions.signal
    });
    const data = await response.text();
    if (!response.ok) {
        if (nxapiVersionContextMismatch(response.status, data)) clearNxapiAuthSession();
        if (response.status === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil('decrypt', until);
            throw new AuthStageError('NXAPI_AUTH', 'nxapi response decryption temporarily rate-limited.', null, 429);
        }
        throw new AuthStageError('NXAPI_DECRYPT_ACCOUNT_LOGIN', data || 'nxapi response decryption failed.', null, response.status);
    }
    return data;
}

async function parseCoralResponse(response, requestOptions = {}) {
    const buffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(buffer);
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(text);
        } catch (_) {}
    }
    const encryptedBase64 = arrayBufferToBase64(buffer);
    const decrypted = await nxapiDecryptResponse(encryptedBase64, requestOptions);
    return JSON.parse(decrypted);
}

// ---------------------------------------------------------------------------
// Account Token Broker
// ---------------------------------------------------------------------------
async function startTokenBrokerSession(nintendoAccessToken) {
    if (!nintendoAccessToken) return null;
    const response = await fetch(`${WORKER_URL}/api/nso/cache/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            nintendoAccessToken,
            clientId: tokenBrokerClientId()
        })
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
        const error = new Error(data?.error_description || data?.error || `Token broker session failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return data;
}

window.startTokenBrokerSession = startTokenBrokerSession;

function validBrokerCoralSession(entry, expectedNaId, expectedZncaVersion = nxapiAuthSession?.zncaVersion || null) {
    const session = entry?.session || entry;
    const expiresAt = Number(entry?.expiresAt || session?.nsoWebapp?.coralExpiresAt || 0);
    const sessionVersion = String(entry?.zncaVersion || session?.nsoWebapp?.zncaVersion || '');
    const requiredVersion = validZncaVersion(expectedZncaVersion) ? expectedZncaVersion : (validZncaVersion(sessionVersion) ? sessionVersion : '3.4.1');
    return Boolean(
        requiredVersion &&
        session?.result?.webApiServerCredential?.accessToken &&
        expiresAt > Date.now() + 60000 &&
        (!expectedNaId || String(session?.nsoWebapp?.naId || '') === String(expectedNaId)) &&
        (!expectedZncaVersion || sessionVersion === requiredVersion)
    );
}

async function generateCoralViaTokenBroker({ idToken, naId, language, country, birthday }) {
    const zncaVersion = typeof activeZncaVersion === 'function'
        ? activeZncaVersion()
        : (typeof ZNCA_VERSION === 'string' ? ZNCA_VERSION : '3.4.1');

    console.log('%c[coral:f1]%c Generating Coral session token (Method 1: Account Login)', "color: #3b82f6; font-weight: bold", "color: inherit");
    const response = await fetch(`${WORKER_URL}/api/nso/cache/coral/get-or-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            clientId: tokenBrokerClientId(),
            idToken,
            naId,
            language,
            country,
            birthday,
            zncaVersion
        })
    });

    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (response.status === 429) {
        const until = parseRetryAfter(response.headers.get('Retry-After')) || (Date.now() + 60000);
        setRateLimitUntil('f1', until);
    }
    if (response.status === 401 && data?.error === 'nxapi_invalid_token') {
        clearNxapiAuthSession();
    }
    if (response.status === 406 || data?.error === 'nxapi_unsupported_version') {
        clearNxapiZncaConfig();
        clearNxapiAuthSession();
    }
    if (!response.ok || !validBrokerCoralSession(data?.coral, naId, zncaVersion)) {
        const message = data?.error_description || data?.error || `Cloudflare token broker could not create Coral session`;
        throw new AuthStageError(
            data?.error === 'nxapi_rate_limited' ? 'NXAPI_F_METHOD_1' : 'CORAL_ACCOUNT_LOGIN',
            message,
            null,
            response.status
        );
    }
    return data.coral.session;
}

function releaseTokenBrokerSession(options = {}) {
    const payload = JSON.stringify({ clientId: tokenBrokerClientId() });
    return fetch(`${WORKER_URL}/api/nso/cache/session/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: payload,
        keepalive: options.keepalive === true
    }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Zelda Web Service Manager
// ---------------------------------------------------------------------------
class WebServiceManager {
    constructor() {
        this.tokenCache = new Map();
        this.tokenInFlight = new Map();
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

    getCachedGameWebServiceToken(serviceId) {
        const cached = this.tokenCache.get(String(serviceId));
        if (cached && cached.expiresAt > Date.now() + 60000) {
            return cached.token;
        }
        return null;
    }

    async requestBrokerCachedToken(serviceId, options = {}) {
        const clientId = tokenBrokerClientId();
        if (!clientId) return { unavailable: true };
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        const response = await fetch(`${WORKER_URL}/api/nso/service/token/cache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            signal: options.signal,
            body: JSON.stringify({
                clientId,
                serviceId: String(serviceId),
                coralUserId,
                zncaVersion: activeZncaVersion(),
                forceFresh: options.forceFresh === true
            })
        });
        let data = {};
        try { data = await response.json(); } catch (_) {}
        if (response.ok && data?.tokens && typeof data.tokens === 'object') {
            for (const [id, entry] of Object.entries(data.tokens)) {
                if (entry?.token) {
                    this.tokenCache.set(String(id), {
                        token: String(entry.token),
                        expiresAt: Number(entry.expiresAt || (Date.now() + 7200 * 1000))
                    });
                }
            }
            this.savePersistentGameTokens();
        }
        if (response.ok && data?.token?.token) {
            return { token: data.token.token, expiresAt: Number(data.token.expiresAt || 0), source: data.source || 'cache' };
        }
        if ((response.ok && data?.miss === true) || (response.status === 404 && data?.error === 'cache_miss')) return { miss: true };
        if (response.status === 401 && data?.error === 'broker_session_missing') return { unavailable: true };
        const error = new Error(data?.error_description || data?.error || `Cloudflare token cache failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
    }

    async requestBrokerGeneratedToken(serviceId, traceId, options = {}) {
        const clientId = tokenBrokerClientId();
        if (!clientId) return { unavailable: true };
        const coralToken = coralAccessToken();
        const naId = userSession?.nsoWebapp?.naId;
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        if (!coralToken || !naId) return { unavailable: true };

        const zncaVersion = activeZncaVersion();
        const isExtension = window.nsoBackendMode === 'extension';
        const providerLabel = isExtension ? 'nxapi method 2' : 'Worker native f2';
        console.log(`%c[coral:f2]%c Generating GameWebServiceToken for service ${serviceId} via ${providerLabel}`, "color: #3b82f6; font-weight: bold", "color: inherit");

        const response = await fetch(`${WORKER_URL}/api/nso/service/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            signal: options.signal,
            body: JSON.stringify({
                clientId,
                serviceId: String(serviceId),
                coralAccessToken: coralToken,
                naId: String(naId),
                coralUserId,
                zncaVersion,
                serviceIds: [String(serviceId), "4834290508791808", "5598642853249024", "4953919198265344", "5935781783175168", "5741031244955648"],
                forceFresh: options.forceFresh === true
            })
        });

        let data = {};
        try { data = await response.json(); } catch (_) {}
        if (response.ok && data?.token?.token) {
            return { token: data.token.token, expiresAt: Number(data.token.expiresAt || 0), source: data.source || 'generated' };
        }
        if (response.status === 401 && data?.error === 'broker_session_missing') return { unavailable: true };
        if (response.status === 401 && data?.error === 'nxapi_invalid_token') clearNxapiAuthSession();
        if (response.status === 429) {
            const until = parseRetryAfter(response.headers.get('Retry-After')) || (Date.now() + 60000);
            setRateLimitUntil('f2', until);
        }

        const message = data?.error_description || data?.error || `Cloudflare token broker failed (HTTP ${response.status}).`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    async getGameWebServiceTokenCanonical(serviceId, traceId, options = {}) {
        const token = coralAccessToken();
        if (!token) throw new Error('No Coral access token available. Please sign in again.');
        const naId = userSession?.nsoWebapp?.naId;
        if (!naId) throw new Error('Nintendo Account ID missing in session. Please sign out and sign in again.');
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');

        console.log(`%c[coral:f2:fallback]%c Generating GameWebServiceToken for service ${serviceId} via client fallback`, "color: #ec4899; font-weight: bold", "color: inherit");
        const attestation = await nxapiGenerateF(2, token, {
            na_id: naId,
            coral_user_id: coralUserId
        }, { signal: options.signal });

        const url = 'https://api-lp1.znc.srv.nintendo.net/v4/Game/GetWebServiceToken';
        const requestBody = JSON.stringify({
            parameter: {
                id: Number(serviceId),
                registrationToken: '',
                f: attestation.f,
                timestamp: attestation.timestamp,
                requestId: attestation.requestId
            }
        });

        const encrypted = await nxapiEncryptRequest(url, token, requestBody, { signal: options.signal });
        const resp = await proxyFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                Accept: 'application/octet-stream,application/json',
                Authorization: `Bearer ${token}`,
                'User-Agent': zncaUserAgent(),
                'X-Platform': ZNCA_PLATFORM,
                'X-ProductVersion': activeZncaVersion()
            },
            bodyBase64: encrypted,
            signal: options.signal
        });

        const data = await parseCoralResponse(resp, { signal: options.signal });
        const result = data?.result;
        if (!result?.accessToken) throw new Error('Nintendo did not return a valid GameWebServiceToken.');
        const expiresInSec = Number.isFinite(Number(result.expiresIn)) ? Number(result.expiresIn) : 7200;
        return {
            token: result.accessToken,
            expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000,
            source: 'canonical_fallback'
        };
    }

    async getGameWebServiceToken(serviceId, traceId = 'tr_zelda', forceFresh = false, options = {}) {
        const idStr = String(serviceId);
        if (!forceFresh) {
            const cached = this.getCachedGameWebServiceToken(idStr);
            if (cached) {
                console.log(`%c[GWS:Cache HIT]%c Reusing cached token for service ${idStr}`, "color: #10b981; font-weight: bold", "color: inherit");
                return cached;
            }
        }

        const existingFlight = this.tokenInFlight.get(idStr);
        if (existingFlight) return await existingFlight.promise;

        const fetchPromise = (async () => {
            let result;
            if (!forceFresh) {
                result = await this.requestBrokerCachedToken(idStr, { signal: options.signal, forceFresh: false });
            } else {
                result = { miss: true };
            }

            if (!result?.token && !result?.unavailable) {
                console.log(`%c[GWS:Cache MISS]%c Requesting token for service ${idStr}...`, "color: #f59e0b; font-weight: bold", "color: inherit");
                result = await this.requestBrokerGeneratedToken(idStr, traceId, {
                    signal: options.signal,
                    forceFresh
                });
            }

            if (!result?.token && result?.unavailable) {
                result = await this.getGameWebServiceTokenCanonical(idStr, traceId, options);
            }

            if (!result?.token) throw new Error('Could not obtain a GameWebServiceToken.');

            this.tokenCache.set(idStr, {
                token: result.token,
                expiresAt: Number(result.expiresAt || (Date.now() + 2 * 60 * 60 * 1000))
            });
            this.savePersistentGameTokens();
            return result.token;
        })();

        const flight = { promise: fetchPromise };
        this.tokenInFlight.set(idStr, flight);
        try {
            return await fetchPromise;
        } finally {
            if (this.tokenInFlight.get(idStr) === flight) this.tokenInFlight.delete(idStr);
        }
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

            const createResp = await fetch(`${WORKER_URL}/api/nso/service/session/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
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
        });
    }

    initPostMessageListener() {
        window.addEventListener('message', async (event) => {
            const workerOrigin = new URL(WORKER_URL).origin;
            const isNintendoOrigin = typeof event.origin === 'string' && (
                event.origin.endsWith('.srv.nintendo.net') ||
                event.origin.endsWith('.nintendo.net') ||
                event.origin.endsWith('.nintendo.com')
            );
            const isExtensionMode = window.nsoBackendMode === 'extension';
            if (event.origin !== workerOrigin && !(isExtensionMode && isNintendoOrigin)) return;

            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (
                data.type === 'NSO_CLOSE_WEBVIEW' ||
                data.type === 'close' ||
                (data.type === 'NSO_ZNCA_BRIDGE_EVENT' && (data.action === 'closeWebView' || data.action === 'close'))
            ) {
                console.log('[ZeldaNotesPlus] Received closeWebView message from Zelda Notes webview');
                document.getElementById('inAppGameWebview')?.classList.add('hidden');
                document.getElementById('loginGate')?.classList.remove('hidden');
                return;
            }

            if (data.type === 'NSO_LOGOUT') {
                console.log('[ZeldaNotesPlus] Received explicit logout message');
                await performLogout();
                return;
            }

            if (data.type === 'completeLoading' || data.type === 'serviceReady' || data.type === 'NSO_COMPLETE_LOADING') {
                document.getElementById('gwsNativeLoading')?.classList.add('is-complete');
                setTimeout(() => document.getElementById('gwsNativeLoading')?.classList.add('hidden'), 150);
            }

            if (data.type === 'getGameWebToken' || data.type === 'requestTokenRefresh' || data.type === 'NSO_REQUEST_GAME_WEB_TOKEN') {
                try {
                    const freshToken = await this.getGameWebServiceToken(ZELDA_SERVICE_ID, 'tr_refresh', true);
                    const frame = document.getElementById('inAppGameWebviewFrame');
                    frame?.contentWindow?.postMessage({
                        type: 'gameWebTokenResponse',
                        requestId: data.requestId,
                        token: freshToken,
                        isZelda: true
                    }, (window.nsoBackendMode === 'extension' ? '*' : workerOrigin));
                } catch (e) {
                    console.warn('[Bridge] Token refresh error:', e);
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Authentication & Session Management
// ---------------------------------------------------------------------------
function hasRememberedAccount() {
    const rememberedFlag = localStorage.getItem('nso_has_remembered_account') === 'true';
    const rememberedExpiresAt = Number(localStorage.getItem('nso_remember_expires_at') || 0);
    if (rememberedFlag && rememberedExpiresAt > 0 && rememberedExpiresAt <= Date.now()) {
        localStorage.removeItem('nso_has_remembered_account');
        localStorage.removeItem('nso_remember_expires_at');
        return false;
    }
    return rememberedFlag && (rememberedExpiresAt <= 0 || rememberedExpiresAt > Date.now());
}

function updateRememberedUI() {
    return hasRememberedAccount();
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
                } else {
                    localStorage.removeItem('nso_user_session');
                }
            } catch (_) {
                localStorage.removeItem('nso_user_session');
            }
        }
    }

    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const expiresAt = Number(parsed?.nsoWebapp?.coralExpiresAt || 0);
            const token = parsed?.result?.webApiServerCredential?.accessToken;

            if (token && expiresAt > Date.now() + 60000) {
                userSession = parsed;
                applySessionZncaVersion(parsed);
                console.log('%c[Auth:Startup]%c Resumed session -> Launching Zelda Notes directly', 'color: #10b981; font-weight: bold', 'color: inherit');
                window.webServiceManager.launchZeldaNotes();
                return;
            }
        } catch (e) {
            console.warn('[Startup] Invalid cached session structure:', e);
        }
        sessionStorage.removeItem('nso_user_session');
        userSession = null;
    }

    // Show login gate
    document.getElementById('loginGate')?.classList.remove('hidden');
    document.getElementById('inAppGameWebview')?.classList.add('hidden');
}

function setAuthButtonsDisabled(disabled, label = null) {
    const submitGateBtn = document.getElementById('submitAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn');
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const beginSignInBtn = document.getElementById('beginSignInBtn');

    if (submitGateBtn) {
        submitGateBtn.disabled = disabled;
        if (label) submitGateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
        else submitGateBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
    }
    if (pasteAuthGateBtn) pasteAuthGateBtn.disabled = disabled;
    if (oauthGateBtn) {
        oauthGateBtn.disabled = disabled;
        if (disabled) oauthGateBtn.classList.add('disabled');
        else oauthGateBtn.classList.remove('disabled');
    }
    if (beginSignInBtn) beginSignInBtn.disabled = disabled;
}

function setAuthGateHint(_text) {
    // Keep area clean
}

async function performFullAuthentication(options = {}) {
    if (loginInFlight) {
        console.log('[Auth] Authentication already in progress, awaiting active flow.');
        return loginInFlight;
    }

    // Immediately disable buttons BEFORE any await
    setAuthButtonsDisabled(true, 'Signing in...');

    loginInFlight = (async () => {
        const isResume = options.isResume === true;
        try {
            let idToken = null;
            let accessToken = null;
            let longLivedSessionToken = null;

            if (isResume) {
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Resuming your saved Nintendo Account session…');

                let resumeResp;
                try {
                    resumeResp = await fetch(`${WORKER_URL}/api/nso/remember/resume`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    throw new AuthStageError('REMEMBER_RESUME', `Network error contacting remember service: ${e.message}`, e);
                }

                if (!resumeResp.ok) {
                    localStorage.removeItem('nso_has_remembered_account');
                    localStorage.removeItem('nso_remember_expires_at');
                    updateRememberedUI();
                    let errMsg = `HTTP ${resumeResp.status}`;
                    try {
                        const errData = await resumeResp.json();
                        errMsg = errData.error || errMsg;
                    } catch (_) {}
                    throw new AuthStageError('REMEMBER_RESUME', `Remembered session expired or revoked: ${errMsg}`, null, resumeResp.status);
                }

                const resumeData = await resumeResp.json();
                idToken = resumeData.idToken;
                accessToken = resumeData.accessToken;
            } else {
                const input = (options.input || document.getElementById('idTokenGateInput')?.value || '').trim();
                if (!input) {
                    throw new Error('Please paste the redirect URL or session_token string.');
                }

                // Drop failed login retry if input changed
                if (failedLoginRetry?.input !== input) failedLoginRetry = null;

                // Direct JSON Session support
                if (input.startsWith('{') && input.endsWith('}')) {
                    try {
                        const jsonSession = JSON.parse(input);
                        const expiresIn = Number(jsonSession?.result?.webApiServerCredential?.expiresIn || 7200);
                        jsonSession.nsoWebapp = {
                            ...(jsonSession.nsoWebapp || {}),
                            coralExpiresAt: Number(jsonSession?.nsoWebapp?.coralExpiresAt || 0) || Date.now() + expiresIn * 1000,
                            zncaVersion: validZncaVersion(jsonSession?.nsoWebapp?.zncaVersion) ? jsonSession.nsoWebapp.zncaVersion : BUNDLED_ZNCA_VERSION
                        };
                        failedLoginRetry = null;
                        userSession = jsonSession;
                        applySessionZncaVersion(jsonSession);
                        sessionStorage.setItem('nso_user_session', JSON.stringify(jsonSession));
                        window.webServiceManager.launchZeldaNotes();
                        return;
                    } catch (_) {}
                }

                let code = input;
                let returnedState = null;
                if (input.includes('session_token_code=')) {
                    const hashPart = input.split('#')[1] || input.split('?')[1] || input;
                    const urlParams = new URLSearchParams(hashPart);
                    code = urlParams.get('session_token_code') || code;
                    returnedState = urlParams.get('state') || null;
                }

                const retrySessionToken = failedLoginRetry?.input === input
                    ? failedLoginRetry.sessionToken
                    : null;

                const expectedState = localStorage.getItem('nso_auth_state');
                if (returnedState && expectedState && returnedState !== expectedState) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        'OAuth state mismatch. The sign-in response did not match the expected authentication request. Please click "Open Nintendo Sign In" again.'
                    );
                }

                const verifier = localStorage.getItem('nso_pkce_verifier');
                if (!retrySessionToken && !verifier && (input.includes('session_token_code=') || input.length < 120)) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        'PKCE verifier missing. Please click "Open Nintendo Sign In" again to start a new authentication session.'
                    );
                }

                if (retrySessionToken) {
                    longLivedSessionToken = retrySessionToken;
                    setAuthButtonsDisabled(true, 'Signing in...');
                    setAuthGateHint('Retrying Nintendo Account authentication…');
                } else {
                    setAuthButtonsDisabled(true, 'Signing in...');
                    setAuthGateHint('Exchanging session authorization code with Nintendo…');

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
                        throw new AuthStageError(
                            'NINTENDO_SESSION_TOKEN_EXCHANGE',
                            `Nintendo session code exchange failed: ${step1Data.error || step1Data.errorMessage || 'Invalid session_token_code'} (HTTP ${step1Resp.status})`,
                            null,
                            step1Resp.status
                        );
                    }

                    longLivedSessionToken = step1Data.session_token;
                    failedLoginRetry = { input, sessionToken: longLivedSessionToken };
                    localStorage.removeItem('nso_pkce_verifier');
                    localStorage.removeItem('nso_auth_state');
                }

                // Step 2: Exchange session_token -> id_token & access_token
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Requesting Nintendo Account tokens…');

                const step2Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                    },
                    body: JSON.stringify({
                        client_id: CORAL_CLIENT_ID,
                        session_token: longLivedSessionToken,
                        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token'
                    })
                });
                const step2Data = await step2Resp.json().catch(() => ({}));

                if (!step2Resp.ok || !step2Data.id_token) {
                    throw new AuthStageError(
                        'NINTENDO_ID_TOKEN_EXCHANGE',
                        `Nintendo token exchange failed: ${step2Data.error_description || step2Data.error || 'Failed to obtain id_token'} (HTTP ${step2Resp.status})`,
                        null,
                        step2Resp.status
                    );
                }

                idToken = step2Data.id_token;
                accessToken = step2Data.access_token;
            }

            // Step 3: Start token broker session and extract user profile
            setAuthButtonsDisabled(true, 'Signing in...');
            let data = null;
            let brokerReady = false;
            let brokerSession = null;
            let userInfo = null;
            try {
                brokerSession = await startTokenBrokerSession(accessToken);
                brokerReady = true;
                userInfo = brokerSession?.profile || null;
            } catch (error) {
                console.warn('[AccountTokenBroker] Session unavailable; using canonical Coral login path:', error);
            }

            if (!userInfo) {
                const userResp = await proxyFetch('https://api.accounts.nintendo.com/2.0.0/users/me', {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept-Language': 'en-GB',
                        'User-Agent': 'NASDKAPI; Android',
                        'Accept': 'application/json'
                    }
                });
                if (!userResp.ok) {
                    throw new AuthStageError(
                        'NINTENDO_PROFILE',
                        `Failed to retrieve Nintendo Account profile (HTTP ${userResp.status}).`,
                        null,
                        userResp.status
                    );
                }
                userInfo = await userResp.json().catch(() => ({}));
            }

            if (!userInfo?.id || !userInfo?.country || !userInfo?.language || !userInfo?.birthday) {
                throw new AuthStageError(
                    'NINTENDO_PROFILE',
                    'Nintendo Account profile is missing required fields (id, country, language, or birthday).'
                );
            }

            const naId = userInfo.id;
            const language = userInfo.language;
            const naCountry = userInfo.country;
            const naBirthday = userInfo.birthday;

            if (brokerReady && validBrokerCoralSession(brokerSession?.coral, naId)) {
                data = brokerSession.coral.session;
            }

            if (!data) {
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Generating Coral session token…');
                try {
                    data = await generateCoralViaTokenBroker({
                        idToken,
                        naId,
                        language,
                        country: naCountry,
                        birthday: naBirthday
                    });
                    console.log('[AccountTokenBroker] Coral cache filled from method-1 generation.');
                } catch (brokerErr) {
                    if (window.nsoBackendMode === 'extension') {
                        console.warn('[AccountTokenBroker] Broker generation failed; trying fallback:', brokerErr);
                    } else {
                        throw brokerErr;
                    }
                }
            }

            if (!data && window.nsoBackendMode === 'extension') {
                await prepareNxapi();
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Generating Coral attestation f-token with nxapi…');

                let attestation;
                try {
                    attestation = await nxapiGenerateF(1, idToken, { na_id: naId });
                } catch (err) {
                    if (err instanceof AuthStageError) throw err;
                    throw new AuthStageError('NXAPI_F_METHOD_1', `nxapi attestation failed: ${err.message}`, err);
                }

                const { f: fToken, timestamp: timestampMs, requestId } = attestation;

                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Encrypting Coral login request…');

                const coralLoginUrl = 'https://api-lp1.znc.srv.nintendo.net/v4/Account/Login';
                const coralLoginBody = JSON.stringify({
                    parameter: {
                        f: fToken,
                        naIdToken: idToken,
                        timestamp: timestampMs,
                        requestId: requestId,
                        language,
                        naCountry,
                        naBirthday
                    }
                });

                let encryptedLoginBody;
                try {
                    encryptedLoginBody = await nxapiEncryptRequest(coralLoginUrl, null, coralLoginBody);
                } catch (err) {
                    if (err instanceof AuthStageError) throw err;
                    throw new AuthStageError('NXAPI_ENCRYPT_ACCOUNT_LOGIN', `nxapi login encryption failed: ${err.message}`, err);
                }

                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Connecting to Nintendo Switch Online Coral service…');

                const coralResp = await proxyFetch(coralLoginUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Accept': 'application/octet-stream,application/json',
                        'Accept-Language': 'en-GB',
                        'Pragma': 'no-cache',
                        'Cache-Control': 'no-cache',
                        'X-ProductVersion': ZNCA_VERSION,
                        'X-Platform': ZNCA_PLATFORM,
                        'User-Agent': zncaUserAgent()
                    },
                    bodyBase64: encryptedLoginBody
                });

                data = null;
                try {
                    data = await parseCoralResponse(coralResp);
                } catch (err) {
                    throw new AuthStageError('NXAPI_DECRYPT_ACCOUNT_LOGIN', `Could not decrypt Coral response: ${err.message}`, err);
                }

                if (!coralResp.ok || !data?.result) {
                    throw new AuthStageError(
                        'CORAL_ACCOUNT_LOGIN',
                        `Coral login failed (${data?.status || 'Error'}): ${data?.errorMessage || data?.error || 'Authentication rejected'} (HTTP ${coralResp.status})`,
                        null,
                        coralResp.status
                    );
                }
            }

            // Authentication succeeded! Derive expiresAt
            const expiresInSec = Number(data.result?.webApiServerCredential?.expiresIn || 7200);
            const brokerExpiresAt = Number(data?.nsoWebapp?.coralExpiresAt || 0);
            data.nsoWebapp = {
                ...(data.nsoWebapp || {}),
                idToken,
                sessionToken: longLivedSessionToken,
                naId,
                zncaVersion: validZncaVersion(data?.nsoWebapp?.zncaVersion)
                    ? data.nsoWebapp.zncaVersion
                    : activeZncaVersion(),
                coralExpiresAt: brokerExpiresAt > Date.now()
                    ? brokerExpiresAt
                    : Date.now() + expiresInSec * 1000
            };
            userSession = data;
            applySessionZncaVersion(data);
            bindNxapiCoralContext(naId, activeZncaVersion(data));
            sessionStorage.setItem('nso_user_session', JSON.stringify(data));

            // Persist Remember Me ONLY after complete Coral Account/Login flow succeeds!
            const rememberCheckbox = document.getElementById('rememberMeCheckbox');
            const shouldRemember = rememberCheckbox?.checked === true;

            if (isResume) {
                if (hasRememberedAccount()) {
                    localStorage.setItem('nso_user_session', JSON.stringify(data));
                }
                updateRememberedUI();
            } else if (shouldRemember && longLivedSessionToken) {
                try {
                    setAuthGateHint('Saving encrypted session on server…');
                    const remResp = await fetch(`${WORKER_URL}/api/nso/remember/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ sessionToken: longLivedSessionToken })
                    });
                    if (remResp.ok) {
                        const rememberData = await remResp.json().catch(() => ({}));
                        const rememberExpiresAt = Number(rememberData.expiresAt || 0);
                        if (rememberExpiresAt > Date.now()) {
                            localStorage.setItem('nso_has_remembered_account', 'true');
                            localStorage.setItem('nso_remember_expires_at', String(rememberExpiresAt));
                            localStorage.setItem('nso_user_session', JSON.stringify(data));
                        } else {
                            localStorage.removeItem('nso_has_remembered_account');
                            localStorage.removeItem('nso_remember_expires_at');
                        }
                        updateRememberedUI();
                    } else {
                        const err = await remResp.json().catch(() => ({}));
                        console.warn('[RememberMe] Save rejected:', err.error);
                    }
                } catch (e) {
                    console.warn('[RememberMe] Save error:', e);
                }
            } else {
                localStorage.removeItem('nso_has_remembered_account');
                localStorage.removeItem('nso_remember_expires_at');
                localStorage.removeItem('nso_user_session');
                localStorage.removeItem('nso_gws_tokens');
                try {
                    await fetch(`${WORKER_URL}/api/nso/remember/forget`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    console.warn('[RememberMe] Could not revoke an older remember grant:', e);
                }
                updateRememberedUI();
            }

            failedLoginRetry = null;
            pendingRememberedResume = false;
            document.getElementById('loginWorkflow')?.classList.remove('remembered-consent-only');
            setAuthGateHint('');

            // Launch Zelda Notes directly!
            window.webServiceManager.launchZeldaNotes();
        } catch (err) {
            if (isResume && err instanceof AuthStageError && err.stage === 'NXAPI_AUTH' && !hasNxapiConsent()) {
                pendingRememberedResume = true;
                const workflow = document.getElementById('loginWorkflow');
                workflow?.classList.add('remembered-consent-only');
                workflow?.classList.remove('hidden');
                document.getElementById('beginSignInBtn')?.classList.add('hidden');
                workflow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            if (!userSession) releaseTokenBrokerSession({ keepalive: true });
            console.error('[Auth Error]', err);
            const displayMsg = userFacingErrorMessage(err, 'Sign in failed. Please try again.');
            alert(displayMsg);
            setAuthGateHint(displayMsg);
        } finally {
            loginInFlight = null;
            setAuthButtonsDisabled(false);
        }
    })();

    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
        setAuthButtonsDisabled(false);
    }
}

// ---------------------------------------------------------------------------
// Nintendo OAuth Popup Flow
// ---------------------------------------------------------------------------
async function openNintendoOAuth(e) {
    if (e) e.preventDefault();
    const nxapiConsentCheckbox = document.getElementById('nxapiConsentCheckbox');
    if (window.nsoBackendMode === 'extension' && nxapiConsentCheckbox && !nxapiConsentCheckbox.checked) {
        const nxapiDisclosure = document.getElementById('nxapiDisclosure');
        nxapiDisclosure?.classList.add('needs-consent');
        nxapiConsentCheckbox.focus();
        nxapiConsentCheckbox.reportValidity?.();
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
        alert(userFacingErrorMessage(err, 'Failed to open Nintendo sign in.'));
    }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
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
        await fetch(`${WORKER_URL}/api/nso/remember/forget`, { method: 'POST', credentials: 'include' }).catch(() => {});
        await releaseTokenBrokerSession({ keepalive: true });
    } catch (_) {}

    userSession = null;
    failedLoginRetry = null;
    pendingRememberedResume = false;
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
    document.getElementById('loginWorkflow')?.classList.remove('remembered-consent-only');

    setAuthButtonsDisabled(false);
}

window.performLogout = performLogout;
window.webServiceManager = new WebServiceManager();

// ---------------------------------------------------------------------------
// DOM Event Listeners & Gate Initialization
// ---------------------------------------------------------------------------
function initAuthGate() {
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const submitGateBtn = document.getElementById('submitAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn') || document.getElementById('pasteTokenBtn');
    const beginSignInBtn = document.getElementById('beginSignInBtn');
    const loginWorkflow = document.getElementById('loginWorkflow');
    const authInput = document.getElementById('idTokenGateInput');
    const nxapiConsentCheckbox = document.getElementById('nxapiConsentCheckbox');
    const nxapiDisclosure = document.getElementById('nxapiDisclosure');
    const closeWebviewBtn = document.getElementById('closeWebviewBtn');

    const requireNxapiConsent = () => {
        if (window.nsoBackendMode !== 'extension') return true;
        if (nxapiConsentCheckbox?.checked) {
            nxapiDisclosure?.classList.remove('needs-consent');
            return true;
        }
        nxapiDisclosure?.classList.add('needs-consent');
        nxapiConsentCheckbox?.focus();
        nxapiConsentCheckbox?.reportValidity?.();
        return false;
    };

    nxapiConsentCheckbox?.addEventListener('change', () => {
        nxapiDisclosure?.classList.toggle('needs-consent', !nxapiConsentCheckbox.checked);
    });

    let pasteDebounceTimer = null;
    const continueWithPastedRedirect = () => {
        if (pasteDebounceTimer) clearTimeout(pasteDebounceTimer);
        pasteDebounceTimer = setTimeout(() => {
            const value = authInput?.value.trim() || '';
            if (!value || !(value.includes('session_token_code=') || value.startsWith('eyJ') || value.startsWith('{') || value.length >= 30)) return;
            if (!requireNxapiConsent()) return;
            performFullAuthentication({ input: value });
        }, 300);
    };

    if (beginSignInBtn) {
        beginSignInBtn.addEventListener('click', () => {
            if (hasRememberedAccount()) {
                pendingRememberedResume = true;
                performFullAuthentication({ isResume: true });
                return;
            }

            pendingRememberedResume = false;
            loginWorkflow?.classList.remove('remembered-consent-only');
            loginWorkflow?.classList.remove('hidden');
            beginSignInBtn.classList.add('hidden');
            loginWorkflow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    if (authInput) {
        authInput.addEventListener('paste', continueWithPastedRedirect);
        authInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!requireNxapiConsent()) return;
                performFullAuthentication({ input: authInput.value.trim() });
            }
        });
    }

    if (pasteAuthGateBtn) {
        pasteAuthGateBtn.addEventListener('click', async () => {
            try {
                const clipboardText = await navigator.clipboard.readText();
                if (!clipboardText) throw new Error('Your clipboard is empty.');
                if (authInput) authInput.value = clipboardText.trim();
                continueWithPastedRedirect();
            } catch (e) {
                setAuthGateHint(`${e.message} Paste the link into the box manually.`);
                authInput?.focus();
            }
        });
    }

    if (oauthGateBtn) {
        oauthGateBtn.addEventListener('click', openNintendoOAuth);
    }

    if (submitGateBtn) {
        submitGateBtn.addEventListener('click', () => {
            if (!requireNxapiConsent()) return;
            if (pendingRememberedResume && hasRememberedAccount()) {
                performFullAuthentication({ isResume: true });
                return;
            }
            const input = authInput?.value.trim() || '';
            performFullAuthentication({ input });
        });
    }

    if (closeWebviewBtn) {
        closeWebviewBtn.addEventListener('click', () => {
            performLogout();
        });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await nsoDetectBackend();
    initAuthGate();
    updateRateLimitBanner();

    // Register Service Worker for runtime caching
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).then(() => {
            console.log('%c[SW]%c Zelda Notes Plus Service Worker registered', 'color: #10b981; font-weight: bold', 'color: inherit');
        }).catch((err) => {
            console.warn('[SW] Registration failed:', err);
        });
    }

    // Check startup cache or saved session
    checkStartupSession();
});
