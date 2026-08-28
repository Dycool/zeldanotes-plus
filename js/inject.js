/**
 * Zelda Notes Plus - Menu Logout Runtime
 * Replaces "Close ZELDA NOTES" with "Log Out" in the 3-dots menu and triggers complete logout on click.
 */

(function initZeldaLogoutTransformer() {
    'use strict';

    if (window.__zeldaLogoutTransformerInjected) return;
    window.__zeldaLogoutTransformerInjected = true;

    function isCloseText(raw) {
        if (!raw || typeof raw !== 'string') return false;
        const trimmed = raw.trim();
        return trimmed === 'Close ZELDA NOTES' ||
            trimmed === 'Close Zelda Notes' ||
            /close\s*zelda\s*notes/i.test(trimmed) ||
            trimmed === 'ZELDA NOTESを閉じる' ||
            trimmed === 'Fermer ZELDA NOTES' ||
            trimmed === 'Cerrar ZELDA NOTES' ||
            trimmed === 'Fechar o ZELDA NOTES' ||
            trimmed === 'Chiudi ZELDA NOTES';
    }

    function triggerHostLogout() {
        console.log('[ZeldaNotesPlus] In-App Log Out clicked -> executing logout');
        try {
            if (window.parent && typeof window.parent.performLogout === 'function') {
                window.parent.performLogout();
            } else {
                window.parent.postMessage({ type: 'NSO_LOGOUT' }, '*');
                window.parent.postMessage({ type: 'NSO_CLOSE_WEBVIEW' }, '*');
            }
        } catch (_) {
            window.parent.postMessage({ type: 'NSO_LOGOUT' }, '*');
        }
    }

    function replaceCloseWithLogout() {
        const menuItems = document.querySelectorAll('[role="menuitem"], [role="button"], button, a, div, span');
        for (const el of menuItems) {
            const rawText = (el.innerText || el.textContent || '').trim();
            if (!isCloseText(rawText) && !/close\s*zelda\s*notes/i.test(rawText)) continue;

            // Only modify leaf or innermost matching container
            const hasMatchingChild = Array.from(el.children).some(child => {
                const cText = (child.innerText || child.textContent || '').trim();
                return isCloseText(cText) || /close\s*zelda\s*notes/i.test(cText);
            });
            if (hasMatchingChild) continue;

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
                }
            }

            if (!replacedAny && el.children.length === 0 && isCloseText(rawText)) {
                el.textContent = 'Log Out';
            }

            const targetClickable = el.closest('[role="menuitem"], [role="button"], button, a') || el;
            if (!targetClickable.dataset.zeldaLogoutAttached) {
                targetClickable.dataset.zeldaLogoutAttached = 'true';
                targetClickable.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    triggerHostLogout();
                }, true); // Capture phase
            }
        }
    }

    // Global capture-phase click handler delegation for instantaneous logout
    window.addEventListener('click', (e) => {
        const item = e.target.closest('[role="menuitem"], [role="button"], button, a');
        if (item) {
            const text = (item.innerText || item.textContent || '').trim();
            if (isCloseText(text) || text === 'Log Out' && item.dataset.zeldaLogoutAttached === 'true') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                triggerHostLogout();
            }
        }
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', replaceCloseWithLogout);
    } else {
        replaceCloseWithLogout();
    }

    const observer = new MutationObserver(() => {
        replaceCloseWithLogout();
    });

    try {
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    } catch (_) {}

    window.addEventListener('click', () => {
        setTimeout(replaceCloseWithLogout, 0);
        setTimeout(replaceCloseWithLogout, 50);
        setTimeout(replaceCloseWithLogout, 150);
    }, true);
    window.addEventListener('pointerdown', () => setTimeout(replaceCloseWithLogout, 0), true);
})();
