// Preload script
const { contextBridge, ipcRenderer, webFrame, clipboard, nativeImage } = require('electron');

const mainEventListeners = new Map();
let mainEventListenerId = 0;
let cachedSettings = null;
let cachedProviderState = null;
let _cacheFolderPromise = null;
const _pbReadyListeners = [];

function cloneSettings(settings) {
    try {
        return JSON.parse(JSON.stringify(settings || {}));
    } catch {
        return {};
    }
}

function refreshCachedSettings() {
    try {
        const settings = ipcRenderer.sendSync('get-settings-sync');
        if (settings && typeof settings === 'object') {
            cachedSettings = settings;
        }
    } catch {
        if (!cachedSettings) cachedSettings = {};
    }
    return cloneSettings(cachedSettings);
}

function cloneProviderState(state) {
    try {
        return JSON.parse(JSON.stringify(state || {}));
    } catch {
        return {};
    }
}

function refreshCachedProviderState() {
    try {
        const state = ipcRenderer.sendSync('get-provider-state-sync');
        if (state && typeof state === 'object') {
            cachedProviderState = state;
        }
    } catch {
        if (!cachedProviderState) cachedProviderState = {};
    }
    return cloneProviderState(cachedProviderState);
}

function normalizeRegexContractList(value) {
    if (!Array.isArray(value)) return [];
    const normalized = [];
    for (const item of value) {
        const source = typeof item?.source === 'string' ? item.source.trim() : '';
        if (!source) continue;
        const flags = typeof item?.flags === 'string' ? item.flags : '';
        normalized.push({ source, flags });
    }
    return normalized;
}

cachedSettings = refreshCachedSettings();
cachedProviderState = refreshCachedProviderState();

function dispatchMainEvent(data, options = {}) {
    if (data?.type === 'settings-updated' && data.payload && typeof data.payload === 'object') {
        cachedSettings = data.payload;
    }
    if (data?.type === 'provider-state-updated' && data.payload && typeof data.payload === 'object') {
        cachedProviderState = data.payload;
    }

    for (const listener of mainEventListeners.values()) {
        try {
            listener(data);
        } catch (error) {
            console.error('[MainEventListenerError]', error);
        }
    }

    try {
        window.dispatchEvent(new CustomEvent('csc-main-event', { detail: data }));
    } catch (error) {
        // Ignore dispatch errors in restricted contexts
    }

    if (data?.type === 'csc-pb-ready') {
        for (const fn of _pbReadyListeners) { try { fn(); } catch (e) {} }
    }

    if (options.forwardToChildren === false) return;
    if (data?.type !== 'renderer-command' && data?.type !== 'csc-pb-ready') return;
    let childFrames = null;
    try {
        childFrames = window.frames;
    } catch {
        childFrames = null;
    }
    if (!childFrames || typeof childFrames.length !== 'number' || childFrames.length === 0) return;

    for (let i = 0; i < childFrames.length; i += 1) {
        const child = childFrames[i];
        if (!child || typeof child.postMessage !== 'function') continue;
        try {
            child.postMessage({ __cscRelayMainEvent: true, data }, '*');
        } catch {
            // Ignore postMessage failures in restricted cross-origin frames.
        }
    }
}

ipcRenderer.on('main-event', (event, data) => {
    dispatchMainEvent(data);
});

window.addEventListener('message', event => {
    if (event?.source !== window.parent) return;
    const payload = event?.data;
    if (!payload || payload.__cscRelayMainEvent !== true) return;
    dispatchMainEvent(payload.data);
});

// Expose safe APIs to the renderer process (the web pages)
contextBridge.exposeInMainWorld('electronAPI', {
    runCommand: (command, payload) =>
        ipcRenderer
            .invoke('run-command', { command, payload })
            .catch(error => ({
                ok: false,
                error: 'IPC_FAILURE',
                message: error?.message || String(error)
            })),
    onMainEvent: (callback) => {
        if (typeof callback !== 'function') return null;
        const listenerId = ++mainEventListenerId;
        mainEventListeners.set(listenerId, callback);
        return listenerId;
    },
    offMainEvent: (listenerId) => {
        if (typeof listenerId !== 'number') return false;
        return mainEventListeners.delete(listenerId);
    },
    getSettings: () => cloneSettings(cachedSettings),
    refreshSettings: () => refreshCachedSettings(),
    updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch).catch(() => null),
    setSetting: (path, value) => ipcRenderer.invoke('set-setting', { path, value }).catch(() => null),
    sendNotification: (title, message) =>
        ipcRenderer.invoke('show-notification', { title, body: message, type: null }).catch(() => null),
    showNotification: (title, body, type) =>
        ipcRenderer.invoke('show-notification', { title, body, type }).catch(() => null),
    setGameProvider: (data) => ipcRenderer.invoke('set-game-provider', data).catch(() => null),
    getGameProviderState: () => ipcRenderer.invoke('get-provider-state').catch(() => cloneProviderState(cachedProviderState)),
    refreshGameProviderState: () => refreshCachedProviderState(),
    clearProviderState: (payload) => ipcRenderer.invoke('clear-provider-state', payload).catch(() => null),
    markProviderSuccess: (payload) => ipcRenderer.invoke('mark-provider-success', payload).catch(() => null),
    getProviderLanguagePreference: (provider) =>
        ipcRenderer.invoke('get-provider-language-preference', provider).catch(() => null),
    setProviderLanguagePreference: (provider, lang) =>
        ipcRenderer.invoke('set-provider-language-preference', { provider, lang }).catch(() => false),
    getCustomScripts: () => ipcRenderer.invoke('get-custom-scripts').catch(() => []),
    updateTrayStatus: (data) => ipcRenderer.send('set-tray-status', data),
    getProxyPort: () => ipcRenderer.invoke('get-proxy-port'),
    getFontOverrideCss: () => ipcRenderer.invoke('get-font-override-css').catch(() => ''),
    setCacheConfig: (data) => ipcRenderer.send('set-cache-config', data),
    getCacheFolder: () => {
        if (!_cacheFolderPromise) {
            _cacheFolderPromise = ipcRenderer.invoke('get-cache-folder').catch(() => null);
        }
        return _cacheFolderPromise;
    },
    getRuntimeConfig: () => {
        try {
            return ipcRenderer.sendSync('get-runtime-config-sync');
        } catch {
            return {};
        }
    },
    setZoomLevel: (level) => webFrame.setZoomLevel(level),
    getZoomLevel: () => webFrame.getZoomLevel(),
    copyImageToClipboard: (dataUrl) => {
        try {
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
            const image = nativeImage.createFromDataURL(dataUrl);
            if (!image || image.isEmpty()) return false;
            clipboard.writeImage(image);
            return true;
        } catch {
            return false;
        }
    },
    decodeMsgpack: (arrayBuffer) => {
        try {
            if (!arrayBuffer) return null;
            return ipcRenderer.sendSync('decode-msgpack-sync', arrayBuffer);
        } catch (e) {
            return null;
        }
    },
    getMobileNotifySettings: () => ipcRenderer.invoke('get-mobile-notify-settings').catch(() => null),
    setMobileNotifySettings: (data) => ipcRenderer.invoke('set-mobile-notify-settings', data).catch(() => null),
    getProxySettings: () => ipcRenderer.invoke('get-proxy-settings').catch(() => null),
    setProxySettings: (settings) => ipcRenderer.invoke('set-proxy-settings', settings).catch(() => false),
    getFontOverrideSettings: () => ipcRenderer.invoke('get-font-override-settings').catch(() => null),
    setFontOverrideSettings: (settings) => ipcRenderer.invoke('set-font-override-settings', settings).catch(() => false),
    selectFontOverrideFile: () => ipcRenderer.invoke('select-font-override-file').catch(() => null),
    onPbReady: (fn) => { if (typeof fn === 'function') _pbReadyListeners.push(fn); }
});

// ====== Phase 2 & 3: Iframe Stripping + Canvas Injection + Cache Polyfill ======
// Inject a script into the real page world on every page load.
window.addEventListener('DOMContentLoaded', () => {
    const providerState = refreshCachedProviderState();
    const providerName = String(providerState?.provider || '').toLowerCase();
    const defaultProvider = String(providerState?.defaultProvider || '').toLowerCase();
    const entryUrl = String(providerState?.entryUrl || '');
    const shellStripEnabled = true;
    const isSubframe = window.top !== window;

    if (isSubframe && !shellStripEnabled) {
        return;
    }
    const providerRegexContract = {
        loginRegex: normalizeRegexContractList(providerState?.loginRegex),
        pageRegex: normalizeRegexContractList(providerState?.pageRegex),
        gameRegex: normalizeRegexContractList(providerState?.gameRegex),
        wrapperRegex: normalizeRegexContractList(providerState?.wrapperRegex)
    };
    if (defaultProvider === 'dmm' || defaultProvider === 'fanza') {
        const legacyBroadDmmGadgetSource = 'gg-dmm-gadgets\\.crave-saga\\.net';
        providerRegexContract.gameRegex = providerRegexContract.gameRegex.filter(
            item => !(item && typeof item.source === 'string' && item.source === legacyBroadDmmGadgetSource)
        );
        const dmmGadgetGameRegexSource = 'https:\\/\\/gg-dmm-gadgets\\.crave-saga\\.net';
        const hasDmmGadgetGameRegex = providerRegexContract.gameRegex.some(
            item => item && typeof item.source === 'string' && item.source === dmmGadgetGameRegexSource
        );
        if (!hasDmmGadgetGameRegex) {
            providerRegexContract.gameRegex.push({
                source: dmmGadgetGameRegexSource,
                flags: 'i'
            });
        }
    }
    const hasGameRegex = providerRegexContract.gameRegex.length > 0;
    const hasRouteRegex =
        providerRegexContract.pageRegex.length > 0 || providerRegexContract.wrapperRegex.length > 0;
    const currentUrl = window.location.href || '';
    const isSelectorPage = /\/selector\.html(?:[?#]|$)/i.test(currentUrl);
    const isExtensionPage = currentUrl.startsWith('chrome-extension://');
    // 內部 app 工具頁面（file://），不應套用遊戲注入邏輯。
    const isAppInternalPage = currentUrl.startsWith('file://') && /\/notification-settings\.html(?:[?#]|$)/i.test(currentUrl);
    const hasProviderState =
        typeof providerState?.provider === 'string' &&
        providerState.provider.trim() &&
        typeof providerState?.entryUrl === 'string' &&
        providerState.entryUrl.trim() &&
        hasGameRegex &&
        hasRouteRegex;

    if (isAppInternalPage) return;

    if (!hasProviderState && !isSelectorPage && !isExtensionPage) {
        if (isSubframe) return;
        console.warn('[CSC] Provider state is missing. Redirecting to selector.');
        ipcRenderer
            .invoke('run-command', {
                command: 'recover-provider-state',
                payload: { reason: 'provider-missing' }
            })
            .catch(() => null);
        return;
    }

    const isErolabsProvider =
        defaultProvider === 'erolabs' || providerName.includes('erolabs') || /https?:\/\/([^/]+\.)?(ero-labs|erolabs)\./i.test(entryUrl);

    const hasCloudflareWidget =
        !!document.querySelector('iframe[src*="challenges.cloudflare.com"], script[src*="challenges.cloudflare.com"]') ||
        !!document.querySelector('.cf-turnstile, [class*="turnstile"], [id*="turnstile"]');
    const hasPasswordInput = !!document.querySelector('input[type="password"]');
    if (isErolabsProvider && hasCloudflareWidget && hasPasswordInput) {
        console.log('[CSC] EROLABS login verification page detected; skipping page-world injection.');
        return;
    }

    const fontOverrideVersionLiteral = JSON.stringify(providerState?.lang || null);

    const injectedRegexHelpersSource = `
                function checkUrl(url, patterns) {
                    if (!url) return false;
                    for (var i = 0; i < patterns.length; i++) {
                        if (patterns[i].test(url)) return true;
                    }
                    return false;
                }

                function compileRegexContractList(patterns, fieldName, warnInvalid) {
                    var compiled = [];
                    if (!Array.isArray(patterns)) return compiled;
                    for (var i = 0; i < patterns.length; i += 1) {
                        var item = patterns[i];
                        var source = item && typeof item.source === 'string' ? item.source : '';
                        var flags = item && typeof item.flags === 'string' ? item.flags : '';
                        if (!source) continue;
                        try {
                            compiled.push(new RegExp(source, flags));
                        } catch (error) {
                            if (warnInvalid) {
                                var label = fieldName || 'regex';
                                console.warn('[CSC] Invalid provider regex ' + label + '[' + i + '] /' + source + '/' + flags + ':', error);
                            }
                        }
                    }
                    return compiled;
                }
    `;
    const injectedMaskHelpersSource = `
                function markKeepChain(node, keepAttr, shouldApply) {
                    if (!node || !keepAttr) return;
                    if (shouldApply === false) return;
                    var current = node;
                    while (current) {
                        if (current.setAttribute) current.setAttribute(keepAttr, '1');
                        current = current.parentElement;
                    }
                }

                function shouldPreserveShellStripSibling(node) {
                    return !!(node && node.classList && node.classList.contains('cocosEditBox'));
                }

                function hideSiblingsAlongAncestorChain(node, shouldApply) {
                    if (!node) return;
                    if (shouldApply === false) return;
                    var current = node;
                    while (current && current !== document.body) {
                        var parent = current.parentElement;
                        if (!parent) break;
                        for (var i = 0; i < parent.children.length; i++) {
                            var sibling = parent.children[i];
                            if (sibling !== current && !shouldPreserveShellStripSibling(sibling)) {
                                sibling.style.display = 'none';
                            }
                        }
                        current = parent;
                    }
                }
    `;
    const injectedWrapperHelpersSource = `
                function normalizeShellDocument() {
                    document.documentElement.style.margin = '0';
                    document.documentElement.style.overflow = 'hidden';
                    document.documentElement.style.backgroundColor = '#000';
                    document.documentElement.style.height = '100%';
                    document.body.style.margin = '0';
                    document.body.style.overflow = 'hidden';
                    document.body.style.backgroundColor = '#000';
                    document.body.style.height = '100%';
                }

                function pinTargetToViewport(target, positionMode) {
                    if (!target) return;
                    target.style.position = positionMode === 'absolute' ? 'absolute' : 'fixed';
                    target.style.top = '0';
                    target.style.left = '0';
                    target.style.width = '100vw';
                    target.style.height = '100vh';
                    target.style.maxWidth = '100vw';
                    target.style.maxHeight = '100vh';
                    target.style.margin = '0';
                    target.style.border = '0';
                    target.style.zIndex = '2147483647';
                }

                function applyWrapperShellStrip(options) {
                    var config = options && typeof options === 'object' ? options : {};
                    var strictMode = config.strictMode !== false;
                    var keepAttr = typeof config.keepAttr === 'string' && config.keepAttr ? config.keepAttr : 'data-csc-shellstrip-keep';
                    var styleId = typeof config.styleId === 'string' && config.styleId ? config.styleId : 'csc-shellstrip-wrapper-mask-style';
                    var styleText = typeof config.styleText === 'string' ? config.styleText : '';
                    var alwaysRetry = !!config.alwaysRetry;
                    var retryDelay = typeof config.retryDelay === 'number' && config.retryDelay > 0 ? config.retryDelay : 50;
                    var findTarget = typeof config.findTarget === 'function' ? config.findTarget : null;
                    if (!findTarget) return;

                    function ensureStyle() {
                        if (!strictMode) return;
                        if (!styleText) return;
                        if (document.getElementById(styleId)) return;
                        var style = document.createElement('style');
                        style.id = styleId;
                        style.textContent = styleText;
                        (document.head || document.documentElement).appendChild(style);
                    }

                    function tick() {
                        normalizeShellDocument();

                        var target = findTarget();
                        if (target) {
                            ensureStyle();
                            markKeepChain(target, keepAttr, strictMode);
                            hideSiblingsAlongAncestorChain(target, strictMode);
                            pinTargetToViewport(target, strictMode ? 'fixed' : 'absolute');
                        }

                        if (!target || alwaysRetry) {
                            setTimeout(tick, retryDelay);
                        }
                    }

                    tick();
                }
    `;

    const injectedDownloadPathLabelSource = `
                function createPathLabel() {
                    var el = document.createElement('div');
                    el.style.lineHeight = '1.4';
                    el.style.marginTop = '4px';
                    el.style.fontSize = '10px';
                    el.style.color = '#aaa';
                    el.style.wordBreak = 'break-all';
                    return el;
                }

                function getFilenameFromUrl(url) {
                    try {
                        var pathname = new URL(url).pathname;
                        var lastSlash = pathname.lastIndexOf('/');
                        return lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
                    } catch (e) {
                        return '';
                    }
                }
    `;

    if (isSubframe && shellStripEnabled) {
        const subframeScript = document.createElement('script');
        try {
            subframeScript.textContent = `
            (function() {
                var providerRegexContract = ${JSON.stringify(providerRegexContract)};
                var fontOverrideVersion = ${fontOverrideVersionLiteral};
                ${injectedRegexHelpersSource}
                ${injectedMaskHelpersSource}
                ${injectedWrapperHelpersSource}
                ${injectedDownloadPathLabelSource}

                function pickLargestIframe() {
                    var frames = document.querySelectorAll('iframe');
                    var best = null;
                    var bestArea = 0;
                    for (var i = 0; i < frames.length; i += 1) {
                        var frame = frames[i];
                        var rect = frame.getBoundingClientRect();
                        var area = Math.max(0, rect.width) * Math.max(0, rect.height);
                        if (area > bestArea) {
                            best = frame;
                            bestArea = area;
                        }
                    }
                    return best;
                }

                function pickShellTarget() {
                    return (
                        document.querySelector('#game-iframe') ||
                        document.querySelector('#game_frame') ||
                        document.querySelector('iframe[role="application"]') ||
                        document.querySelector('#GameDiv') ||
                        pickLargestIframe()
                    );
                }

                function applyWrapperShellStripForSubframe() {
                    var keepAttr = 'data-csc-shellstrip-subframe-keep';
                    applyWrapperShellStrip({
                        strictMode: true,
                        keepAttr: keepAttr,
                        styleId: 'csc-shellstrip-subframe-mask-style',
                        styleText:
                            'html, body { margin: 0 !important; overflow: hidden !important; background: #000 !important; height: 100% !important; }' +
                            'body *:not([' + keepAttr + ']) { display: none !important; }' +
                            'iframe[' + keepAttr + '], #GameDiv[' + keepAttr + '], canvas[' + keepAttr + '] { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; border: 0 !important; margin: 0 !important; z-index: 2147483647 !important; }',
                        alwaysRetry: true,
                        retryDelay: 250,
                        findTarget: function() {
                            return pickShellTarget();
                        }
                    });
                }

                function sanitizeGame() {
                    var keepAttr = 'data-csc-shellstrip-subframe-game-keep';
                    var styleId = 'csc-shellstrip-subframe-game-mask-style';
                    var activeEditBoxPatch = null;

                    function ensureStyle() {
                        if (document.getElementById(styleId)) return;
                        var style = document.createElement('style');
                        style.id = styleId;
                        style.textContent =
                            'html, body { margin: 0 !important; overflow: hidden !important; background: #000 !important; height: 100% !important; }' +
                            'body *:not([' + keepAttr + ']):not(.cocosEditBox) { display: none !important; }' +
                            '#GameDiv[' + keepAttr + '] { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; margin: 0 !important; border: 0 !important; z-index: 2147483647 !important; }' +
                            '#GameCanvas[' + keepAttr + '], canvas[' + keepAttr + '] { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; margin: 0 !important; border: 0 !important; }';
                        (document.head || document.documentElement).appendChild(style);
                    }

                    function isCocosEditBoxInput(node) {
                        return !!(node && node.classList && node.classList.contains('cocosEditBox'));
                    }

                    function collectCocosEditBoxes() {
                        var boxes = [];
                        try {
                            if (!window.cc || !cc.director || typeof cc.director.getScene !== 'function') return boxes;
                            var scene = cc.director.getScene();
                            function walk(node) {
                                if (!node) return;
                                var components = node._components || [];
                                for (var i = 0; i < components.length; i++) {
                                    var comp = components[i];
                                    var name = (comp && (comp.__classname__ || (comp.constructor && comp.constructor.name))) || '';
                                    if (/EditBox/i.test(name) || (cc.EditBox && comp instanceof cc.EditBox)) {
                                        boxes.push(comp);
                                    }
                                }
                                var children = node.children || [];
                                for (var j = 0; j < children.length; j++) {
                                    walk(children[j]);
                                }
                            }
                            walk(scene);
                        } catch (e) {}
                        return boxes;
                    }

                    function pickCocosEditBoxForInput(input) {
                        var boxes = collectCocosEditBoxes();
                        if (boxes.length === 0) return null;
                        var inputValue = input && typeof input.value === 'string' ? input.value : '';
                        for (var i = 0; i < boxes.length; i++) {
                            if (boxes[i] && boxes[i].string === inputValue) return boxes[i];
                        }
                        for (var j = 0; j < boxes.length; j++) {
                            var labelNode = boxes[j] && boxes[j]._N$textLabel && boxes[j]._N$textLabel.node;
                            if (labelNode && labelNode.active) return boxes[j];
                        }
                        return boxes[0] || null;
                    }

                    function restoreCocosEditBoxPatch() {
                        if (!activeEditBoxPatch) return;
                        var patch = activeEditBoxPatch;
                        activeEditBoxPatch = null;
                        if (patch.input) {
                            if (patch.inputZIndex == null) {
                                patch.input.style.removeProperty('z-index');
                            } else {
                                patch.input.style.zIndex = patch.inputZIndex;
                            }
                            if (patch.inputPosition == null) {
                                patch.input.style.removeProperty('position');
                            } else {
                                patch.input.style.position = patch.inputPosition;
                            }
                        }
                        if (patch.labelNode) {
                            var inputValue = patch.input && typeof patch.input.value === 'string' ? patch.input.value : '';
                            patch.labelNode.active = inputValue.length > 0 ? true : patch.labelActive;
                            patch.labelNode.opacity = patch.labelOpacity;
                        }
                    }

                    function applyCocosEditBoxPatch(input) {
                        if (!isCocosEditBoxInput(input)) return;
                        var box = pickCocosEditBoxForInput(input);
                        var labelNode = box && box._N$textLabel && box._N$textLabel.node;
                        if (activeEditBoxPatch && activeEditBoxPatch.input !== input) {
                            restoreCocosEditBoxPatch();
                        }
                        if (!activeEditBoxPatch) {
                            activeEditBoxPatch = {
                                input: input,
                                inputZIndex: input.style.zIndex || null,
                                inputPosition: input.style.position || null,
                                labelNode: labelNode || null,
                                labelActive: labelNode ? labelNode.active : null,
                                labelOpacity: labelNode ? labelNode.opacity : null
                            };
                        } else if (!activeEditBoxPatch.labelNode && labelNode) {
                            activeEditBoxPatch.labelNode = labelNode;
                            activeEditBoxPatch.labelActive = labelNode.active;
                            activeEditBoxPatch.labelOpacity = labelNode.opacity;
                        }
                        input.style.display = 'block';
                        input.style.position = 'absolute';
                        input.style.zIndex = '2147483647';
                        if (labelNode) {
                            labelNode.active = false;
                        }
                    }

                    function installCocosEditBoxVisibilityBridge() {
                        if (window.__cscCocosEditBoxVisibilityBridgeInstalled) return;
                        window.__cscCocosEditBoxVisibilityBridgeInstalled = true;

                        document.addEventListener('focusin', function(ev) {
                            if (isCocosEditBoxInput(ev && ev.target)) {
                                applyCocosEditBoxPatch(ev.target);
                            }
                        }, true);

                        document.addEventListener('input', function(ev) {
                            if (isCocosEditBoxInput(ev && ev.target)) {
                                applyCocosEditBoxPatch(ev.target);
                            }
                        }, true);

                        document.addEventListener('focusout', function(ev) {
                            if (!isCocosEditBoxInput(ev && ev.target)) return;
                            setTimeout(restoreCocosEditBoxPatch, 0);
                        }, true);

                        document.addEventListener('keydown', function(ev) {
                            if (!isCocosEditBoxInput(document.activeElement)) return;
                            if (ev && (ev.key === 'Enter' || ev.key === 'Escape')) {
                                setTimeout(restoreCocosEditBoxPatch, 0);
                            }
                        }, true);
                    }

                    function tick() {
                        normalizeShellDocument();

                        var background = document.querySelector('#Background');
                        var footer = document.querySelector('#NewsFooter');
                        var gameDiv = document.querySelector('#GameDiv');
                        var gameCanvas = document.querySelector('#GameCanvas') || document.querySelector('canvas');
                        var target = gameCanvas || gameDiv || null;
                        if (target) {
                            if (background) background.style.display = 'none';
                            if (footer) {
                                footer.style.visibility = 'hidden';
                                footer.style.pointerEvents = 'none';
                            }
                            ensureStyle();
                            markKeepChain(target, keepAttr);
                            hideSiblingsAlongAncestorChain(target);
                            pinTargetToViewport(target, 'fixed');
                        }

                        setTimeout(tick, 250);
                    }

                    installCocosEditBoxVisibilityBridge();
                    tick();
                }

                function installSubframeRightClickLongPress() {
                    if (window.__cscSubframeRightClickBridgeInstalled) return;
                    window.__cscSubframeRightClickBridgeInstalled = true;

                    function getGameCanvas() {
                        return document.querySelector('#GameCanvas') || document.querySelector('canvas');
                    }

                    function getLongPressHandler(component) {
                        if (!component) return null;
                        var keys = Object.keys(component);
                        var preferred = ['_onlongpress', '_longpress', '_onlongtap', '_longtap', '_onlongtouch', '_longtouch'];
                        for (var i = 0; i < preferred.length; i++) {
                            var preferredKey = preferred[i];
                            for (var j = 0; j < keys.length; j++) {
                                var exactKey = keys[j];
                                if (!exactKey || exactKey.charAt(0) !== '_') continue;
                                if (exactKey.toLowerCase() !== preferredKey) continue;
                                if (typeof component[exactKey] !== 'function') continue;
                                return component[exactKey];
                            }
                        }
                        for (var k = 0; k < keys.length; k++) {
                            var key = keys[k];
                            if (!key || key.charAt(0) !== '_') continue;
                            if (key.toLowerCase().indexOf('long') < 0) continue;
                            if (typeof component[key] !== 'function') continue;
                            return component[key];
                        }
                        return null;
                    }

                    function getNodeName(node) {
                        return String(node && (node.name || node._name || '') || '');
                    }

                    function getNodeSortZ(node) {
                        var z = Number(node && (node.zIndex != null ? node.zIndex : node._localZOrder));
                        return isFinite(z) ? z : 0;
                    }

                    function getNodeSortOrder(node) {
                        var order = Number(node && node._orderOfArrival);
                        return isFinite(order) ? order : 0;
                    }

                    function getNodeChain(node) {
                        var chain = [];
                        var current = node;
                        var guard = 0;
                        while (current && guard < 64) {
                            chain.unshift(current);
                            current = current.parent || current._parent || null;
                            guard += 1;
                        }
                        return chain;
                    }

                    function compareSceneOrder(a, b) {
                        if (!a || !b || a === b) return 0;
                        var aChain = getNodeChain(a);
                        var bChain = getNodeChain(b);
                        var length = Math.min(aChain.length, bChain.length);
                        var index = 0;
                        while (index < length && aChain[index] === bChain[index]) {
                            index += 1;
                        }
                        var aNode = aChain[index] || a;
                        var bNode = bChain[index] || b;
                        var zDiff = getNodeSortZ(aNode) - getNodeSortZ(bNode);
                        if (zDiff !== 0) return zDiff;
                        return getNodeSortOrder(aNode) - getNodeSortOrder(bNode);
                    }

                    function isModalBlockerNode(node) {
                        if (!node || !node._activeInHierarchy) return false;
                        var name = getNodeName(node).toLowerCase();
                        return name === 'modal' || name === 'modallayer';
                    }

                    function getBlockingModal(selectedCandidate, modalBlockers) {
                        if (!selectedCandidate || !Array.isArray(modalBlockers)) return null;
                        for (var i = 0; i < modalBlockers.length; i++) {
                            var blocker = modalBlockers[i];
                            if (compareSceneOrder(blocker, selectedCandidate.node) >= 0) {
                                return blocker;
                            }
                        }
                        return null;
                    }

                    function autoLongPress(mousePosition) {
                        if (!window.cc || !cc.director || typeof cc.director.getScene !== 'function') return false;
                        var scene = cc.director.getScene();
                        if (!scene) return false;

                        var candidates = [];
                        var modalBlockers = [];

                        function gatherCandidates(node) {
                            if (!node || !node._activeInHierarchy) return;

                            var children = node._children;
                            if (Array.isArray(children)) {
                                for (var i = 0; i < children.length; i++) {
                                    gatherCandidates(children[i]);
                                }
                            }

                            var bbox = null;
                            try {
                                bbox = node.getBoundingBoxToWorld();
                            } catch (e) { return; }
                            if (!bbox || !bbox.contains(mousePosition)) return;
                            if (isModalBlockerNode(node)) {
                                modalBlockers.push(node);
                            }

                            if (!Array.isArray(node._components)) return;
                            for (var j = 0; j < node._components.length; j++) {
                                var component = node._components[j];
                                if (!component) continue;
                                var handler = getLongPressHandler(component);
                                if (typeof handler !== 'function') continue;
                                candidates.push({
                                    node: node,
                                    component: component,
                                    handler: handler,
                                    area: bbox.width * bbox.height,
                                    distSq: Math.pow(bbox.x + bbox.width * 0.5 - mousePosition.x, 2) +
                                            Math.pow(bbox.y + bbox.height * 0.5 - mousePosition.y, 2),
                                });
                                break;
                            }
                        }

                        gatherCandidates(scene);
                        if (candidates.length === 0) return false;

                        candidates.sort(function(a, b) {
                            var areaDiff = a.area - b.area;
                            if (Math.abs(areaDiff) > 100) return areaDiff;
                            return a.distSq - b.distSq;
                        });

                        try {
                            var blockingModal = getBlockingModal(candidates[0], modalBlockers);
                            if (blockingModal) return false;
                            candidates[0].handler.apply(candidates[0].component);
                            return true;
                        } catch (e) {}
                        return false;
                    }

                    function resolveViewportRect(rect, canvas) {
                        var fallback = { x: 0, y: 0, width: rect.width, height: rect.height };
                        if (!window.cc || !cc.view) return fallback;

                        var rawViewport = null;
                        if (cc.view._viewportRect && typeof cc.view._viewportRect === 'object') {
                            rawViewport = cc.view._viewportRect;
                        } else if (typeof cc.view.getViewportRect === 'function') {
                            try {
                                rawViewport = cc.view.getViewportRect();
                            } catch (e) {
                                rawViewport = null;
                            }
                        }

                        var vpX = Number(rawViewport && rawViewport.x);
                        var vpY = Number(rawViewport && rawViewport.y);
                        var vpWidth = Number(rawViewport && rawViewport.width);
                        var vpHeight = Number(rawViewport && rawViewport.height);
                        if (!isFinite(vpX) || !isFinite(vpY) || !isFinite(vpWidth) || !isFinite(vpHeight) || vpWidth <= 0 || vpHeight <= 0) {
                            return fallback;
                        }

                        var canvasPixelWidth = Number(canvas && canvas.width);
                        var canvasPixelHeight = Number(canvas && canvas.height);
                        if (!isFinite(canvasPixelWidth) || canvasPixelWidth <= 0) canvasPixelWidth = rect.width;
                        if (!isFinite(canvasPixelHeight) || canvasPixelHeight <= 0) canvasPixelHeight = rect.height;

                        var scaleX = rect.width / canvasPixelWidth;
                        var scaleY = rect.height / canvasPixelHeight;

                        return {
                            x: vpX * scaleX,
                            y: vpY * scaleY,
                            width: vpWidth * scaleX,
                            height: vpHeight * scaleY
                        };
                    }

                    function resolveVisibleRect() {
                        if (!window.cc || !cc.view) return null;

                        var directVisibleRect = cc.view._visibleRect;
                        var directWidth = Number(directVisibleRect && directVisibleRect.width);
                        var directHeight = Number(directVisibleRect && directVisibleRect.height);
                        if (isFinite(directWidth) && directWidth > 0 && isFinite(directHeight) && directHeight > 0) {
                            return {
                                width: directWidth,
                                height: directHeight
                            };
                        }

                        var visibleSize = null;
                        if (typeof cc.view.getVisibleSize === 'function') {
                            try {
                                visibleSize = cc.view.getVisibleSize();
                            } catch (e) {
                                visibleSize = null;
                            }
                        }
                        if ((!visibleSize || !visibleSize.width || !visibleSize.height) && cc.winSize) {
                            visibleSize = cc.winSize;
                        }

                        var fallbackWidth = Number(visibleSize && visibleSize.width);
                        var fallbackHeight = Number(visibleSize && visibleSize.height);
                        if (!isFinite(fallbackWidth) || fallbackWidth <= 0 || !isFinite(fallbackHeight) || fallbackHeight <= 0) {
                            return null;
                        }

                        return {
                            width: fallbackWidth,
                            height: fallbackHeight
                        };
                    }

                    function handleRightClick(ev) {
                        if (!ev) return false;
                        var runCommand =
                            window.electronAPI && typeof window.electronAPI.runCommand === 'function'
                                ? window.electronAPI.runCommand
                                : null;
                        var gameCanvas = getGameCanvas();
                        function openContextMenu() {
                            if (!runCommand) return;
                            runCommand('openContextMenu');
                        }

                        if (
                            !runCommand ||
                            !gameCanvas ||
                            ev.ctrlKey ||
                            ev.metaKey ||
                            !window.cc ||
                            !cc.view
                        ) {
                            openContextMenu();
                            return false;
                        }

                        var visibleRect = resolveVisibleRect();
                        if (!visibleRect) {
                            openContextMenu();
                            return false;
                        }

                        var rect = gameCanvas.getClientRects()[0];
                        if (!rect || !rect.width || !rect.height) {
                            openContextMenu();
                            return false;
                        }

                        var canvasMousePosition = {
                            x: ev.clientX - rect.left,
                            y: rect.height - (ev.clientY - rect.top)
                        };
                        var viewportRect = resolveViewportRect(rect, gameCanvas);

                        if (
                            canvasMousePosition.x < viewportRect.x ||
                            canvasMousePosition.y < viewportRect.y ||
                            canvasMousePosition.x >= viewportRect.x + viewportRect.width ||
                            canvasMousePosition.y >= viewportRect.y + viewportRect.height
                        ) {
                            openContextMenu();
                            return false;
                        }

                        if (
                            canvasMousePosition.x >= viewportRect.x + viewportRect.width - 64 &&
                            canvasMousePosition.x <= viewportRect.x + viewportRect.width &&
                            canvasMousePosition.y >= viewportRect.y + viewportRect.height - 64 &&
                            canvasMousePosition.y <= viewportRect.y + viewportRect.height
                        ) {
                            openContextMenu();
                            return false;
                        }

                        var sceneMousePosition = {
                            x: ((canvasMousePosition.x - viewportRect.x) / viewportRect.width) * visibleRect.width,
                            y: ((canvasMousePosition.y - viewportRect.y) / viewportRect.height) * visibleRect.height
                        };

                        autoLongPress(sceneMousePosition);
                        return false;
                    }

                    var lastRightMouseDownAt = 0;
                    document.addEventListener('mousedown', function(ev) {
                        if (!ev || ev.button !== 2) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        lastRightMouseDownAt = Date.now();
                        handleRightClick(ev);
                        return false;
                    }, true);

                    document.addEventListener('contextmenu', function(ev) {
                        if (!ev) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (Date.now() - lastRightMouseDownAt < 500) return false;
                        handleRightClick(ev);
                        return false;
                    }, true);
                }

                function installSubframeCacheLoader() {
                    if (window.__cscSubframeCacheLoaderInstalled) return;
                    window.__cscSubframeCacheLoaderInstalled = true;

                    function injectFontOverrideCss() {
                        if (
                            !window.electronAPI ||
                            typeof window.electronAPI.getFontOverrideCss !== 'function'
                        ) return;
                        if (window.__cscFontOverrideCssInstalling) return;
                        window.__cscFontOverrideCssInstalling = true;

                        function disableCompetingFontFaces() {
                            var styles = document.querySelectorAll ? document.querySelectorAll('style') : [];
                            for (var i = 0; i < styles.length; i++) {
                                var styleNode = styles[i];
                                if (!styleNode || styleNode.id === 'csc-font-override-css') continue;
                                var text = styleNode.textContent || '';
                                if (/@font-face/i.test(text) && /(?:ResourceHanRounded(?:TW|CN)|TTF-NPRodin|UDKakugo_LargePr6N)/.test(text)) {
                                    styleNode.disabled = true;
                                }
                            }
                        }

                        function refreshFontOverrideLabels() {
                            if (!window.cc || !cc.director || typeof cc.director.getScene !== 'function' || !cc.Label) return;
                            var now = Date.now();
                            if (window.__cscFontOverrideLabelRefreshAt && now - window.__cscFontOverrideLabelRefreshAt < 1000) return;
                            window.__cscFontOverrideLabelRefreshAt = now;

                            function walk(node) {
                                if (!node) return;
                                var label = node.getComponent && node.getComponent(cc.Label);
                                if (label) {
                                    var font = label.font || label._font;
                                    var fontName = (font && (font._name || font.name || font._native)) || label.fontFamily || label._fontFamily || '';
                                    if (/(?:ResourceHanRounded(?:TW|CN)|TTF-NPRodin|UDKakugo_LargePr6N)/.test(fontName)) {
                                        if (typeof label._forceUpdateRenderData === 'function') label._forceUpdateRenderData();
                                        if (typeof label.setVertsDirty === 'function') label.setVertsDirty();
                                        if (typeof label.markForUpdateRenderData === 'function') label.markForUpdateRenderData();
                                    }
                                }
                                var children = node.children || [];
                                for (var i = 0; i < children.length; i++) walk(children[i]);
                            }

                            walk(cc.director.getScene());
                        }

                        window.electronAPI.getFontOverrideCss().then(function(css) {
                            if (!css) return;
                            var target = document.head || document.documentElement;
                            if (!target) return;

                            function ensureFontOverrideCss() {
                                disableCompetingFontFaces();
                                var style = document.getElementById ? document.getElementById('csc-font-override-css') : null;
                                if (!style) {
                                    style = document.createElement('style');
                                    style.id = 'csc-font-override-css';
                                    style.type = 'text/css';
                                    style.textContent = css;
                                }
                                if (style.parentNode !== target || target.lastChild !== style) {
                                    target.appendChild(style);
                                }
                                refreshFontOverrideLabels();
                            }

                            ensureFontOverrideCss();
                            if (!window.__cscFontOverrideCssObserver && typeof MutationObserver === 'function') {
                                window.__cscFontOverrideCssObserver = new MutationObserver(function() {
                                    setTimeout(ensureFontOverrideCss, 0);
                                });
                                window.__cscFontOverrideCssObserver.observe(target, { childList: true });
                            }
                            if (!window.__cscFontOverrideCssTimer) {
                                window.__cscFontOverrideCssTimer = setInterval(ensureFontOverrideCss, 1000);
                            }
                            if (!window.__cscFontOverrideCssInjected) {
                                window.__cscFontOverrideCssInjected = true;
                                console.log('[CSC] Injected font override CSS');
                            }
                        }).catch(function() {}).finally(function() {
                            window.__cscFontOverrideCssInstalling = false;
                        });
                    }

                    function prepareSubframeCacheLoader() {
                        if (
                            !window.electronAPI ||
                            typeof window.electronAPI.getProxyPort !== 'function' ||
                            typeof window.electronAPI.setCacheConfig !== 'function'
                        ) {
                            requestAnimationFrame(prepareSubframeCacheLoader);
                            return;
                        }

                        if (
                            typeof __require !== 'function' ||
                            !window.cc ||
                            !window.cc.assetManager ||
                            !window.cc.assetManager.packManager
                        ) {
                            requestAnimationFrame(prepareSubframeCacheLoader);
                            return;
                        }

                        var singleton = null;
                        try {
                            singleton = __require('Singleton');
                        } catch (e) {
                            requestAnimationFrame(prepareSubframeCacheLoader);
                            return;
                        }

                        var env = singleton ? singleton.Environment : null;
                        if (!env || typeof env.getWebClientVersion !== 'function') {
                            requestAnimationFrame(prepareSubframeCacheLoader);
                            return;
                        }
                        var version = env.getWebClientVersion();
                        if (!version) {
                            requestAnimationFrame(prepareSubframeCacheLoader);
                            return;
                        }

                        var clientHost = window.location.protocol + '//' + window.location.host + '/';
                        window.electronAPI.setCacheConfig({
                            clientVersion: version,
                            clientHost: clientHost,
                            fontOverrideVersion: fontOverrideVersion
                        });

                        var packManager = window.cc.assetManager.packManager;
                        if (!packManager.__cscOriginalLoad && typeof packManager.load === 'function') {
                            packManager.__cscOriginalLoad = packManager.load;
                        }
                        if (typeof packManager.__cscOriginalLoad !== 'function') {
                            requestAnimationFrame(prepareSubframeCacheLoader);
                            return;
                        }

                        var pathname = window.location.pathname || '/';
                        var lastSlashIndex = pathname.lastIndexOf('/');
                        var pathStr = lastSlashIndex >= 0 ? pathname.substring(0, lastSlashIndex + 1) : '/';
                        var fontOverrideCacheBust = Date.now();

                        function appendFontOverrideCacheBust(url) {
                            if (typeof url !== 'string' || !/\.ttf(?:[?#]|$)/i.test(url)) return url;
                            var joiner = url.indexOf('?') >= 0 ? '&' : '?';
                            return url + joiner + 'csc_font_override=' + fontOverrideCacheBust;
                        }

                        window.electronAPI
                            .getProxyPort()
                            .then(function(port) {
                                if (!port) return;
                                var newHost = 'http://localhost:' + port + '/';
                                injectFontOverrideCss();

                                if (!packManager.__cscCachePatched) {
                                    var originalLoad = packManager.__cscOriginalLoad;
                                    packManager.load = function(t) {
                                        if (!t || !t.url) return originalLoad.apply(this, arguments);
                                        if (t.url.startsWith('http')) return originalLoad.apply(this, arguments);
                                        t.url = appendFontOverrideCacheBust(newHost + 'client' + pathStr + t.url);
                                        return originalLoad.apply(this, arguments);
                                    };
                                    packManager.__cscCachePatched = true;
                                }

                                function waitForAssetLoader() {
                                    var singletonRuntime = null;
                                    try {
                                        singletonRuntime = __require('Singleton');
                                    } catch (e) {
                                        requestAnimationFrame(waitForAssetLoader);
                                        return;
                                    }
                                    var assetLoader = singletonRuntime ? singletonRuntime.assetLoader : null;
                                    var host = assetLoader ? assetLoader._host : null;
                                    if (!host) {
                                        requestAnimationFrame(waitForAssetLoader);
                                        return;
                                    }

                                    window.electronAPI.setCacheConfig({ resourceHost: host });
                                    console.log('[CSC] (Subframe) Caching asset server', host, 'on proxy port', port);

                                    assetLoader._host = newHost;
                                    var hostPath = newHost + 'resources/';
                                    if (typeof assetLoader._hostUrl === 'string') {
                                        assetLoader._hostUrl = assetLoader._hostUrl.replace(host, hostPath);
                                    }
                                    if (assetLoader._loader && typeof assetLoader._loader._hostUrl === 'string') {
                                        assetLoader._loader._hostUrl = assetLoader._loader._hostUrl.replace(host, hostPath);
                                    }
                                }

                                waitForAssetLoader();
                            })
                            .catch(function() {});
                    }

                    prepareSubframeCacheLoader();
                }

                var subframeResourceDownloadState = {
                    active: false,
                    total: 0,
                    completed: 0,
                    failed: 0
                };
                var subframeGameKeepAttr = 'data-csc-shellstrip-subframe-game-keep';
                var subframeDownloadOverlayId = 'csc-subframe-download-overlay';
                var subframeDownloadOverlayStyleId = 'csc-subframe-download-overlay-style';
                var subframeDownloadOverlayRoot = null;
                var subframeDownloadOverlayBar = null;
                var subframeDownloadOverlayText = null;
                var subframeDownloadOverlayPath = null;

                function ensureSubframeDownloadOverlayStyle() {
                    if (document.getElementById(subframeDownloadOverlayStyleId)) return;
                    var style = document.createElement('style');
                    style.id = subframeDownloadOverlayStyleId;
                    style.textContent =
                        '#' + subframeDownloadOverlayId + ' { display: none !important; }' +
                        '#' + subframeDownloadOverlayId + '[data-csc-visible="1"] { display: block !important; }';
                    (document.head || document.documentElement).appendChild(style);
                }

                function ensureSubframeDownloadOverlay() {
                    if (subframeDownloadOverlayRoot) return;
                    if (!document.body) return;

                    ensureSubframeDownloadOverlayStyle();
                    subframeDownloadOverlayRoot = document.createElement('div');
                    subframeDownloadOverlayRoot.id = subframeDownloadOverlayId;
                    subframeDownloadOverlayRoot.style.position = 'fixed';
                    subframeDownloadOverlayRoot.style.top = '12px';
                    subframeDownloadOverlayRoot.style.right = '12px';
                    subframeDownloadOverlayRoot.style.width = '280px';
                    subframeDownloadOverlayRoot.style.padding = '10px';
                    subframeDownloadOverlayRoot.style.background = '#000c';
                    subframeDownloadOverlayRoot.style.color = '#fff';
                    subframeDownloadOverlayRoot.style.fontSize = '12px';
                    subframeDownloadOverlayRoot.style.borderRadius = '8px';
                    subframeDownloadOverlayRoot.style.zIndex = '2147483647';
                    subframeDownloadOverlayRoot.style.pointerEvents = 'none';
                    subframeDownloadOverlayRoot.setAttribute(subframeGameKeepAttr, '1');
                    subframeDownloadOverlayRoot.setAttribute('data-csc-visible', '0');

                    var progressTrack = document.createElement('div');
                    progressTrack.style.width = '100%';
                    progressTrack.style.height = '8px';
                    progressTrack.style.background = '#222';
                    progressTrack.style.borderRadius = '999px';
                    progressTrack.style.overflow = 'hidden';
                    progressTrack.style.marginBottom = '6px';
                    progressTrack.setAttribute(subframeGameKeepAttr, '1');

                    subframeDownloadOverlayBar = document.createElement('div');
                    subframeDownloadOverlayBar.style.width = '0%';
                    subframeDownloadOverlayBar.style.height = '100%';
                    subframeDownloadOverlayBar.style.background = '#1e90ff';
                    subframeDownloadOverlayBar.style.transition = 'width 120ms linear';
                    subframeDownloadOverlayBar.setAttribute(subframeGameKeepAttr, '1');
                    progressTrack.appendChild(subframeDownloadOverlayBar);

                    subframeDownloadOverlayText = document.createElement('div');
                    subframeDownloadOverlayText.style.lineHeight = '1.4';
                    subframeDownloadOverlayText.textContent = 'Preparing resource download...';
                    subframeDownloadOverlayText.setAttribute(subframeGameKeepAttr, '1');

                    subframeDownloadOverlayPath = createPathLabel();
                    subframeDownloadOverlayPath.setAttribute(subframeGameKeepAttr, '1');

                    subframeDownloadOverlayRoot.appendChild(progressTrack);
                    subframeDownloadOverlayRoot.appendChild(subframeDownloadOverlayText);
                    subframeDownloadOverlayRoot.appendChild(subframeDownloadOverlayPath);
                    document.body.appendChild(subframeDownloadOverlayRoot);
                    markKeepChain(subframeDownloadOverlayRoot, subframeGameKeepAttr);
                }

                function updateSubframeDownloadOverlay(label, progressFraction) {
                    ensureSubframeDownloadOverlay();
                    if (!subframeDownloadOverlayRoot || !subframeDownloadOverlayBar || !subframeDownloadOverlayText) return;

                    var clampedFraction = typeof progressFraction === 'number' && isFinite(progressFraction)
                        ? Math.max(0, Math.min(1, progressFraction))
                        : 0;
                    subframeDownloadOverlayRoot.setAttribute('data-csc-visible', '1');
                    subframeDownloadOverlayBar.style.width = String(clampedFraction * 100) + '%';
                    subframeDownloadOverlayText.textContent = label || '';
                }

                function hideSubframeDownloadOverlay(delayMs) {
                    if (!subframeDownloadOverlayRoot) return;
                    setTimeout(function() {
                        if (!subframeResourceDownloadState.active && subframeDownloadOverlayRoot) {
                            subframeDownloadOverlayRoot.setAttribute('data-csc-visible', '0');
                        }
                    }, delayMs || 0);
                }

                function setSubframeDownloadOverlayPath(folderPath) {
                    ensureSubframeDownloadOverlay();
                    if (!subframeDownloadOverlayPath) return;
                    subframeDownloadOverlayPath.textContent = typeof folderPath === 'string' && folderPath ? folderPath : '';
                }

                function waitForSubframeResourceManifest(timeoutMs) {
                    var maxWait = typeof timeoutMs === 'number' ? timeoutMs : 15000;
                    var startAt = Date.now();

                    return new Promise(function(resolve) {
                        function check() {
                            try {
                                if (typeof __require !== 'function') {
                                    if (Date.now() - startAt > maxWait) {
                                        resolve(null);
                                        return;
                                    }
                                    requestAnimationFrame(check);
                                    return;
                                }

                                var singleton = __require('Singleton');
                                var assetLoader = singleton && singleton.assetLoader;
                                var manifest = assetLoader && assetLoader._manifest && assetLoader._manifest._data && assetLoader._manifest._data._data;
                                if (assetLoader && manifest) {
                                    resolve({ assetLoader: assetLoader, manifest: manifest });
                                    return;
                                }

                                if (Date.now() - startAt > maxWait) {
                                    resolve(null);
                                    return;
                                }
                            } catch (e) {
                                if (Date.now() - startAt > maxWait) {
                                    resolve(null);
                                    return;
                                }
                            }
                            requestAnimationFrame(check);
                        }
                        check();
                    });
                }

                function collectSubframeManifestAssetUrls(assetLoader, manifest) {
                    if (!assetLoader || !manifest || typeof manifest !== 'object') return [];
                    var manifestAssets = manifest.assets && typeof manifest.assets === 'object' ? manifest.assets : {};
                    var urlSet = new Set();
                    for (var key in manifestAssets) {
                        if (!Object.prototype.hasOwnProperty.call(manifestAssets, key)) continue;
                        try {
                            var assetUrl = assetLoader.getAssetUrl(key);
                            if (typeof assetUrl === 'string' && assetUrl) {
                                urlSet.add(assetUrl);
                            }
                        } catch (e) {}
                    }
                    return Array.from(urlSet);
                }

                function subframeFetchWithRetry(url, retries) {
                    var attempts = typeof retries === 'number' ? retries : 3;
                    var currentAttempt = 0;

                    function tryFetch() {
                        currentAttempt += 1;
                        return fetch(url, { credentials: 'include' }).then(function(response) {
                            if (!response || !response.ok) {
                                if (currentAttempt < attempts) return tryFetch();
                                throw new Error('HTTP ' + (response ? response.status : '0'));
                            }
                            return response;
                        }).catch(function(error) {
                            if (currentAttempt < attempts) return tryFetch();
                            throw error;
                        });
                    }

                    return tryFetch();
                }

                function runSubframeTaskQueue(tasks, maxConcurrency) {
                    var concurrency = Math.max(1, maxConcurrency || 1);
                    var total = tasks.length;
                    if (total === 0) return Promise.resolve();

                    return new Promise(function(resolve) {
                        var inFlight = 0;
                        var nextIndex = 0;
                        var completed = 0;

                        function launch() {
                            while (inFlight < concurrency && nextIndex < total) {
                                var task = tasks[nextIndex];
                                nextIndex += 1;
                                inFlight += 1;
                                Promise.resolve()
                                    .then(task)
                                    .catch(function() { return null; })
                                    .then(function() {
                                        completed += 1;
                                        inFlight -= 1;
                                        if (completed >= total) {
                                            resolve();
                                            return;
                                        }
                                        launch();
                                    });
                            }
                        }

                        launch();
                    });
                }

                async function startSubframeResourceDownload() {
                    if (subframeResourceDownloadState.active) {
                        updateSubframeDownloadOverlay(
                            'Download already running...',
                            subframeResourceDownloadState.total > 0
                                ? subframeResourceDownloadState.completed / subframeResourceDownloadState.total
                                : 0
                        );
                        return;
                    }

                    subframeResourceDownloadState.active = true;
                    subframeResourceDownloadState.total = 0;
                    subframeResourceDownloadState.completed = 0;
                    subframeResourceDownloadState.failed = 0;
                    updateSubframeDownloadOverlay('Preparing resource manifest...', 0);
                    console.log('[CSC] (Subframe) Resource download started');

                    setSubframeDownloadOverlayPath('');
                    var subframeCacheFolderPath = window.electronAPI && typeof window.electronAPI.getCacheFolder === 'function'
                        ? await window.electronAPI.getCacheFolder()
                        : null;

                    try {
                        var manifestResult = await waitForSubframeResourceManifest(20000);
                        if (!manifestResult || !manifestResult.assetLoader || !manifestResult.manifest) {
                            updateSubframeDownloadOverlay('Manifest unavailable. Retry after loading game assets.', 0);
                            hideSubframeDownloadOverlay(4000);
                            console.log('[CSC] (Subframe) Resource manifest unavailable');
                            return;
                        }

                        var assets = collectSubframeManifestAssetUrls(manifestResult.assetLoader, manifestResult.manifest);
                        subframeResourceDownloadState.total = assets.length;
                        if (assets.length === 0) {
                            updateSubframeDownloadOverlay('No downloadable resources found.', 1);
                            hideSubframeDownloadOverlay(2500);
                            console.log('[CSC] (Subframe) Resource manifest has no downloadable assets');
                            return;
                        }

                        updateSubframeDownloadOverlay('Downloading 0/' + assets.length, 0);

                        var tasks = assets.map(function(assetUrl) {
                            return function() {
                                return subframeFetchWithRetry(assetUrl, 3)
                                    .catch(function() {
                                        subframeResourceDownloadState.failed += 1;
                                    })
                                    .then(function() {
                                        subframeResourceDownloadState.completed += 1;
                                        var ratio = subframeResourceDownloadState.total > 0
                                            ? subframeResourceDownloadState.completed / subframeResourceDownloadState.total
                                            : 1;
                                        var failedPart = subframeResourceDownloadState.failed > 0
                                            ? ' (failed: ' + subframeResourceDownloadState.failed + ')'
                                            : '';
                                        updateSubframeDownloadOverlay(
                                            'Downloading ' + subframeResourceDownloadState.completed + '/' + subframeResourceDownloadState.total + failedPart,
                                            ratio
                                        );
                                        if (subframeCacheFolderPath) {
                                            setSubframeDownloadOverlayPath(subframeCacheFolderPath + '/' + getFilenameFromUrl(assetUrl));
                                        }
                                    });
                            };
                        });

                        await runSubframeTaskQueue(tasks, 3);

                        if (subframeResourceDownloadState.failed > 0) {
                            updateSubframeDownloadOverlay(
                                'Completed with ' + subframeResourceDownloadState.failed + ' failed. Re-run to retry.',
                                1
                            );
                        } else {
                            updateSubframeDownloadOverlay(
                                'Download complete: ' + subframeResourceDownloadState.total + ' assets',
                                1
                            );
                        }
                        hideSubframeDownloadOverlay(3000);
                        console.log(
                            '[CSC] (Subframe) Resource download finished total=' +
                            subframeResourceDownloadState.total +
                            ' failed=' +
                            subframeResourceDownloadState.failed
                        );
                    } catch (error) {
                        console.error('[CSC] (Subframe) Resource download failed:', error);
                        updateSubframeDownloadOverlay('Download failed. Please retry.', 0);
                        hideSubframeDownloadOverlay(4000);
                    } finally {
                        subframeResourceDownloadState.active = false;
                    }
                }

                function resolveSubframeBooleanPayload(payload) {
                    if (typeof payload === 'boolean') return payload;
                    if (payload && typeof payload.enabled === 'boolean') return payload.enabled;
                    if (payload && typeof payload.value === 'boolean') return payload.value;
                    return null;
                }

                function resolveSubframeFrameRatePayload(payload) {
                    if (typeof payload === 'number') return payload;
                    if (payload && typeof payload.fps === 'number') return payload.fps;
                    if (payload && typeof payload.value === 'number') return payload.value;
                    return 0;
                }

                function getSubframeSoundManager() {
                    return window.Grobal && window.Grobal.SoundManager ? window.Grobal.SoundManager : null;
                }

                var subframeAudioState = {
                    muteAll: false,
                    muteBgm: false,
                    muteSe: false
                };
                var subframeAudioApplyScheduled = false;
                var subframeAudioApplyAttempts = 0;
                var subframeAudioApplyStableSince = 0;

                var SUBFRAME_AUDIO_APPLY_STARTUP_ATTEMPTS = 3600;
                var SUBFRAME_AUDIO_APPLY_COMMAND_ATTEMPTS = 180;
                var SUBFRAME_AUDIO_APPLY_STABLE_MS = 5000;

                function normalizeSubframeAudioState(settings) {
                    var source = settings && typeof settings === 'object' ? settings : {};
                    var audio = source.audio && typeof source.audio === 'object' ? source.audio : {};
                    return {
                        muteAll: !!audio.muteAll,
                        muteBgm: !!audio.muteBgm,
                        muteSe: !!audio.muteSe
                    };
                }

                function readSubframeAudioState() {
                    if (window.electronAPI && typeof window.electronAPI.refreshSettings === 'function') {
                        return normalizeSubframeAudioState(window.electronAPI.refreshSettings());
                    }
                    if (window.electronAPI && typeof window.electronAPI.getSettings === 'function') {
                        return normalizeSubframeAudioState(window.electronAPI.getSettings());
                    }
                    return normalizeSubframeAudioState(null);
                }

                function syncSubframeAudioState(settings) {
                    subframeAudioState = normalizeSubframeAudioState(settings);
                    scheduleSubframeAudioApply(SUBFRAME_AUDIO_APPLY_STARTUP_ATTEMPTS, true);
                }

                function applySubframeAudioStateNow() {
                    var soundManager = getSubframeSoundManager();
                    if (!soundManager) return false;

                    var muteAll = !!subframeAudioState.muteAll;
                    var muteBgm = !!subframeAudioState.muteBgm;
                    var muteSe = !!subframeAudioState.muteSe;

                    try {
                        if (typeof soundManager.setBgmMute === 'function') {
                            soundManager.setBgmMute(muteAll ? true : muteBgm);
                        }
                        if (typeof soundManager.setSeMute === 'function') {
                            soundManager.setSeMute(muteAll ? true : muteSe);
                        }
                        if (typeof soundManager.setBattleSeMute === 'function') {
                            soundManager.setBattleSeMute(muteAll ? true : muteSe);
                        }
                        if (typeof soundManager.setVoiceMute === 'function') {
                            soundManager.setVoiceMute(muteAll ? true : muteSe);
                        }
                    } catch (e) {
                        return false;
                    }

                    return true;
                }

                function isSubframeSoundManagerInitialized() {
                    var soundManager = getSubframeSoundManager();
                    if (!soundManager) return false;
                    return soundManager.curBgmId !== -1 ||
                        soundManager.curVoiceId !== -1 ||
                        soundManager.playingBgm != null ||
                        soundManager.bgmVolume !== 1 ||
                        soundManager.seVolume !== 1 ||
                        soundManager.battleSeVolume !== 1 ||
                        soundManager.voiceVolume !== 1;
                }

                function isSubframeAudioStateApplied() {
                    var soundManager = getSubframeSoundManager();
                    if (!soundManager) return false;
                    var muteAll = !!subframeAudioState.muteAll;
                    var muteBgm = !!subframeAudioState.muteBgm;
                    var muteSe = !!subframeAudioState.muteSe;
                    return !!soundManager.bgmMute === (muteAll ? true : muteBgm) &&
                        !!soundManager.seMute === (muteAll ? true : muteSe) &&
                        !!soundManager.battleSeMute === (muteAll ? true : muteSe) &&
                        !!soundManager.voiceMute === (muteAll ? true : muteSe);
                }

                function scheduleSubframeAudioApply(maxAttempts, waitForInitialized) {
                    var attempts = typeof maxAttempts === 'number' ? maxAttempts : 120;
                    subframeAudioApplyAttempts = Math.max(subframeAudioApplyAttempts, attempts);
                    subframeAudioApplyStableSince = 0;
                    if (subframeAudioApplyScheduled) return;
                    subframeAudioApplyScheduled = true;

                    function tick() {
                        if (waitForInitialized) {
                            subframeAudioState = readSubframeAudioState();
                        }
                        var applied = applySubframeAudioStateNow();
                        var initialized = isSubframeSoundManagerInitialized();
                        var stateApplied = isSubframeAudioStateApplied();
                        if (applied && initialized && stateApplied) {
                            if (!subframeAudioApplyStableSince) subframeAudioApplyStableSince = Date.now();
                        } else {
                            subframeAudioApplyStableSince = 0;
                        }
                        var canStop = applied && (
                            !waitForInitialized ||
                            (initialized && stateApplied && Date.now() - subframeAudioApplyStableSince >= SUBFRAME_AUDIO_APPLY_STABLE_MS)
                        );
                        if (canStop) {
                            subframeAudioApplyScheduled = false;
                            return;
                        }
                        subframeAudioApplyAttempts -= 1;
                        if (subframeAudioApplyAttempts <= 0) {
                            subframeAudioApplyScheduled = false;
                            console.warn('[CSC] (Subframe) Audio state apply timed out');
                            return;
                        }
                        requestAnimationFrame(tick);
                    }

                    requestAnimationFrame(tick);
                }

                function applySubframeMuteCommand(command, payload) {
                    var enabled = resolveSubframeBooleanPayload(payload);
                    if (enabled == null) return;

                    if (command === 'setMuteAll') {
                        subframeAudioState.muteAll = !!enabled;
                        subframeAudioState.muteBgm = !!enabled;
                        subframeAudioState.muteSe = !!enabled;
                    } else if (command === 'setMuteBgm') {
                        subframeAudioState.muteBgm = !!enabled;
                        subframeAudioState.muteAll = subframeAudioState.muteBgm && subframeAudioState.muteSe;
                    } else if (command === 'setMuteSe') {
                        subframeAudioState.muteSe = !!enabled;
                        subframeAudioState.muteAll = subframeAudioState.muteBgm && subframeAudioState.muteSe;
                    }

                    scheduleSubframeAudioApply(SUBFRAME_AUDIO_APPLY_COMMAND_ATTEMPTS);
                }

                function getSubframeGameCanvas() {
                    var canvases = getSubframeCanvasCandidates();
                    return canvases.length > 0 ? canvases[0] : null;
                }

                function applySubframeBlackoutCommand(payload) {
                    var enabled = resolveSubframeBooleanPayload(payload);
                    if (enabled == null) return;
                    subframeBlackoutEnabled = !!enabled;
                    scheduleSubframeBlackoutApply(180);
                }

                var subframeBlackoutEnabled = false;
                var subframeBlackoutApplyScheduled = false;
                var subframeMouseIsInside = true;
                var subframeBrightnessSettingTimeout = null;
                var subframeTrackedCanvas = null;

                function getTrackedSubframeGameCanvas() {
                    if (subframeTrackedCanvas && subframeTrackedCanvas.isConnected) return subframeTrackedCanvas;
                    subframeTrackedCanvas = getSubframeGameCanvas();
                    return subframeTrackedCanvas;
                }

                function setSubframeBrightness(brightness, delay) {
                    if (subframeBrightnessSettingTimeout) {
                        clearTimeout(subframeBrightnessSettingTimeout);
                        subframeBrightnessSettingTimeout = null;
                    }

                    function commit() {
                        var gameCanvas = getTrackedSubframeGameCanvas();
                        if (!gameCanvas || !gameCanvas.style) return false;

                        var safeBrightness = Math.max(0, Math.min(100, brightness));
                        if (Math.abs(safeBrightness - 100) < 0.01) {
                            gameCanvas.style.filter = '';
                        } else {
                            gameCanvas.style.filter = 'brightness(' + safeBrightness.toFixed(2) + '%)';
                        }
                        return true;
                    }

                    if (delay === undefined) {
                        return commit();
                    }

                    subframeBrightnessSettingTimeout = setTimeout(function() {
                        commit();
                        subframeBrightnessSettingTimeout = null;
                    }, delay);
                    return true;
                }

                function applySubframeBlackoutStateNow() {
                    var gameCanvas = getTrackedSubframeGameCanvas();
                    if (!gameCanvas || !gameCanvas.style) return false;

                    if (!subframeBlackoutEnabled) {
                        setSubframeBrightness(100);
                        return true;
                    }

                    setSubframeBrightness(subframeMouseIsInside ? 65 : 0, subframeMouseIsInside ? undefined : 350);
                    return true;
                }

                function setSubframeMouseInsideState(isInside) {
                    if (subframeMouseIsInside === isInside) return;
                    subframeMouseIsInside = isInside;
                    if (subframeBlackoutEnabled) applySubframeBlackoutStateNow();
                }

                function scheduleSubframeBlackoutApply(maxAttempts) {
                    if (subframeBlackoutApplyScheduled) return;
                    subframeBlackoutApplyScheduled = true;

                    var attempts = typeof maxAttempts === 'number' ? maxAttempts : 120;
                    function tick() {
                        if (applySubframeBlackoutStateNow()) {
                            subframeBlackoutApplyScheduled = false;
                            return;
                        }
                        attempts -= 1;
                        if (attempts <= 0) {
                            subframeBlackoutApplyScheduled = false;
                            console.warn('[CSC] (Subframe) Blackout apply timed out');
                            return;
                        }
                        requestAnimationFrame(tick);
                    }

                    requestAnimationFrame(tick);
                }

                var subframeLowFrameRateMode = 0;
                var subframeLastRenderTime = 0;
                var subframeFrameRateControlInstalled = false;

                function installSubframeFrameRateControl() {
                    if (subframeFrameRateControlInstalled) return;
                    if (!window.cc || !cc.renderer || typeof cc.renderer.render !== 'function') {
                        requestAnimationFrame(installSubframeFrameRateControl);
                        return;
                    }

                    var originalRender = cc.renderer.render;
                    cc.renderer.render = function() {
                        if (!subframeLowFrameRateMode) {
                            return originalRender.apply(cc.renderer, arguments);
                        }

                        var now = Date.now();
                        if (now - subframeLastRenderTime < subframeLowFrameRateMode) return;
                        subframeLastRenderTime = now;
                        return originalRender.apply(cc.renderer, arguments);
                    };
                    subframeFrameRateControlInstalled = true;
                }

                function applySubframeFrameRateCommand(payload) {
                    var fps = resolveSubframeFrameRatePayload(payload);
                    if (fps !== 0 && fps !== 30 && fps !== 15 && fps !== 5) fps = 0;
                    subframeLowFrameRateMode = fps === 0 ? 0 : 1000 / fps;
                    subframeLastRenderTime = 0;
                    installSubframeFrameRateControl();
                }

                function getSubframeCanvasScore(canvas) {
                    if (!canvas) return 0;
                    var rect = null;
                    try {
                        rect = canvas.getBoundingClientRect();
                    } catch (e) {}
                    var width = rect && rect.width ? rect.width : (canvas.clientWidth || canvas.width || 0);
                    var height = rect && rect.height ? rect.height : (canvas.clientHeight || canvas.height || 0);
                    return Math.max(0, width) * Math.max(0, height);
                }

                function getSubframeCanvasCandidates() {
                    var preferred = document.getElementById('GameCanvas') || document.querySelector('canvas#GameCanvas');
                    var canvases = Array.prototype.slice.call(document.querySelectorAll('canvas'));
                    var result = [];
                    if (preferred) result.push(preferred);
                    for (var i = 0; i < canvases.length; i++) {
                        var canvas = canvases[i];
                        if (!canvas) continue;
                        if (result.indexOf(canvas) >= 0) continue;
                        result.push(canvas);
                    }

                    result.sort(function(a, b) {
                        if (preferred && a === preferred) return -1;
                        if (preferred && b === preferred) return 1;
                        return getSubframeCanvasScore(b) - getSubframeCanvasScore(a);
                    });
                    return result;
                }

                function writeSubframeCanvasToClipboardFallback(canvas) {
                    var gameCanvas = canvas || getSubframeGameCanvas();
                    if (!gameCanvas) return false;
                    try {
                        var dataUrl = gameCanvas.toDataURL('image/png');
                        if (window.electronAPI && typeof window.electronAPI.copyImageToClipboard === 'function') {
                            return !!window.electronAPI.copyImageToClipboard(dataUrl);
                        }
                    } catch (e) {}
                    return false;
                }

                function screenshotToClipboardSubframe(attemptsRemaining) {
                    var attempts = typeof attemptsRemaining === 'number' ? attemptsRemaining : 120;
                    var canvases = getSubframeCanvasCandidates();
                    if (!canvases || canvases.length === 0) {
                        if (attempts <= 0) return;
                        requestAnimationFrame(function() {
                            screenshotToClipboardSubframe(attempts - 1);
                        });
                        return;
                    }

                    function retry() {
                        if (attempts <= 0) return;
                        requestAnimationFrame(function() {
                            screenshotToClipboardSubframe(attempts - 1);
                        });
                    }

                    function tryCanvasAt(index) {
                        if (index >= canvases.length) {
                            retry();
                            return;
                        }

                        var gameCanvas = canvases[index];
                        var fallback = function() {
                            if (writeSubframeCanvasToClipboardFallback(gameCanvas)) return;
                            tryCanvasAt(index + 1);
                        };

                        try {
                            if (
                                typeof gameCanvas.toBlob === 'function' &&
                                window.ClipboardItem &&
                                navigator.clipboard &&
                                typeof navigator.clipboard.write === 'function'
                            ) {
                                gameCanvas.toBlob(function(blob) {
                                    if (!blob) {
                                        fallback();
                                        return;
                                    }
                                    try {
                                        var item = new ClipboardItem({ 'image/png': blob });
                                        navigator.clipboard.write([item]).catch(function() {
                                            fallback();
                                        });
                                    } catch (e) {
                                        fallback();
                                    }
                                }, 'image/png');
                                return;
                            }
                        } catch (e) {}

                        fallback();
                    }

                    tryCanvasAt(0);
                }

                function installSubframeMainEventBridge() {
                    if (window.__cscSubframeMainEventBridgeInstalled) return;
                    if (!window.electronAPI || typeof window.electronAPI.onMainEvent !== 'function') return;

                    window.electronAPI.onMainEvent(function(event) {
                        if (!event) return;

                        // DMM/FANZA wrappers may contain multiple non-game subframes.
                        // Ignore game-control commands outside the resolved game frame to avoid useless retries/timeouts.
                        if (!isGamePage) return;

                        if (event.type === 'settings-updated' && event.payload) {
                            syncSubframeAudioState(event.payload);
                            return;
                        }

                        if (event.type !== 'renderer-command') return;
                        var command = event.payload && event.payload.command;
                        var payload = event.payload && event.payload.payload;
                        if (!command) return;

                        if (command === 'downloadResources') {
                            startSubframeResourceDownload();
                            return;
                        }

                        if (command === 'setMuteAll' || command === 'setMuteBgm' || command === 'setMuteSe') {
                            if (!getSubframeSoundManager()) return;
                            applySubframeMuteCommand(command, payload);
                            return;
                        }

                        if (command === 'setBlackout') {
                            if (!getTrackedSubframeGameCanvas()) return;
                            applySubframeBlackoutCommand(payload);
                            return;
                        }

                        if (command === 'setWindowPointerInside') {
                            if (!getTrackedSubframeGameCanvas()) return;
                            var isInside = resolveSubframeBooleanPayload(payload);
                            if (isInside == null) return;
                            setSubframeMouseInsideState(!!isInside);
                            return;
                        }

                        if (command === 'setFrameRate') {
                            applySubframeFrameRateCommand(payload);
                            return;
                        }

                        if (command === 'screenshotToClipboard') {
                            screenshotToClipboardSubframe();
                        }
                    });

                    if (isGamePage) {
                        syncSubframeAudioState(readSubframeAudioState());
                    }

                    window.__cscSubframeMainEventBridgeInstalled = true;
                }

                var gamePatterns = compileRegexContractList(providerRegexContract.gameRegex);
                var wrapperPatterns = compileRegexContractList(providerRegexContract.wrapperRegex);
                var currentUrl = window.location.href || '';
                function resolveEmbeddedGameUrl(url) {
                    if (!url) return '';
                    try {
                        var parsed = new URL(url, window.location.href);
                        var embedded = parsed.searchParams.get('url') || '';
                        if (!embedded) return '';
                        try {
                            embedded = decodeURIComponent(embedded);
                        } catch (e) {}
                        return embedded || '';
                    } catch (e) {
                        return '';
                    }
                }
                var embeddedGameUrl = resolveEmbeddedGameUrl(currentUrl);
                var isGamePage = checkUrl(currentUrl, gamePatterns) || (embeddedGameUrl && checkUrl(embeddedGameUrl, gamePatterns));
                var isWrapperPage = checkUrl(currentUrl, wrapperPatterns);

                if (isWrapperPage) {
                    applyWrapperShellStripForSubframe();
                }
                installSubframeMainEventBridge();
                if (isGamePage) {
                    sanitizeGame();
                    installSubframeRightClickLongPress();
                    installSubframeCacheLoader();

                    // Expedition monitoring for DMM/Fanza subframe (game iframe) context.
                    // The main frame script's expedition hook runs only when isGamePage is true
                    // on the main window, but for DMM/Fanza the game lives in a subframe —
                    // the main window is the wrapper page (isGamePage=false there).
                    // All XHR calls to /gg/ are made from this iframe, so we install the
                    // monitoring here to enable AP/RP display and expedition notifications.
                    (function() {
                        if (window.__cscExpeditionHookInstalled) return;

                        var expeditionState = {
                            referenceTimeDiffMs: null,
                            expeditions: {},
                            expeditionGroups: [],
                            eventExpeditions: {},
                            eventExpeditionGroups: []
                        };
                        var masterData = {};
                        var userData = {
                            userLevel: 0,
                            staminaMax: 0,
                            battlePointMax: 0,
                            staminaValue: 0,
                            staminaRecoverInterval: 180,
                            staminaRecoveryDateMs: null,
                            staminaRemainSec: 0,
                            staminaBonus: 0,
                            staminaIsFull: false,
                            battlePointValue: 0,
                            battlePointRecoverInterval: 600,
                            battlePointRecoveryDateMs: null,
                            battlePointRemainSec: 0,
                            battlePointBonus: 0,
                            battlePointIsFull: false,
                            estimatedstamina: 0,
                            estimatedstaminaRemainSec: 0,
                            estimatedBattlePoint: 0,
                            estimatedBattlePointRemainSec: 0,
                            hasData: false,
                            hasMasterData: false
                        };
                        var raidState = {
                            isInRaid: false,
                            hasScore: false,
                            hp: 0,
                            score: 0,
                            currentScore: 0
                        };
                        var sharedSettings = null;
                        var lastPublishedStatus = '';

                        function normalizeSettings(settings) {
                            var source = settings && typeof settings === 'object' ? settings : {};
                            var notifications = source.notifications && typeof source.notifications === 'object' ? source.notifications : {};
                            var audio = source.audio && typeof source.audio === 'object' ? source.audio : {};
                            return {
                                notifications: {
                                    battleEnd: notifications.battleEnd !== false,
                                    raidDeath: notifications.raidDeath !== false,
                                    expedition: notifications.expedition !== false,
                                    eventExpedition: notifications.eventExpedition !== false,
                                    stamina: notifications.stamina !== false,
                                    battlepoint: notifications.battlepoint !== false
                                },
                                audio: {
                                    muteAll: !!audio.muteAll,
                                    muteBgm: !!audio.muteBgm,
                                    muteSe: !!audio.muteSe
                                }
                            };
                        }

                        function readInitialSettings() {
                            if (window.electronAPI && typeof window.electronAPI.getSettings === 'function') {
                                return normalizeSettings(window.electronAPI.getSettings());
                            }
                            return normalizeSettings(null);
                        }

                        function refreshSharedSettings(settings) {
                            sharedSettings = normalizeSettings(settings);
                            return sharedSettings;
                        }

                        function isNotificationEnabled(type) {
                            if (!type) return true;
                            var notifications = sharedSettings && sharedSettings.notifications ? sharedSettings.notifications : {};
                            if (Object.prototype.hasOwnProperty.call(notifications, type)) {
                                return !!notifications[type];
                            }
                            return true;
                        }

                        function sendGameNotification(type, title, body, delay) {
                            if (!isNotificationEnabled(type)) return;
                            if (!window.electronAPI || typeof window.electronAPI.showNotification !== 'function') return;

                            var notify = function() {
                                var notifyResult = window.electronAPI.showNotification(title, body, type);
                                if (notifyResult && typeof notifyResult.then === 'function') {
                                    notifyResult.then(function(result) {
                                        console.log('[CSC][NotificationDebug] ' + type + ' result=' + JSON.stringify(result));
                                    });
                                }
                            };

                            if (typeof delay === 'number' && delay > 0) {
                                setTimeout(notify, delay);
                            } else {
                                notify();
                            }
                        }

                        function publishTrayStatus(statusEntries) {
                            if (!window.electronAPI || typeof window.electronAPI.updateTrayStatus !== 'function') return;
                            var statusString = statusEntries && statusEntries.length > 0 ? statusEntries.join(' | ') : '';
                            if (statusString === lastPublishedStatus) return;
                            lastPublishedStatus = statusString;
                            window.electronAPI.updateTrayStatus({ status: statusString });
                        }

                        function parseGameDateToMs(dateStr) {
                            if (!dateStr || typeof dateStr !== 'string' || dateStr.length < 14) return null;
                            var y = parseInt(dateStr.slice(0, 4), 10);
                            var m = parseInt(dateStr.slice(4, 6), 10);
                            var d = parseInt(dateStr.slice(6, 8), 10);
                            var hh = parseInt(dateStr.slice(8, 10), 10);
                            var mm = parseInt(dateStr.slice(10, 12), 10);
                            var ss = parseInt(dateStr.slice(12, 14), 10);
                            if (isNaN(y) || isNaN(m) || isNaN(d) || isNaN(hh) || isNaN(mm) || isNaN(ss)) return null;
                            return new Date(y, m - 1, d, hh, mm, ss).getTime();
                        }

                        function decodeResponsePayload(xhr) {
                            try {
                                var content = xhr && xhr.response;
                                if (typeof content === 'string' && content.length > 0) {
                                    return JSON.parse(content);
                                }
                                if (content && typeof content === 'object') {
                                    if (window.electronAPI && typeof window.electronAPI.decodeMsgpack === 'function') {
                                        var decoded = window.electronAPI.decodeMsgpack(content);
                                        if (decoded) return decoded;
                                    }
                                    return content;
                                }
                                if (typeof xhr.responseText === 'string' && xhr.responseText.length > 0) {
                                    return JSON.parse(xhr.responseText);
                                }
                            } catch (e) {}
                            return null;
                        }

                        function systemDateUpdate(systemDate) {
                            var gameMs = parseGameDateToMs(systemDate);
                            if (gameMs == null) return;
                            expeditionState.referenceTimeDiffMs = gameMs - Date.now();
                        }

                        function updateTime(data) {
                            try {
                                var systemDate = data && data.systemDate;
                                systemDateUpdate(systemDate);
                            } catch (e) {}
                        }

                        function processUserMasterData() {
                            try {
                                var userMaster = masterData && masterData.user;
                                var userMain = userMaster && userMaster.UserMain;
                                if (!userMain) return;
                                var levelData = userMain[userData.userLevel - 1];
                                if (!levelData) return;
                                userData.staminaMax = levelData.maxStamina || 0;
                                userData.battlePointMax = levelData.maxBattlePoint || 0;
                                userData.staminaIsFull = userData.staminaValue >= userData.staminaMax;
                                userData.battlePointIsFull = userData.battlePointValue >= userData.battlePointMax;
                                userData.hasMasterData = true;
                            } catch (e) {}
                        }

                        function updateUser(data) {
                            try {
                                var user = data && data.user;
                                if (!user) return;
                                systemDateUpdate(user.systemDate);
                                userData.userLevel = user.level || 0;
                                userData.staminaValue = user.staminaValue || 0;
                                userData.staminaBonus = user.staminaBonus || 0;
                                userData.staminaRecoveryDateMs = parseGameDateToMs(user.staminaRecoveryDate);
                                userData.staminaRemainSec = user.staminaRemainSec || 0;
                                userData.battlePointValue = user.battlePointValue || 0;
                                userData.battlePointBonus = user.battlePointBonus || 0;
                                userData.battlePointRecoveryDateMs = parseGameDateToMs(user.battlePointRecoveryDate);
                                userData.battlePointRemainSec = user.battlePointRemainSec || 0;
                                userData.hasData = true;
                                processUserMasterData();
                            } catch (e) {}
                        }

                        function processMasterData(pathname, data) {
                            try {
                                var matched = pathname && pathname.match(/^\\/gg\\/(.+)\\/getMasterData\\d*$/);
                                var masterDataType = matched && matched[1];
                                if (!masterDataType) return;
                                if (!masterData[masterDataType]) {
                                    masterData[masterDataType] = data;
                                } else {
                                    var existing = masterData[masterDataType];
                                    for (var key in data) {
                                        if (Array.isArray(data[key]) && Array.isArray(existing[key])) {
                                            existing[key] = existing[key].concat(data[key]);
                                        } else {
                                            existing[key] = data[key];
                                        }
                                    }
                                }
                                processUserMasterData();
                            } catch (e) {}
                        }

                        // DMM/Fanza master data: zlib-compressed protobuf .bin files
                        // served from gg-resource CDN (not the /gg/ API). Decoded
                        // preferentially via the game's own pbjs decoders, captured
                        // as window.__cscPb by a CDP conditional breakpoint on
                        // index.js. UserMain has a hand-written fallback decoder so
                        // the expedition monitor keeps working even if __cscPb
                        // capture fails (e.g. game version changes the pattern).
                        function decodeUserMainBin(bytes) {
                            // Hand-written protobuf reader for UserMain_List (field 1
                            // repeated UserMain). UserMain fields used by the monitor:
                            // 2=userLevel, 5=maxStamina, 6=maxBattlePoint.
                            var pos = 0, list = [], textDecoder = new TextDecoder();
                            function readVarint() {
                                var result = 0, shift = 0, b;
                                do { b = bytes[pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
                                return result >>> 0;
                            }
                            function skipWire(wt) {
                                if (wt === 0) readVarint();
                                else if (wt === 2) { var l = readVarint(); pos += l; }
                                else if (wt === 1) pos += 8;
                                else if (wt === 5) pos += 4;
                            }
                            function decodeEntry(end) {
                                var entry = {};
                                while (pos < end) {
                                    var tag = readVarint(), f = tag >>> 3, wt = tag & 7;
                                    if (wt === 0) {
                                        var v = readVarint();
                                        if (f === 2) entry.userLevel = v;
                                        else if (f === 3) entry.totalExp = v;
                                        else if (f === 4) entry.nextLevelExp = v;
                                        else if (f === 5) entry.maxStamina = v;
                                        else if (f === 6) entry.maxBattlePoint = v;
                                        else if (f === 7) entry.maxFriendCount = v;
                                        else if (f === 8) entry.maxApplyCount = v;
                                        else if (f === 9) entry.maxApproveCount = v;
                                    } else if (wt === 2) {
                                        var len = readVarint();
                                        if (f === 10) entry.fromDate = textDecoder.decode(bytes.subarray(pos, pos + len));
                                        pos += len;
                                    } else { skipWire(wt); }
                                }
                                return entry;
                            }
                            while (pos < bytes.length) {
                                var tag = readVarint(), f = tag >>> 3, wt = tag & 7;
                                if (f === 1 && wt === 2) { var len = readVarint(); list.push(decodeEntry(pos + len)); }
                                else skipWire(wt);
                            }
                            return list;
                        }
                        function tryDecodeBin(tableName, bytes) {
                            var pb = window.__cscPb;
                            if (pb) {
                                var listType = pb[tableName + '_List'];
                                var msgType = pb[tableName];
                                try {
                                    if (listType && typeof listType.decode === 'function') {
                                        var decoded = listType.decode(bytes);
                                        storeBinMasterData(tableName, (decoded && decoded.list) || []);
                                        return true;
                                    } else if (msgType && typeof msgType.decode === 'function') {
                                        storeBinMasterData(tableName, [msgType.decode(bytes)]);
                                        return true;
                                    } else {
                                        console.warn('[CSC-CDP] no decoder for ' + tableName);
                                        return true; // pb is ready but table unknown; drop
                                    }
                                } catch (e) {
                                    console.warn('[CSC-CDP] decode failed for ' + tableName + ':', e && e.message || e);
                                    return true;
                                }
                            }
                            // Fallback: hand-written decoder for UserMain so the expedition
                            // monitor keeps working even when __cscPb capture fails.
                            if (tableName === 'UserMain') {
                                try { storeBinMasterData('UserMain', decodeUserMainBin(bytes)); return true; }
                                catch (e) { console.warn('[CSC-CDP] fallback UserMain decode failed:', e && e.message || e); }
                            }
                            return false;
                        }
                        function storeBinMasterData(tableName, list) {
                            masterData[tableName] = list;
                            if (tableName === 'UserMain') {
                                if (!masterData.user) masterData.user = {};
                                masterData.user.UserMain = list;
                                processUserMasterData();
                            }
                        }
                        // Mass-fetch all master data tables once both manifest
                        // (versions.json from gg-resource CDN — the index of every
                        // .bin file with its current hash) and __cscPb (the protobuf
                        // namespace, captured by the CDP breakpoint in
                        // electron-main.js) are available. UserMain is prioritized so
                        // the expedition monitor lights up in the first batch.
                        var _masterDataManifest = null;
                        var _manifestFetchInflight = false;
                        var _massFetchStarted = false;
                        var _massFetchUrlBase = null;
                        var _userMainFallbackFetchStarted = false;
                        function detectBinUrlBase() {
                            if (_massFetchUrlBase) return _massFetchUrlBase;
                            // Match any gg-resource URL (e.g., resource.txt) to derive
                            // host + version prefix. cocos2d's loader bypasses the
                            // iframe performance API for .bin fetches, so we can't
                            // rely on seeing a /bin/ URL here.
                            var perf = (typeof performance !== 'undefined' && performance.getEntriesByType)
                                ? performance.getEntriesByType('resource') : [];
                            for (var pi = 0; pi < perf.length; pi++) {
                                var pu = perf[pi].name || '';
                                var pm = pu.match(/^(https:\\/\\/gg-resource\\.crave-saga\\.net\\/[^\\/]+)\\//);
                                if (pm) { _massFetchUrlBase = pm[1] + '/bin/'; return _massFetchUrlBase; }
                            }
                            return null;
                        }
                        async function tryFetchManifest() {
                            if (_masterDataManifest || _manifestFetchInflight) return;
                            var base = detectBinUrlBase();
                            if (!base) return; // game hasn't loaded any .bin yet
                            _manifestFetchInflight = true;
                            try {
                                var r = await fetch(base + 'versions.json');
                                if (!r.ok) { console.warn('[CSC] versions.json fetch failed: ' + r.status); return; }
                                var m = await r.json();
                                if (!m || typeof m !== 'object' || Array.isArray(m)) return;
                                var sample = Object.keys(m).slice(0, 3);
                                if (!sample.every(function(k) { return typeof m[k] === 'string' && /^[a-f0-9]{32}$/.test(m[k]); })) {
                                    console.warn('[CSC] versions.json shape unexpected, sample=', sample);
                                    return;
                                }
                                _masterDataManifest = m;
                                console.log('[CSC] manifest loaded: ' + Object.keys(m).length + ' tables');
                                maybeKickoffMassFetch();
                            } catch (e) {
                                console.warn('[CSC] manifest fetch error:', e && e.message || e);
                            } finally {
                                _manifestFetchInflight = false;
                            }
                        }
                        function maybeKickoffMassFetch() {
                            if (_massFetchStarted) return;
                            if (!_masterDataManifest || !window.__cscPb) {
                                maybeFetchUserMainFallback();
                                return;
                            }
                            _massFetchStarted = true;
                            clearInterval(_binFetchInterval);
                            massFetchAllTables();
                        }
                        async function maybeFetchUserMainFallback() {
                            if (_userMainFallbackFetchStarted) return;
                            if (!_masterDataManifest || !_masterDataManifest.UserMain) return;
                            if (masterData && masterData.user && masterData.user.UserMain) return;
                            _userMainFallbackFetchStarted = true;
                            await fetchAndDecodeBin('UserMain', _masterDataManifest.UserMain);
                        }
                        async function massFetchAllTables() {
                            try {
                                var entries = Object.entries(_masterDataManifest).filter(function(e) {
                                    return e[1] && e[1] !== 'd41d8cd98f00b204e9800998ecf8427e'; // skip empty md5
                                });
                                entries.sort(function(a, b) {
                                    if (a[0] === 'UserMain') return -1;
                                    if (b[0] === 'UserMain') return 1;
                                    return 0;
                                });
                                console.log('[CSC] mass-fetch start: ' + entries.length + ' tables');
                                var concurrency = 10;
                                var failed = 0;
                                for (var i = 0; i < entries.length; i += concurrency) {
                                    var batch = entries.slice(i, i + concurrency);
                                    var results = await Promise.all(batch.map(function(e) { return fetchAndDecodeBin(e[0], e[1]); }));
                                    for (var ri = 0; ri < results.length; ri++) {
                                        if (!results[ri]) {
                                            failed++;
                                            if (batch[ri][0] === 'UserMain') console.warn('[CSC] UserMain fetch/decode failed — expedition monitor may not function');
                                        }
                                    }
                                }
                                console.log('[CSC] mass-fetch complete: stored=' + Object.keys(masterData).length + ' failed=' + failed);
                            } catch (e) {
                                console.warn('[CSC] mass-fetch error:', e && e.message || e);
                            }
                        }
                        async function fetchAndDecodeBin(tableName, hash) {
                            try {
                                var r = await fetch(_massFetchUrlBase + tableName + '.bin?v=' + hash);
                                if (!r.ok) return false;
                                var stream = r.body.pipeThrough(new DecompressionStream('deflate'));
                                var buf = await new Response(stream).arrayBuffer();
                                return tryDecodeBin(tableName, new Uint8Array(buf));
                            } catch (e) {
                                console.warn('[CSC] mass-fetch failed for ' + tableName + ':', e && e.message || e);
                                return false;
                            }
                        }
                        var _binFetchInterval = setInterval(function() {
                            tryFetchManifest();
                            maybeKickoffMassFetch();
                        }, 500);

                        if (window.electronAPI && typeof window.electronAPI.onPbReady === 'function') {
                            window.electronAPI.onPbReady(function() { maybeKickoffMassFetch(); });
                        }

                        function gameDateNowMs() {
                            if (expeditionState.referenceTimeDiffMs == null) return null;
                            return Date.now() + expeditionState.referenceTimeDiffMs;
                        }

                        function groupExpeditions() {
                            expeditionState.expeditionGroups.splice(0, expeditionState.expeditionGroups.length);
                            var ids = Object.keys(expeditionState.expeditions);
                            for (var i = 0; i < ids.length; i++) {
                                var id = ids[i];
                                var endMs = expeditionState.expeditions[id];
                                var existingGroup = null;
                                for (var j = 0; j < expeditionState.expeditionGroups.length; j++) {
                                    var group = expeditionState.expeditionGroups[j];
                                    if (Math.abs(group.endTime - endMs) < 60000) { existingGroup = group; break; }
                                }
                                if (existingGroup) {
                                    existingGroup.ids.push(id);
                                    existingGroup.endTime = Math.max(existingGroup.endTime, endMs);
                                } else {
                                    expeditionState.expeditionGroups.push({ endTime: endMs, ids: [id] });
                                }
                            }
                        }

                        function groupEventExpeditions() {
                            expeditionState.eventExpeditionGroups.splice(0, expeditionState.eventExpeditionGroups.length);
                            var ids = Object.keys(expeditionState.eventExpeditions);
                            for (var i = 0; i < ids.length; i++) {
                                var id = ids[i];
                                var endMs = expeditionState.eventExpeditions[id];
                                var existingGroup = null;
                                for (var j = 0; j < expeditionState.eventExpeditionGroups.length; j++) {
                                    var group = expeditionState.eventExpeditionGroups[j];
                                    if (Math.abs(group.endTime - endMs) < 60000) { existingGroup = group; break; }
                                }
                                if (existingGroup) {
                                    existingGroup.ids.push(id);
                                    existingGroup.endTime = Math.max(existingGroup.endTime, endMs);
                                } else {
                                    expeditionState.eventExpeditionGroups.push({ endTime: endMs, ids: [id] });
                                }
                            }
                        }

                        function updateExpeditions(data) {
                            try {
                                var gameNow = gameDateNowMs();
                                if (gameNow == null) return 0;
                                var expeditionData = data && data.expeditions;
                                if (!expeditionData) return 0;
                                for (var i = 0; i < expeditionData.length; i++) {
                                    var expedition = expeditionData[i];
                                    if (!expedition || !expedition.endDate || !expedition.startDate) continue;
                                    var endMs = parseGameDateToMs(expedition.endDate);
                                    if (endMs == null) continue;
                                    var id = expedition.slotId;
                                    if (id == null) continue;
                                    id = String(id);
                                    if (endMs < gameNow || expedition.receiveDate) {
                                        delete expeditionState.expeditions[id];
                                        continue;
                                    }
                                    expeditionState.expeditions[id] = endMs;
                                    groupExpeditions();
                                }
                                return expeditionData.length || 0;
                            } catch (e) { return 0; }
                        }

                        function updateEventExpeditions(data) {
                            try {
                                var gameNow = gameDateNowMs();
                                if (gameNow == null) return 0;
                                var expeditionData = data && data.eventExpeditions;
                                if (!expeditionData) return 0;
                                for (var i = 0; i < expeditionData.length; i++) {
                                    var expedition = expeditionData[i];
                                    if (!expedition || !expedition.endDate || !expedition.startDate) continue;
                                    var endMs = parseGameDateToMs(expedition.endDate);
                                    if (endMs == null) continue;
                                    var id = expedition.slotId;
                                    if (id == null) continue;
                                    id = String(id);
                                    if (endMs < gameNow || expedition.receiveDate) {
                                        delete expeditionState.eventExpeditions[id];
                                        continue;
                                    }
                                    expeditionState.eventExpeditions[id] = endMs;
                                    groupEventExpeditions();
                                }
                                return expeditionData.length || 0;
                            } catch (e) { return 0; }
                        }

                        function updateRaidBattle(data) {
                            try {
                                if (data && data.raidStatus) {
                                    raidState.hp = data.raidStatus.currentHp;
                                    raidState.isInRaid = true;
                                    return;
                                }
                                if (data && data.currentHp) {
                                    raidState.hp = data.currentHp;
                                    raidState.currentScore = data.score;
                                    raidState.isInRaid = true;
                                } else {
                                    raidState.isInRaid = false;
                                    raidState.hasScore = false;
                                    raidState.hp = 0;
                                    raidState.score = 0;
                                    raidState.currentScore = 0;
                                }
                            } catch (e) {}
                        }

                        function endRaidBattle() {
                            raidState.isInRaid = false;
                            raidState.hasScore = false;
                            raidState.hp = 0;
                            raidState.score = 0;
                            raidState.currentScore = 0;
                        }

                        function processApiResponse(pathname, data) {
                            if (!pathname || !data) return;
                            if (/\\/getMasterData\\d*$/.test(pathname)) {
                                processMasterData(pathname, data);
                            } else if (/\\/user\\/getSystemDate$/.test(pathname)) {
                                updateTime(data);
                            } else if (/\\/raid\\/updateBattle$/.test(pathname)) {
                                updateRaidBattle(data);
                            } else if (/\\/raid\\/joinBattle$/.test(pathname) || /\\/raid\\/resumeBattle$/.test(pathname) || /\\/raid\\/appearBattle$/.test(pathname)) {
                                updateRaidBattle(data);
                            } else if (/endBattle$/.test(pathname)) {
                                endRaidBattle();
                                sendGameNotification('battleEnd', 'Crave Saga', 'Battle has ended', 3500);
                            }
                            updateUser(data);
                            var expeditionCount = updateExpeditions(data);
                            var eventExpeditionCount = updateEventExpeditions(data);
                            console.log('[CSC][ExpeditionDebug] pathname=' + pathname + ' expeditionCount=' + expeditionCount + ' eventExpeditionCount=' + eventExpeditionCount);
                        }

                        function installExpeditionRequestHook() {
                            if (window.__cscExpeditionHookInstalled) return;
                            window.__cscExpeditionHookInstalled = true;
                            var originalOpen = XMLHttpRequest.prototype.open;
                            XMLHttpRequest.prototype.open = function() {
                                this.addEventListener('readystatechange', function() {
                                    if (this.readyState !== 4) return;
                                    try {
                                        var rawUrl = this.responseURL;
                                        if (!rawUrl) return;
                                        var url = new URL(rawUrl, window.location.origin);
                                        document.dispatchEvent(new CustomEvent('responseReceived', { detail: { req: this } }));
                                        if (!url.pathname || url.pathname.indexOf('/gg/') !== 0) return;
                                        var data = decodeResponsePayload(this);
                                        processApiResponse(url.pathname, data);
                                    } catch (e) {}
                                }, false);
                                return originalOpen.apply(this, arguments);
                            };
                        }

                        function startExpeditionNotifier() {
                            if (window.__cscExpeditionTickerStarted) return;
                            window.__cscExpeditionTickerStarted = true;
                            setInterval(function() {
                                var statusEntries = [];
                                var now = gameDateNowMs();
                                if (now == null) return;

                                for (var i = 0; i < expeditionState.expeditionGroups.length; i++) {
                                    var group = expeditionState.expeditionGroups[i];
                                    if (now > group.endTime) {
                                        var ids = group.ids.map(function(id) { return '#' + id; });
                                        var message = ids.length > 1
                                            ? 'Expeditions ' + ids.join(',') + ' has finished'
                                            : 'Expedition ' + ids[0] + ' has finished';

                                        console.log('[CSC][ExpeditionDebug] notify=' + message);
                                        sendGameNotification('expedition', 'Crave Saga', message);

                                        for (var j = 0; j < group.ids.length; j++) {
                                            delete expeditionState.expeditions[group.ids[j]];
                                        }
                                        groupExpeditions();
                                        i = -1;
                                    }
                                }

                                for (var i = 0; i < expeditionState.eventExpeditionGroups.length; i++) {
                                    var group = expeditionState.eventExpeditionGroups[i];
                                    if (now > group.endTime) {
                                        var ids = group.ids.map(function(id) { return '#' + id; });
                                        var message = ids.length > 1
                                            ? 'Event Expeditions ' + ids.join(',') + ' has finished'
                                            : 'Event Expedition ' + ids[0] + ' has finished';

                                        console.log('[CSC][ExpeditionDebug] notify=' + message);
                                        sendGameNotification('eventExpedition', 'Crave Saga', message);
                                        for (var j = 0; j < group.ids.length; j++) {
                                            delete expeditionState.eventExpeditions[group.ids[j]];
                                        }
                                        groupEventExpeditions();
                                        i = -1;
                                    }
                                }

                                if (userData.hasData && userData.hasMasterData) {
                                    var isstaminaFull = userData.staminaIsFull;
                                    var isBattlePointFull = userData.battlePointIsFull;
                                    var staminaStartTimeMs = userData.staminaRecoveryDateMs != null
                                        ? userData.staminaRecoveryDateMs - userData.staminaRemainSec * 1000
                                        : null;
                                    var staminaInterval = userData.staminaRecoverInterval || 180;
                                    if (staminaStartTimeMs != null && staminaInterval > 0) {
                                        var staminaDiffSec = (now - staminaStartTimeMs) / 1000;
                                        var staminaRecoverCount = Math.floor(staminaDiffSec / staminaInterval);
                                        userData.estimatedstamina = Math.min(
                                            userData.staminaMax,
                                            userData.staminaValue + staminaRecoverCount
                                        );
                                        userData.estimatedstaminaRemainSec = Math.ceil(
                                            staminaInterval - (staminaDiffSec % staminaInterval)
                                        );
                                        isstaminaFull = userData.estimatedstamina >= userData.staminaMax;
                                        if (!userData.staminaIsFull && isstaminaFull) {
                                            userData.staminaIsFull = true;
                                            sendGameNotification('stamina', 'Crave Saga', 'AP has fully recovered');
                                        }
                                    }
                                    var staminaString = isstaminaFull
                                        ? 'AP: ' + (userData.estimatedstamina + userData.staminaBonus) + '/' + userData.staminaMax
                                        : 'AP: ' + (userData.estimatedstamina + userData.staminaBonus) + '/' + userData.staminaMax + ' (' + userData.estimatedstaminaRemainSec + 's)';
                                    statusEntries.push(staminaString);

                                    var battlePointStartTimeMs = userData.battlePointRecoveryDateMs != null
                                        ? userData.battlePointRecoveryDateMs - userData.battlePointRemainSec * 1000
                                        : null;
                                    var battlePointInterval = userData.battlePointRecoverInterval || 600;
                                    if (battlePointStartTimeMs != null && battlePointInterval > 0) {
                                        var battlePointDiffSec = (now - battlePointStartTimeMs) / 1000;
                                        var battlePointRecoverCount = Math.floor(battlePointDiffSec / battlePointInterval);
                                        userData.estimatedBattlePoint = Math.min(
                                            userData.battlePointMax,
                                            userData.battlePointValue + battlePointRecoverCount
                                        );
                                        userData.estimatedBattlePointRemainSec = Math.ceil(
                                            battlePointInterval - (battlePointDiffSec % battlePointInterval)
                                        );
                                        isBattlePointFull = userData.estimatedBattlePoint >= userData.battlePointMax;
                                        if (!userData.battlePointIsFull && isBattlePointFull) {
                                            userData.battlePointIsFull = true;
                                            sendGameNotification('battlepoint', 'Crave Saga', 'RP has fully recovered');
                                        }
                                    }
                                    var battlePointString = isBattlePointFull
                                        ? 'RP: ' + (userData.estimatedBattlePoint + userData.battlePointBonus) + '/' + userData.battlePointMax
                                        : 'RP: ' + (userData.estimatedBattlePoint + userData.battlePointBonus) + '/' + userData.battlePointMax + ' (' + userData.estimatedBattlePointRemainSec + 's)';
                                    statusEntries.push(battlePointString);
                                }

                                if (raidState.isInRaid) {
                                    if (raidState.currentScore != null) raidState.score = raidState.currentScore;
                                    statusEntries.push('Raid Boss HP: ' + raidState.hp);
                                    if (raidState.score) statusEntries.push('Raid Damage: ' + raidState.score);
                                    if (!raidState.hasScore && raidState.currentScore != null) {
                                        raidState.hasScore = true;
                                    } else if (raidState.hasScore && raidState.currentScore == null) {
                                        raidState.hasScore = false;
                                        sendGameNotification('raidDeath', 'Crave Saga', 'Your team has been defeated in raid battle.');
                                    }
                                }

                                publishTrayStatus(statusEntries);
                            }, 1000);
                        }

                        refreshSharedSettings(readInitialSettings());
                        installExpeditionRequestHook();
                        startExpeditionNotifier();

                        // Expose masterData so CraveAuto can read it via __cscBridge traversal
                        try {
                            if (!window.__cscBridge || typeof window.__cscBridge !== 'object') window.__cscBridge = {};
                            if (!window.__cscBridge.engine || typeof window.__cscBridge.engine !== 'object') window.__cscBridge.engine = {};
                            window.__cscBridge.engine.masterData = masterData;
                        } catch (e) {}

                        // Keep notification settings in sync with main process
                        if (window.electronAPI && typeof window.electronAPI.onMainEvent === 'function') {
                            window.electronAPI.onMainEvent(function(event) {
                                if (event && event.type === 'settings-updated' && event.payload) {
                                    refreshSharedSettings(event.payload);
                                }
                            });
                        }
                    })();
                }
            })();
        `;
            document.documentElement.appendChild(subframeScript);
        } catch (error) {}
        return;
    }

    const script = document.createElement('script');
    script.textContent = `
        (function() {
            // Legacy NW bridge removed; keep Electron-only runtime path.
            // --- Shared state ---
            var skipRender = false;
            var renderGl = null;
            var providerRegexContract = ${JSON.stringify(providerRegexContract)};
            var fontOverrideVersion = ${fontOverrideVersionLiteral};
            ${injectedRegexHelpersSource}
            ${injectedMaskHelpersSource}
            ${injectedWrapperHelpersSource}
            ${injectedDownloadPathLabelSource}

            var loginPatterns = compileRegexContractList(providerRegexContract.loginRegex, 'loginRegex', true);
            var pagePatterns = compileRegexContractList(providerRegexContract.pageRegex, 'pageRegex', true);
            var gamePatterns = compileRegexContractList(providerRegexContract.gameRegex, 'gameRegex', true);
            var wrapperPatterns = compileRegexContractList(providerRegexContract.wrapperRegex, 'wrapperRegex', true);

            var currentUrl = window.location.href;
            var isSelectorPage = /\\/selector\\.html(?:[?#]|$)/i.test(currentUrl);
            var isLoginPage = checkUrl(currentUrl, loginPatterns);
            var isPageRoute = checkUrl(currentUrl, pagePatterns);
            var isGamePage = checkUrl(currentUrl, gamePatterns);
            var isWrapperPage = checkUrl(currentUrl, wrapperPatterns);
            var navigationSwitchTriggered = false;

            function normalizeUrl(url) {
                if (!url) return '';
                try {
                    return new URL(url, window.location.href).href;
                } catch (e) {
                    return String(url);
                }
            }

            function isCloudfrontEmbeddedClientUrl(url) {
                if (!url) return false;
                return /^https:\\/\\/[^/]+\\.cloudfront\\.net\\/[grw]\\/client\\/[^/?#]+\\/index[^/?#]*\\.html(?:[?#].*)?$/i.test(url);
            }

            var shellStripEnabled = ${shellStripEnabled ? 'true' : 'false'};
            var shellStripProviderKey = ${JSON.stringify(defaultProvider)};
            var providerShellProfiles = {
                default: {
                    requireBootstrapParams: false
                },
                dmm: {
                    requireBootstrapParams: true
                },
                fanza: {
                    requireBootstrapParams: true
                }
            };
            var shellProfile = providerShellProfiles[shellStripProviderKey] || providerShellProfiles.default;
            var shellStripRequireBootstrapParams = !!shellProfile.requireBootstrapParams;
            var providerNavigationTimeoutMs = 5000;

            function injectSelectProviderButton() {
                if (isSelectorPage || isGamePage) return;
                if (!document.body) return;
                if (document.getElementById('csc-select-provider-button')) return;

                var button = document.createElement('button');
                button.id = 'csc-select-provider-button';
                button.type = 'button';
                button.textContent = 'Select Provider';
                button.style.position = 'absolute';
                button.style.top = '5px';
                button.style.left = '50%';
                button.style.transform = 'translateX(-50%)';
                button.style.width = '240px';
                button.style.height = '48px';
                button.style.fontSize = '16px';
                button.style.backgroundColor = '#000b';
                button.style.color = '#fff';
                button.style.border = 'none';
                button.style.outline = 'none';
                button.style.cursor = 'pointer';
                button.style.zIndex = '10000';
                button.style.borderRadius = '8px';
                button.onclick = function() {
                    if (!window.electronAPI || typeof window.electronAPI.runCommand !== 'function') return;
                    window.electronAPI.runCommand('changeProvider', { reselect: '1' });
                };
                document.body.appendChild(button);
            }

            function applyWrapperShellStripForMainFrame(strictMode) {
                var keepAttr = 'data-csc-shellstrip-keep';
                applyWrapperShellStrip({
                    strictMode: strictMode,
                    keepAttr: keepAttr,
                    styleId: 'csc-shellstrip-wrapper-mask-style',
                    styleText:
                        'html, body { margin: 0 !important; overflow: hidden !important; background: #000 !important; height: 100% !important; }' +
                        'body *:not([' + keepAttr + ']) { display: none !important; }' +
                        'iframe[' + keepAttr + '] { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; border: 0 !important; z-index: 2147483647 !important; }',
                    alwaysRetry: !!strictMode,
                    retryDelay: 50,
                    findTarget: function() {
                        return document.querySelector('#game-iframe') ||
                            document.querySelector('#game_frame') ||
                            document.querySelector('iframe[role="application"]') ||
                            document.querySelector('iframe');
                    }
                });
            }

            function getPrimaryWrapperFrame() {
                return (
                    document.querySelector('#game-iframe') ||
                    document.querySelector('#game_frame') ||
                    document.querySelector('iframe[role="application"]') ||
                    document.querySelector('iframe')
                );
            }

            function runIframeTargetSwitch(options) {
                var config = options && typeof options === 'object' ? options : {};
                var getFrames = typeof config.getFrames === 'function' ? config.getFrames : null;
                var resolveTargetUrl = typeof config.resolveTargetUrl === 'function' ? config.resolveTargetUrl : null;
                var beforePoll = typeof config.beforePoll === 'function' ? config.beforePoll : null;
                var timeoutMs = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 5000;
                if (!getFrames || !resolveTargetUrl) return;

                var startTime = Date.now();

                function trySwitch() {
                    if (navigationSwitchTriggered) return false;

                    var frames = getFrames();
                    if (!frames || typeof frames.length !== 'number') return false;

                    for (var i = 0; i < frames.length; i++) {
                        var frame = frames[i];
                        if (!frame) continue;
                        var targetUrl = resolveTargetUrl(frame);
                        if (!targetUrl) continue;

                        var hereUrl = normalizeUrl(window.location.href);
                        if (!hereUrl || targetUrl === hereUrl) continue;

                        navigationSwitchTriggered = true;
                        window.stop();
                        window.location.href = targetUrl;
                        return true;
                    }

                    return false;
                }

                function poll() {
                    if (navigationSwitchTriggered) return;
                    if (beforePoll) beforePoll(trySwitch);
                    var polledFrames = getFrames();
                    if (polledFrames && typeof polledFrames.length === 'number') {
                        for (var i = 0; i < polledFrames.length; i += 1) {
                            var polledFrame = polledFrames[i];
                            if (polledFrame && polledFrame.__cscWrapperPromotionBlocked) {
                                return;
                            }
                        }
                    }
                    if (trySwitch()) return;
                    if (Date.now() - startTime > timeoutMs) return;
                    requestAnimationFrame(poll);
                }

                poll();
            }

            function resolveWrapperPromotionTarget(frame) {
                if (!frame) return '';
                var src = frame.getAttribute('src') || frame.src || '';
                if (!src) return '';
                var targetUrl = normalizeUrl(src);
                if (!targetUrl) return '';
                var matchesGameTarget = checkUrl(targetUrl, gamePatterns);
                var matchesWrapperTarget = checkUrl(targetUrl, wrapperPatterns);
                if (!(matchesGameTarget || matchesWrapperTarget)) return '';
                if (isCloudfrontEmbeddedClientUrl(targetUrl)) {
                    frame.__cscWrapperPromotionBlocked = true;
                    return '';
                }
                if (shellStripRequireBootstrapParams) {
                    try {
                        var parsed = new URL(targetUrl, window.location.origin);
                        var hasBootstrapParams = !!(parsed.search && parsed.search.length > 1) || !!parsed.hash;
                        if (!hasBootstrapParams) return '';
                    } catch (e) {
                        return '';
                    }
                }
                return targetUrl;
            }

            function resolvePageRouteTarget(frame) {
                var src = frame && frame.src ? frame.src : '';
                if (!(checkUrl(src, wrapperPatterns) || checkUrl(src, gamePatterns))) return '';
                return normalizeUrl(src);
            }

            function bindWrapperPromotion(frame, trySwitch) {
                if (!frame) return;
                if (frame.__cscWrapperPromotionBlocked) return;
                if (frame.__cscWrapperPromoteBound) return;
                frame.__cscWrapperPromoteBound = true;
                frame.addEventListener('load', function() {
                    if (frame.__cscWrapperPromotionBlocked) return;
                    trySwitch();
                });
            }

            function runProviderRouteSwitch(profileName) {
                var profile = null;
                if (profileName === 'wrapper-promotion') {
                    profile = {
                        getFrames: function() {
                            var frame = getPrimaryWrapperFrame();
                            return frame ? [frame] : [];
                        },
                        resolveTargetUrl: resolveWrapperPromotionTarget,
                        beforePoll: function(trySwitch) {
                            bindWrapperPromotion(getPrimaryWrapperFrame(), trySwitch);
                        }
                    };
                } else if (profileName === 'page-route') {
                    profile = {
                        getFrames: function() {
                            return document.querySelectorAll('iframe');
                        },
                        resolveTargetUrl: resolvePageRouteTarget
                    };
                }

                if (!profile) return;

                runIframeTargetSwitch({
                    getFrames: profile.getFrames,
                    resolveTargetUrl: profile.resolveTargetUrl,
                    beforePoll: profile.beforePoll,
                    timeoutMs: providerNavigationTimeoutMs
                });
            }

            if (!isGamePage) {
                injectSelectProviderButton();
                if (isWrapperPage) {
                    applyWrapperShellStripForMainFrame(!!shellStripEnabled);
                    if (shellStripEnabled) {
                        runProviderRouteSwitch('wrapper-promotion');
                    }
                } else if (isPageRoute) {
                    runProviderRouteSwitch('page-route');
                } else if (isLoginPage) {
                    // Login pages only need the provider switch button in this flow.
                }

            } else {
                // === On the raw game page: run caching initialization & canvas logic ===
                // --- Phase 5.3 (Part 1): Expedition notifications parity ---
                var expeditionState = {
                    referenceTimeDiffMs: null,
                    expeditions: {},
                    expeditionGroups: [],
                    eventExpeditions: {},
                    eventExpeditionGroups: []
                };
                var masterData = {};
                var userData = {
                    userLevel: 0,
                    staminaMax: 0,
                    battlePointMax: 0,
                    staminaValue: 0,
                    staminaRecoverInterval: 180,
                    staminaRecoveryDateMs: null,
                    staminaRemainSec: 0,
                    staminaBonus: 0,
                    staminaIsFull: false,
                    battlePointValue: 0,
                    battlePointRecoverInterval: 600,
                    battlePointRecoveryDateMs: null,
                    battlePointRemainSec: 0,
                    battlePointBonus: 0,
                    battlePointIsFull: false,
                    estimatedstamina: 0,
                    estimatedstaminaRemainSec: 0,
                    estimatedBattlePoint: 0,
                    estimatedBattlePointRemainSec: 0,
                    hasData: false,
                    hasMasterData: false
                };
                var raidState = {
                    isInRaid: false,
                    hasScore: false,
                    hp: 0,
                    score: 0,
                    currentScore: 0
                };
                var sharedSettings = null;
                var runtimeConfig = readInitialRuntimeConfig();
                var audioSyncScheduled = false;
                var renderControlInstalled = false;

                function cloneSettings(settings) {
                    try {
                        return JSON.parse(JSON.stringify(settings || {}));
                    } catch (e) {
                        return {};
                    }
                }

                function normalizeSettings(settings) {
                    var source = settings && typeof settings === 'object' ? settings : {};
                    var notifications = source.notifications && typeof source.notifications === 'object' ? source.notifications : {};
                    var audio = source.audio && typeof source.audio === 'object' ? source.audio : {};

                    return {
                        notifications: {
                            battleEnd: notifications.battleEnd !== false,
                            raidDeath: notifications.raidDeath !== false,
                            expedition: notifications.expedition !== false,
                            eventExpedition: notifications.eventExpedition !== false,
                            stamina: notifications.stamina !== false,
                            battlepoint: notifications.battlepoint !== false
                        },
                        audio: {
                            muteAll: !!audio.muteAll,
                            muteBgm: !!audio.muteBgm,
                            muteSe: !!audio.muteSe
                        }
                    };
                }

                function readInitialSettings() {
                    if (window.electronAPI && typeof window.electronAPI.getSettings === 'function') {
                        return normalizeSettings(window.electronAPI.getSettings());
                    }
                    return normalizeSettings(null);
                }

                function readInitialRuntimeConfig() {
                    if (window.electronAPI && typeof window.electronAPI.getRuntimeConfig === 'function') {
                        var config = window.electronAPI.getRuntimeConfig();
                        if (config && typeof config === 'object') return config;
                    }
                    return {};
                }

                function refreshSharedSettings(settings) {
                    sharedSettings = normalizeSettings(settings);
                    return sharedSettings;
                }

                function isNotificationEnabled(type) {
                    if (!type) return true;
                    var notifications = sharedSettings && sharedSettings.notifications ? sharedSettings.notifications : {};
                    if (Object.prototype.hasOwnProperty.call(notifications, type)) {
                        return !!notifications[type];
                    }
                    return true;
                }

                function sendGameNotification(type, title, body, delay) {
                    if (!isNotificationEnabled(type)) return;
                    if (!window.electronAPI || typeof window.electronAPI.showNotification !== 'function') return;

                    var notify = function() {
                        var notifyResult = window.electronAPI.showNotification(title, body, type);
                        if (notifyResult && typeof notifyResult.then === 'function') {
                            notifyResult.then(function(result) {
                                console.log('[CSC][NotificationDebug] ' + type + ' result=' + JSON.stringify(result));
                            });
                        }
                    };

                    if (typeof delay === 'number' && delay > 0) {
                        setTimeout(notify, delay);
                    } else {
                        notify();
                    }
                }

                function getSoundManager() {
                    return window.Grobal && window.Grobal.SoundManager ? window.Grobal.SoundManager : null;
                }

                function applyAudioSettings() {
                    var soundManager = getSoundManager();
                    if (!soundManager) return false;

                    var audio = sharedSettings && sharedSettings.audio ? sharedSettings.audio : {};
                    var muteAll = !!audio.muteAll;
                    var muteBgm = !!audio.muteBgm;
                    var muteSe = !!audio.muteSe;

                    try {
                        if (typeof soundManager.setBgmMute === 'function') {
                            soundManager.setBgmMute(muteAll ? true : muteBgm);
                        }
                        if (typeof soundManager.setSeMute === 'function') {
                            soundManager.setSeMute(muteAll ? true : muteSe);
                        }
                        if (typeof soundManager.setBattleSeMute === 'function') {
                            soundManager.setBattleSeMute(muteAll ? true : muteSe);
                        }
                        if (typeof soundManager.setVoiceMute === 'function') {
                            soundManager.setVoiceMute(muteAll ? true : muteSe);
                        }
                    } catch (e) {}

                    return true;
                }

                function scheduleAudioSync() {
                    if (audioSyncScheduled) return;
                    audioSyncScheduled = true;
                    requestAnimationFrame(function() {
                        audioSyncScheduled = false;
                        if (!applyAudioSettings()) {
                            scheduleAudioSync();
                        }
                    });
                }

                function updateAudioFromCommand(command, payload) {
                    var enabled = null;
                    if (typeof payload === 'boolean') {
                        enabled = payload;
                    } else if (payload && typeof payload.enabled === 'boolean') {
                        enabled = payload.enabled;
                    } else if (payload && typeof payload.value === 'boolean') {
                        enabled = payload.value;
                    }

                    if (enabled == null) return;
                    if (!sharedSettings) {
                        refreshSharedSettings(readInitialSettings());
                    }

                    if (!sharedSettings.audio) {
                        sharedSettings.audio = { muteAll: false, muteBgm: false, muteSe: false };
                    }

                    if (command === 'setMuteAll') {
                        sharedSettings.audio.muteAll = !!enabled;
                        sharedSettings.audio.muteBgm = !!enabled;
                        sharedSettings.audio.muteSe = !!enabled;
                    } else if (command === 'setMuteBgm') {
                        sharedSettings.audio.muteBgm = !!enabled;
                        sharedSettings.audio.muteAll = sharedSettings.audio.muteBgm && sharedSettings.audio.muteSe;
                    } else if (command === 'setMuteSe') {
                        sharedSettings.audio.muteSe = !!enabled;
                        sharedSettings.audio.muteAll = sharedSettings.audio.muteBgm && sharedSettings.audio.muteSe;
                    }

                    applyAudioSettings();
                }

                var gameCanvas = null;
                var ambientCanvas = null;
                var mouseIsInside = true;
                var blackoutEnabled = false;
                var targetBrightness = 100;
                var currentBrightness = 100;
                var brightnessSettingTimeout = null;
                var lowFrameRateMode = 0;
                var lastRenderTime = 0;
                var frameRateControlInstalled = false;
                var blackoutBackgroundMode = false;

                function resolveBooleanPayload(payload) {
                    if (typeof payload === 'boolean') return payload;
                    if (payload && typeof payload.enabled === 'boolean') return payload.enabled;
                    if (payload && typeof payload.value === 'boolean') return payload.value;
                    return null;
                }

                function resolveFrameRatePayload(payload) {
                    if (typeof payload === 'number') return payload;
                    if (payload && typeof payload.fps === 'number') return payload.fps;
                    if (payload && typeof payload.value === 'number') return payload.value;
                    return 0;
                }

                function stopRender() {
                    if (skipRender) return;
                    skipRender = true;

                    if (renderGl) {
                        try {
                            renderGl.viewport(0, 0, renderGl.drawingBufferWidth, renderGl.drawingBufferHeight);
                            renderGl.clearColor(0.0, 0.0, 0.0, 1.0);
                            renderGl.clear(renderGl.COLOR_BUFFER_BIT);
                        } catch (e) {}
                    }
                }

                function resumeRender() {
                    if (!skipRender) return;
                    skipRender = false;
                }

                function setBrightness(brightness, delay) {
                    if (brightnessSettingTimeout) {
                        clearTimeout(brightnessSettingTimeout);
                        brightnessSettingTimeout = null;
                    }

                    if (delay === undefined) {
                        targetBrightness = brightness;
                        return;
                    }

                    brightnessSettingTimeout = setTimeout(function() {
                        targetBrightness = brightness;
                        brightnessSettingTimeout = null;
                    }, delay);
                }

                function applyBlackoutState() {
                    if (!gameCanvas) return;

                    if (!blackoutEnabled) {
                        setBrightness(100);
                        resumeRender();
                        return;
                    }

                    setBrightness(mouseIsInside ? 65 : 0, mouseIsInside ? undefined : 350);
                }

                function setMouseInsideState(isInside) {
                    if (mouseIsInside === isInside) return;
                    mouseIsInside = isInside;
                    if (blackoutEnabled) applyBlackoutState();
                }

                function applyFrameRateMode(fps) {
                    if (fps !== 0 && fps !== 30 && fps !== 15 && fps !== 5) fps = 0;
                    lowFrameRateMode = fps === 0 ? 0 : 1000 / fps;
                    lastRenderTime = 0;
                }

                function installFrameRateControl() {
                    if (frameRateControlInstalled) return;
                    if (!window.cc || !cc.renderer || typeof cc.renderer.render !== 'function') {
                        requestAnimationFrame(installFrameRateControl);
                        return;
                    }

                    var originalRender = cc.renderer.render;
                    cc.renderer.render = function() {
                        if (skipRender) return;

                        if (!lowFrameRateMode) {
                            return originalRender.apply(cc.renderer, arguments);
                        }

                        var now = Date.now();
                        if (now - lastRenderTime < lowFrameRateMode) return;
                        lastRenderTime = now;
                        return originalRender.apply(cc.renderer, arguments);
                    };
                    frameRateControlInstalled = true;
                }

                function startBlackoutAnimation() {
                    var lastTime = Date.now();

                    function brightnessAnimation() {
                        if (blackoutBackgroundMode) {
                            requestAnimationFrame(brightnessAnimation);
                            return;
                        }

                        var now = Date.now();
                        var delta = now - lastTime;
                        lastTime = now;

                        if (Math.abs(currentBrightness - 100) < 0.01 && targetBrightness <= 65) {
                            currentBrightness = 65;
                        }

                        var diff = targetBrightness - currentBrightness;
                        var step = diff * delta * 0.015;

                        if (targetBrightness > currentBrightness) {
                            currentBrightness = Math.min(currentBrightness + step, targetBrightness);
                        } else {
                            currentBrightness = Math.max(currentBrightness + step, targetBrightness);
                        }

                        if (gameCanvas) {
                            if (currentBrightness < 0.1) {
                                if (gameCanvas.style.filter) gameCanvas.style.filter = '';
                                stopRender();
                            } else if (Math.abs(targetBrightness - 100) < 0.01) {
                                if (gameCanvas.style.filter) gameCanvas.style.filter = '';
                                currentBrightness = 100;
                                resumeRender();
                            } else {
                                gameCanvas.style.filter = 'brightness(' + currentBrightness.toFixed(2) + '%)';
                                resumeRender();
                            }

                            if (ambientCanvas) {
                                ambientCanvas.style.filter = 'blur(128px) brightness(' + (currentBrightness * 0.75).toFixed(2) + '%)';
                            }
                        }

                        requestAnimationFrame(brightnessAnimation);
                    }

                    brightnessAnimation();
                }

                function writeCanvasToClipboardFallback() {
                    if (!gameCanvas) return false;
                    try {
                        var dataUrl = gameCanvas.toDataURL('image/png');
                        if (window.electronAPI && typeof window.electronAPI.copyImageToClipboard === 'function') {
                            return !!window.electronAPI.copyImageToClipboard(dataUrl);
                        }
                    } catch (e) {}
                    return false;
                }

                function screenshotToClipboard() {
                    if (!gameCanvas) return;

                    var fallback = function() {
                        writeCanvasToClipboardFallback();
                    };

                    try {
                        if (
                            typeof gameCanvas.toBlob === 'function' &&
                            window.ClipboardItem &&
                            navigator.clipboard &&
                            typeof navigator.clipboard.write === 'function'
                        ) {
                            gameCanvas.toBlob(function(blob) {
                                if (!blob) {
                                    fallback();
                                    return;
                                }

                                try {
                                    var item = new ClipboardItem({ 'image/png': blob });
                                    navigator.clipboard.write([item]).catch(function() {
                                        fallback();
                                    });
                                } catch (e) {
                                    fallback();
                                }
                            }, 'image/png');
                            return;
                        }
                    } catch (e) {}

                    fallback();
                }

                var lastPublishedStatus = '';

                function publishTrayStatus(statusEntries) {
                    if (!window.electronAPI || typeof window.electronAPI.updateTrayStatus !== 'function') return;

                    var statusString = statusEntries && statusEntries.length > 0 ? statusEntries.join(' | ') : '';

                    if (statusString === lastPublishedStatus) return;
                    lastPublishedStatus = statusString;

                    window.electronAPI.updateTrayStatus({ status: statusString });
                }

                function parseGameDateToMs(dateStr) {
                    if (!dateStr || typeof dateStr !== 'string' || dateStr.length < 14) return null;
                    var y = parseInt(dateStr.slice(0, 4), 10);
                    var m = parseInt(dateStr.slice(4, 6), 10);
                    var d = parseInt(dateStr.slice(6, 8), 10);
                    var hh = parseInt(dateStr.slice(8, 10), 10);
                    var mm = parseInt(dateStr.slice(10, 12), 10);
                    var ss = parseInt(dateStr.slice(12, 14), 10);
                    if (isNaN(y) || isNaN(m) || isNaN(d) || isNaN(hh) || isNaN(mm) || isNaN(ss)) return null;
                    return new Date(y, m - 1, d, hh, mm, ss).getTime();
                }

                function decodeResponsePayload(xhr) {
                    try {
                        var content = xhr && xhr.response;
                        if (typeof content === 'string' && content.length > 0) {
                            return JSON.parse(content);
                        }

                        if (content && typeof content === 'object') {
                            if (window.electronAPI && typeof window.electronAPI.decodeMsgpack === 'function') {
                                var decoded = window.electronAPI.decodeMsgpack(content);
                                if (decoded) return decoded;
                            }
                            return content;
                        }

                        if (typeof xhr.responseText === 'string' && xhr.responseText.length > 0) {
                            return JSON.parse(xhr.responseText);
                        }
                    } catch (e) {}
                    return null;
                }

                function systemDateUpdate(systemDate) {
                    var gameMs = parseGameDateToMs(systemDate);
                    if (gameMs == null) return;
                    expeditionState.referenceTimeDiffMs = gameMs - Date.now();
                }

                function updateTime(data) {
                    try {
                        var systemDate = data && data.systemDate;
                        systemDateUpdate(systemDate);
                    } catch (e) {}
                }

                function updateUser(data) {
                    try {
                        var user = data && data.user;
                        if (!user) return;
                        var systemDate = user.systemDate;
                        systemDateUpdate(systemDate);

                        userData.userLevel = user.level || 0;
                        userData.staminaValue = user.staminaValue || 0;
                        userData.staminaBonus = user.staminaBonus || 0;
                        userData.staminaRecoveryDateMs = parseGameDateToMs(user.staminaRecoveryDate);
                        userData.staminaRemainSec = user.staminaRemainSec || 0;
                        userData.battlePointValue = user.battlePointValue || 0;
                        userData.battlePointBonus = user.battlePointBonus || 0;
                        userData.battlePointRecoveryDateMs = parseGameDateToMs(user.battlePointRecoveryDate);
                        userData.battlePointRemainSec = user.battlePointRemainSec || 0;
                        userData.hasData = true;

                        processUserMasterData();
                    } catch (e) {}
                }

                function processUserMasterData() {
                    try {
                        var userMaster = masterData && masterData.user;
                        var userMain = userMaster && userMaster.UserMain;
                        if (!userMain) return;
                        var levelData = userMain[userData.userLevel - 1];
                        if (!levelData) return;

                        userData.staminaMax = levelData.maxStamina || 0;
                        userData.battlePointMax = levelData.maxBattlePoint || 0;
                        userData.staminaIsFull = userData.staminaValue >= userData.staminaMax;
                        userData.battlePointIsFull = userData.battlePointValue >= userData.battlePointMax;
                        userData.hasMasterData = true;
                    } catch (e) {}
                }

                function processMasterData(pathname, data) {
                    try {
                        // 路徑可能帶數字後綴（如 getMasterData1、getMasterData2），表示分頁資料
                        var matched = pathname && pathname.match(/^\\/gg\\/(.+)\\/getMasterData\\d*$/);
                        var masterDataType = matched && matched[1];
                        if (!masterDataType) return;
                        if (!masterData[masterDataType]) {
                            masterData[masterDataType] = data;
                        } else {
                            // 合併分頁資料：陣列型欄位 concat，其他欄位覆寫
                            var existing = masterData[masterDataType];
                            for (var key in data) {
                                if (Array.isArray(data[key]) && Array.isArray(existing[key])) {
                                    existing[key] = existing[key].concat(data[key]);
                                } else {
                                    existing[key] = data[key];
                                }
                            }
                        }
                        processUserMasterData();
                    } catch (e) {}
                }

                function gameDateNowMs() {
                    if (expeditionState.referenceTimeDiffMs == null) return null;
                    return Date.now() + expeditionState.referenceTimeDiffMs;
                }

                function groupExpeditions() {
                    expeditionState.expeditionGroups.splice(0, expeditionState.expeditionGroups.length);
                    var ids = Object.keys(expeditionState.expeditions);
                    for (var i = 0; i < ids.length; i++) {
                        var id = ids[i];
                        var endMs = expeditionState.expeditions[id];
                        var existingGroup = null;
                        for (var j = 0; j < expeditionState.expeditionGroups.length; j++) {
                            var group = expeditionState.expeditionGroups[j];
                            if (Math.abs(group.endTime - endMs) < 60000) {
                                existingGroup = group;
                                break;
                            }
                        }
                        if (existingGroup) {
                            existingGroup.ids.push(id);
                            existingGroup.endTime = Math.max(existingGroup.endTime, endMs);
                        } else {
                            expeditionState.expeditionGroups.push({ endTime: endMs, ids: [id] });
                        }
                    }
                }

                function updateExpeditions(data) {
                    try {
                        var gameNow = gameDateNowMs();
                        if (gameNow == null) return 0;

                        var expeditionData = data && data.expeditions;
                        if (!expeditionData) return 0;

                        for (var i = 0; i < expeditionData.length; i++) {
                            var expedition = expeditionData[i];
                            if (!expedition) continue;
                            if (!expedition.endDate) continue;
                            if (!expedition.startDate) continue;

                            var endMs = parseGameDateToMs(expedition.endDate);
                            if (endMs == null) continue;

                            var id = expedition.slotId;
                            if (id == null) continue;
                            id = String(id);

                            if (endMs < gameNow || expedition.receiveDate) {
                                if (expeditionState.expeditions[id]) {
                                    delete expeditionState.expeditions[id];
                                }
                                continue;
                            }

                            expeditionState.expeditions[id] = endMs;
                            groupExpeditions();
                        }

                        return expeditionData.length || 0;
                    } catch (e) {
                        return 0;
                    }
                }

                function groupEventExpeditions() {
                    expeditionState.eventExpeditionGroups.splice(0, expeditionState.eventExpeditionGroups.length);
                    var ids = Object.keys(expeditionState.eventExpeditions);
                    for (var i = 0; i < ids.length; i++) {
                        var id = ids[i];
                        var endMs = expeditionState.eventExpeditions[id];
                        var existingGroup = null;
                        for (var j = 0; j < expeditionState.eventExpeditionGroups.length; j++) {
                            var group = expeditionState.eventExpeditionGroups[j];
                            if (Math.abs(group.endTime - endMs) < 60000) {
                                existingGroup = group;
                                break;
                            }
                        }
                        if (existingGroup) {
                            existingGroup.ids.push(id);
                            existingGroup.endTime = Math.max(existingGroup.endTime, endMs);
                        } else {
                            expeditionState.eventExpeditionGroups.push({ endTime: endMs, ids: [id] });
                        }
                    }
                }

                function updateEventExpeditions(data) {
                    try {
                        var gameNow = gameDateNowMs();
                        if (gameNow == null) return 0;

                        var expeditionData = data && data.eventExpeditions;
                        if (!expeditionData) return 0;

                        for (var i = 0; i < expeditionData.length; i++) {
                            var expedition = expeditionData[i];
                            if (!expedition) continue;
                            if (!expedition.endDate) continue;
                            if (!expedition.startDate) continue;

                            var endMs = parseGameDateToMs(expedition.endDate);
                            if (endMs == null) continue;

                            var id = expedition.slotId;
                            if (id == null) continue;
                            id = String(id);

                            if (endMs < gameNow || expedition.receiveDate) {
                                if (expeditionState.eventExpeditions[id]) {
                                    delete expeditionState.eventExpeditions[id];
                                }
                                continue;
                            }

                            expeditionState.eventExpeditions[id] = endMs;
                            groupEventExpeditions();
                        }

                        return expeditionData.length || 0;
                    } catch (e) {
                        return 0;
                    }
                }

                function updateRaidBattle(data) {
                    try {
                        if (data && data.raidStatus) {
                            raidState.hp = data.raidStatus.currentHp;
                            raidState.isInRaid = true;
                            return;
                        }
                        if (data && data.currentHp) {
                            raidState.hp = data.currentHp;
                            raidState.currentScore = data.score;
                            raidState.isInRaid = true;
                        } else {
                            raidState.isInRaid = false;
                            raidState.hasScore = false;
                            raidState.hp = 0;
                            raidState.score = 0;
                            raidState.currentScore = 0;
                        }
                    } catch (e) {}
                }

                function endRaidBattle() {
                    raidState.isInRaid = false;
                    raidState.hasScore = false;
                    raidState.hp = 0;
                    raidState.score = 0;
                    raidState.currentScore = 0;
                }

                var resourceDownloadState = {
                    active: false,
                    total: 0,
                    completed: 0,
                    failed: 0
                };
                var downloadOverlayRoot = null;
                var downloadOverlayBar = null;
                var downloadOverlayText = null;
                var downloadOverlayPath = null;

                function ensureDownloadOverlay() {
                    if (downloadOverlayRoot) return;

                    downloadOverlayRoot = document.createElement('div');
                    downloadOverlayRoot.style.position = 'fixed';
                    downloadOverlayRoot.style.top = '12px';
                    downloadOverlayRoot.style.right = '12px';
                    downloadOverlayRoot.style.width = '280px';
                    downloadOverlayRoot.style.padding = '10px';
                    downloadOverlayRoot.style.background = '#000c';
                    downloadOverlayRoot.style.color = '#fff';
                    downloadOverlayRoot.style.fontSize = '12px';
                    downloadOverlayRoot.style.borderRadius = '8px';
                    downloadOverlayRoot.style.zIndex = '2147483647';
                    downloadOverlayRoot.style.pointerEvents = 'none';
                    downloadOverlayRoot.style.display = 'none';

                    var progressTrack = document.createElement('div');
                    progressTrack.style.width = '100%';
                    progressTrack.style.height = '8px';
                    progressTrack.style.background = '#222';
                    progressTrack.style.borderRadius = '999px';
                    progressTrack.style.overflow = 'hidden';
                    progressTrack.style.marginBottom = '6px';

                    downloadOverlayBar = document.createElement('div');
                    downloadOverlayBar.style.width = '0%';
                    downloadOverlayBar.style.height = '100%';
                    downloadOverlayBar.style.background = '#1e90ff';
                    downloadOverlayBar.style.transition = 'width 120ms linear';
                    progressTrack.appendChild(downloadOverlayBar);

                    downloadOverlayText = document.createElement('div');
                    downloadOverlayText.style.lineHeight = '1.4';
                    downloadOverlayText.textContent = 'Preparing resource download...';

                    downloadOverlayPath = createPathLabel();

                    downloadOverlayRoot.appendChild(progressTrack);
                    downloadOverlayRoot.appendChild(downloadOverlayText);
                    downloadOverlayRoot.appendChild(downloadOverlayPath);
                    document.body.appendChild(downloadOverlayRoot);
                }

                function updateDownloadOverlay(label, progressFraction) {
                    ensureDownloadOverlay();
                    if (!downloadOverlayRoot || !downloadOverlayBar || !downloadOverlayText) return;

                    var clampedFraction = typeof progressFraction === 'number' && isFinite(progressFraction)
                        ? Math.max(0, Math.min(1, progressFraction))
                        : 0;
                    downloadOverlayRoot.style.display = 'block';
                    downloadOverlayBar.style.width = String(clampedFraction * 100) + '%';
                    downloadOverlayText.textContent = label || '';
                }

                function hideDownloadOverlay(delayMs) {
                    if (!downloadOverlayRoot) return;
                    setTimeout(function() {
                        if (!resourceDownloadState.active && downloadOverlayRoot) {
                            downloadOverlayRoot.style.display = 'none';
                        }
                    }, delayMs || 0);
                }

                function setDownloadOverlayPath(folderPath) {
                    ensureDownloadOverlay();
                    if (!downloadOverlayPath) return;
                    downloadOverlayPath.textContent = typeof folderPath === 'string' && folderPath ? folderPath : '';
                }

                function waitForResourceManifest(timeoutMs) {
                    var maxWait = typeof timeoutMs === 'number' ? timeoutMs : 15000;
                    var startAt = Date.now();

                    return new Promise(function(resolve) {
                        function check() {
                            try {
                                if (typeof __require !== 'function') {
                                    if (Date.now() - startAt > maxWait) {
                                        resolve(null);
                                        return;
                                    }
                                    requestAnimationFrame(check);
                                    return;
                                }

                                var singleton = __require('Singleton');
                                var assetLoader = singleton && singleton.assetLoader;
                                var manifest = assetLoader && assetLoader._manifest && assetLoader._manifest._data && assetLoader._manifest._data._data;
                                if (assetLoader && manifest) {
                                    resolve({ assetLoader: assetLoader, manifest: manifest });
                                    return;
                                }

                                if (Date.now() - startAt > maxWait) {
                                    resolve(null);
                                    return;
                                }
                            } catch (e) {
                                if (Date.now() - startAt > maxWait) {
                                    resolve(null);
                                    return;
                                }
                            }
                            requestAnimationFrame(check);
                        }
                        check();
                    });
                }

                function collectManifestAssetUrls(assetLoader, manifest) {
                    if (!assetLoader || !manifest || typeof manifest !== 'object') return [];
                    var manifestAssets = manifest.assets && typeof manifest.assets === 'object' ? manifest.assets : {};
                    var urlSet = new Set();
                    for (var key in manifestAssets) {
                        if (!Object.prototype.hasOwnProperty.call(manifestAssets, key)) continue;
                        try {
                            var assetUrl = assetLoader.getAssetUrl(key);
                            if (typeof assetUrl === 'string' && assetUrl) {
                                urlSet.add(assetUrl);
                            }
                        } catch (e) {}
                    }
                    return Array.from(urlSet);
                }

                function fetchWithRetry(url, retries) {
                    var attempts = typeof retries === 'number' ? retries : 3;
                    var currentAttempt = 0;

                    function tryFetch() {
                        currentAttempt += 1;
                        return fetch(url, { credentials: 'include' }).then(function(response) {
                            if (!response || !response.ok) {
                                if (currentAttempt < attempts) return tryFetch();
                                throw new Error('HTTP ' + (response ? response.status : '0'));
                            }
                            return response;
                        }).catch(function(error) {
                            if (currentAttempt < attempts) return tryFetch();
                            throw error;
                        });
                    }

                    return tryFetch();
                }

                function runTaskQueue(tasks, maxConcurrency, onTaskDone) {
                    var concurrency = Math.max(1, maxConcurrency || 1);
                    var total = tasks.length;
                    if (total === 0) return Promise.resolve();

                    return new Promise(function(resolve) {
                        var inFlight = 0;
                        var nextIndex = 0;
                        var completed = 0;

                        function launch() {
                            while (inFlight < concurrency && nextIndex < total) {
                                var task = tasks[nextIndex];
                                nextIndex += 1;
                                inFlight += 1;
                                Promise.resolve()
                                    .then(task)
                                    .catch(function() { return null; })
                                    .then(function() {
                                        completed += 1;
                                        inFlight -= 1;
                                        if (typeof onTaskDone === 'function') onTaskDone(completed, total);
                                        if (completed >= total) {
                                            resolve();
                                            return;
                                        }
                                        launch();
                                    });
                            }
                        }

                        launch();
                    });
                }

                async function startResourceDownload() {
                    if (resourceDownloadState.active) {
                        updateDownloadOverlay(
                            'Download already running...',
                            resourceDownloadState.total > 0 ? resourceDownloadState.completed / resourceDownloadState.total : 0
                        );
                        return;
                    }

                    resourceDownloadState.active = true;
                    resourceDownloadState.total = 0;
                    resourceDownloadState.completed = 0;
                    resourceDownloadState.failed = 0;
                    updateDownloadOverlay('Preparing resource manifest...', 0);

                    setDownloadOverlayPath('');
                    var cacheFolderPath = window.electronAPI && typeof window.electronAPI.getCacheFolder === 'function'
                        ? await window.electronAPI.getCacheFolder()
                        : null;

                    try {
                        var manifestResult = await waitForResourceManifest(20000);
                        if (!manifestResult || !manifestResult.assetLoader || !manifestResult.manifest) {
                            updateDownloadOverlay('Manifest unavailable. Retry after loading game assets.', 0);
                            hideDownloadOverlay(4000);
                            return;
                        }

                        var assets = collectManifestAssetUrls(manifestResult.assetLoader, manifestResult.manifest);
                        resourceDownloadState.total = assets.length;
                        if (assets.length === 0) {
                            updateDownloadOverlay('No downloadable resources found.', 1);
                            hideDownloadOverlay(2500);
                            return;
                        }

                        updateDownloadOverlay('Downloading 0/' + assets.length, 0);

                        var tasks = assets.map(function(assetUrl) {
                            return function() {
                                return fetchWithRetry(assetUrl, 3)
                                    .catch(function() {
                                        resourceDownloadState.failed += 1;
                                    })
                                    .then(function() {
                                        resourceDownloadState.completed += 1;
                                        var ratio = resourceDownloadState.total > 0
                                            ? resourceDownloadState.completed / resourceDownloadState.total
                                            : 1;
                                        var failedPart = resourceDownloadState.failed > 0
                                            ? ' (failed: ' + resourceDownloadState.failed + ')'
                                            : '';
                                        updateDownloadOverlay(
                                            'Downloading ' + resourceDownloadState.completed + '/' + resourceDownloadState.total + failedPart,
                                            ratio
                                        );
                                        if (cacheFolderPath) {
                                            setDownloadOverlayPath(cacheFolderPath + '/' + getFilenameFromUrl(assetUrl));
                                        }
                                    });
                            };
                        });

                        await runTaskQueue(tasks, 3);

                        if (resourceDownloadState.failed > 0) {
                            updateDownloadOverlay(
                                'Completed with ' + resourceDownloadState.failed + ' failed. Re-run to retry.',
                                1
                            );
                        } else {
                            updateDownloadOverlay('Download complete: ' + resourceDownloadState.total + ' assets', 1);
                        }
                        hideDownloadOverlay(3000);
                    } catch (error) {
                        console.error('[CSC] Resource download failed:', error);
                        updateDownloadOverlay('Download failed. Please retry.', 0);
                        hideDownloadOverlay(4000);
                    } finally {
                        resourceDownloadState.active = false;
                    }
                }

                function loadCustomScripts() {
                    if (window.__cscCustomLoaderStarted) return;
                    window.__cscCustomLoaderStarted = true;

                    if (!window.electronAPI || typeof window.electronAPI.getCustomScripts !== 'function') return;

                    function ensureCustomEngineBridge() {
                        if (!window.__cscBridge || typeof window.__cscBridge !== 'object') {
                            window.__cscBridge = {};
                        }
                        if (!window.__cscBridge.engine || typeof window.__cscBridge.engine !== 'object') {
                            window.__cscBridge.engine = {};
                        }
                        var engine = window.__cscBridge.engine;
                        engine.gameCanvas = gameCanvas;
                        engine.document = document;
                        engine.masterData = masterData;
                        return engine;
                    }

                    function waitForEngineAndRun() {
                        if (typeof __require !== 'function' || typeof window.cc !== 'object' || !gameCanvas) {
                            requestAnimationFrame(waitForEngineAndRun);
                            return;
                        }

                        try {
                            __require('Singleton');
                        } catch (error) {
                            requestAnimationFrame(waitForEngineAndRun);
                            return;
                        }

                        var customEngine = ensureCustomEngineBridge();
                        customEngine.require = __require;
                        customEngine.cc = window.cc;

                        window.electronAPI.getCustomScripts().then(function(scripts) {
                            if (!Array.isArray(scripts) || scripts.length === 0) return;

                            var customContext = {
                                window: window,
                                document: document,
                                gameCanvas: gameCanvas,
                                masterData: masterData,
                                engine: customEngine,
                                cscBridge: window.__cscBridge,
                                sendNotification: sendGameNotification,
                                runCommand: function(command, payload) {
                                    if (!window.electronAPI || typeof window.electronAPI.runCommand !== 'function') {
                                        return Promise.resolve({ ok: false, error: 'API_UNAVAILABLE' });
                                    }
                                    return window.electronAPI.runCommand(command, payload);
                                }
                            };

                            for (var i = 0; i < scripts.length; i++) {
                                var script = scripts[i];
                                if (!script || typeof script.code !== 'string') continue;
                                var sourceName = script.source || script.id || ('custom-' + (i + 1) + '.js');
                                try {
                                    var wrappedSource = script.code + '\\n//# sourceURL=' + encodeURI(sourceName);
                                    var evaluator = new Function('context', wrappedSource);
                                    evaluator(customContext);
                                    console.log('[CSC][Custom] Loaded', sourceName);
                                } catch (error) {
                                    console.error('[CSC][Custom] Failed to load', sourceName, error);
                                }
                            }
                        }).catch(function(error) {
                            console.error('[CSC][Custom] Loader error:', error);
                        });
                    }

                    waitForEngineAndRun();
                }

                function handleRendererCommand(command, payload) {
                    if (command === 'setMuteAll' || command === 'setMuteBgm' || command === 'setMuteSe') {
                        updateAudioFromCommand(command, payload);
                        return;
                    }

                    if (command === 'setBlackout') {
                        var enabled = resolveBooleanPayload(payload);
                        blackoutEnabled = enabled == null ? !blackoutEnabled : enabled;
                        applyBlackoutState();
                        return;
                    }

                    if (command === 'setWindowPointerInside') {
                        var isInside = resolveBooleanPayload(payload);
                        if (isInside == null) return;
                        setMouseInsideState(!!isInside);
                        return;
                    }

                    if (command === 'setFrameRate') {
                        applyFrameRateMode(resolveFrameRatePayload(payload));
                        return;
                    }

                    if (command === 'screenshotToClipboard') {
                        screenshotToClipboard();
                        return;
                    }

                    if (command === 'downloadResources') {
                        startResourceDownload();
                    }
                }

                function installMainEventBridge() {
                    if (window.__cscMainEventBridgeInstalled) return;
                    if (!window.electronAPI || typeof window.electronAPI.onMainEvent !== 'function') return;

                    window.electronAPI.onMainEvent(function(event) {
                        if (!event) return;
                        if (event.type === 'settings-updated' && event.payload) {
                            refreshSharedSettings(event.payload);
                            scheduleAudioSync();
                            return;
                        }
                        if (event.type !== 'renderer-command') return;
                        var command = event.payload && event.payload.command;
                        var payload = event.payload && event.payload.payload;
                        handleRendererCommand(command, payload);
                    });

                    window.__cscMainEventBridgeInstalled = true;
                }

                function processApiResponse(pathname, data) {
                    if (!pathname || !data) return;

                    if (/\\/getMasterData\\d*$/.test(pathname)) {
                        processMasterData(pathname, data);
                    } else if (/\\/user\\/getSystemDate$/.test(pathname)) {
                        updateTime(data);
                    } else if (/\\/raid\\/updateBattle$/.test(pathname)) {
                        updateRaidBattle(data);
                    } else if (/\\/raid\\/joinBattle$/.test(pathname) || /\\/raid\\/resumeBattle$/.test(pathname) || /\\/raid\\/appearBattle$/.test(pathname)) {
                        updateRaidBattle(data);
                    } else if (/endBattle$/.test(pathname)) {
                        endRaidBattle();
                        sendGameNotification('battleEnd', 'Crave Saga', 'Battle has ended', 3500);
                    }

                    updateUser(data);
                    var expeditionCount = updateExpeditions(data);
                    var eventExpeditionCount = updateEventExpeditions(data);
                    console.log('[CSC][ExpeditionDebug] pathname=' + pathname + ' expeditionCount=' + expeditionCount + ' eventExpeditionCount=' + eventExpeditionCount);
                }

                function installExpeditionRequestHook() {
                    if (window.__cscExpeditionHookInstalled) return;
                    window.__cscExpeditionHookInstalled = true;

                    var originalOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function () {
                        this.addEventListener('readystatechange', function () {
                            if (this.readyState !== 4) return;
                            try {
                                var rawUrl = this.responseURL;
                                if (!rawUrl) return;
                                var url = new URL(rawUrl, window.location.origin);
                                document.dispatchEvent(new CustomEvent('responseReceived', { detail: { req: this } }));
                                if (!url.pathname || url.pathname.indexOf('/gg/') !== 0) return;
                                var data = decodeResponsePayload(this);
                                processApiResponse(url.pathname, data);
                            } catch (e) {}
                        }, false);
                        return originalOpen.apply(this, arguments);
                    };
                }

                function startExpeditionNotifier() {
                    if (window.__cscExpeditionTickerStarted) return;
                    window.__cscExpeditionTickerStarted = true;

                    setInterval(function () {
                        var statusEntries = [];
                        var now = gameDateNowMs();
                        if (now == null) return;

                        for (var i = 0; i < expeditionState.expeditionGroups.length; i++) {
                            var group = expeditionState.expeditionGroups[i];
                            if (now > group.endTime) {
                                var ids = group.ids.map(function(id) { return '#' + id; });
                                var message = ids.length > 1
                                    ? 'Expeditions ' + ids.join(',') + ' has finished'
                                    : 'Expedition ' + ids[0] + ' has finished';

                                console.log('[CSC][ExpeditionDebug] notify=' + message);
                                sendGameNotification('expedition', 'Crave Saga', message);

                                for (var j = 0; j < group.ids.length; j++) {
                                    delete expeditionState.expeditions[group.ids[j]];
                                }
                                groupExpeditions();
                                i = -1;
                            }
                        }

                        for (var i = 0; i < expeditionState.eventExpeditionGroups.length; i++) {
                            var group = expeditionState.eventExpeditionGroups[i];
                            if (now > group.endTime) {
                                var ids = group.ids.map(function(id) { return '#' + id; });
                                var message = ids.length > 1
                                    ? 'Event Expeditions ' + ids.join(',') + ' has finished'
                                    : 'Event Expedition ' + ids[0] + ' has finished';

                                console.log('[CSC][ExpeditionDebug] notify=' + message);
                                sendGameNotification('eventExpedition', 'Crave Saga', message);

                                for (var j = 0; j < group.ids.length; j++) {
                                    delete expeditionState.eventExpeditions[group.ids[j]];
                                }
                                groupEventExpeditions();
                                i = -1;
                            }
                        }

                        if (userData.hasData && userData.hasMasterData) {
                            var isstaminaFull = userData.staminaIsFull;
                            var isBattlePointFull = userData.battlePointIsFull;
                            var staminaStartTimeMs =
                                userData.staminaRecoveryDateMs != null
                                    ? userData.staminaRecoveryDateMs - userData.staminaRemainSec * 1000
                                    : null;
                            var staminaInterval = userData.staminaRecoverInterval || 180;
                            if (staminaStartTimeMs != null && staminaInterval > 0) {
                                var staminaDiffSec = (now - staminaStartTimeMs) / 1000;
                                var staminaRecoverCount = Math.floor(staminaDiffSec / staminaInterval);
                                userData.estimatedstamina = Math.min(
                                    userData.staminaMax,
                                    userData.staminaValue + staminaRecoverCount
                                );
                                userData.estimatedstaminaRemainSec = Math.ceil(
                                    staminaInterval - (staminaDiffSec % staminaInterval)
                                );
                                isstaminaFull = userData.estimatedstamina >= userData.staminaMax;
                                if (!userData.staminaIsFull && isstaminaFull) {
                                    userData.staminaIsFull = true;
                                    sendGameNotification('stamina', 'Crave Saga', 'AP has fully recovered');
                                }
                            }

                            var staminaString = isstaminaFull
                                ? 'AP: ' + (userData.estimatedstamina + userData.staminaBonus) + '/' + userData.staminaMax
                                : 'AP: ' + (userData.estimatedstamina + userData.staminaBonus) + '/' + userData.staminaMax + ' (' + userData.estimatedstaminaRemainSec + 's)';
                            statusEntries.push(staminaString);

                            var battlePointStartTimeMs =
                                userData.battlePointRecoveryDateMs != null
                                    ? userData.battlePointRecoveryDateMs - userData.battlePointRemainSec * 1000
                                    : null;
                            var battlePointInterval = userData.battlePointRecoverInterval || 600;
                            if (battlePointStartTimeMs != null && battlePointInterval > 0) {
                                var battlePointDiffSec = (now - battlePointStartTimeMs) / 1000;
                                var battlePointRecoverCount = Math.floor(battlePointDiffSec / battlePointInterval);
                                userData.estimatedBattlePoint = Math.min(
                                    userData.battlePointMax,
                                    userData.battlePointValue + battlePointRecoverCount
                                );
                                userData.estimatedBattlePointRemainSec = Math.ceil(
                                    battlePointInterval - (battlePointDiffSec % battlePointInterval)
                                );
                                isBattlePointFull = userData.estimatedBattlePoint >= userData.battlePointMax;
                                if (!userData.battlePointIsFull && isBattlePointFull) {
                                    userData.battlePointIsFull = true;
                                    sendGameNotification('battlepoint', 'Crave Saga', 'RP has fully recovered');
                                }
                            }

                            var battlePointString = isBattlePointFull
                                ? 'RP: ' + (userData.estimatedBattlePoint + userData.battlePointBonus) + '/' + userData.battlePointMax
                                : 'RP: ' + (userData.estimatedBattlePoint + userData.battlePointBonus) + '/' + userData.battlePointMax + ' (' + userData.estimatedBattlePointRemainSec + 's)';
                            statusEntries.push(battlePointString);
                        }

                        if (raidState.isInRaid) {
                            if (raidState.currentScore != null) raidState.score = raidState.currentScore;
                            statusEntries.push('Raid Boss HP: ' + raidState.hp);
                            if (raidState.score) statusEntries.push('Raid Damage: ' + raidState.score);
                            if (!raidState.hasScore && raidState.currentScore != null) {
                                raidState.hasScore = true;
                            } else if (raidState.hasScore && raidState.currentScore == null) {
                                raidState.hasScore = false;
                                sendGameNotification(
                                    'raidDeath',
                                    'Crave Saga',
                                    'Your team has been defeated in raid battle.'
                                );
                            }
                        }

                        publishTrayStatus(statusEntries);
                    }, 1000);
                }

                installExpeditionRequestHook();
                startExpeditionNotifier();
                refreshSharedSettings(readInitialSettings());
                scheduleAudioSync();
                installMainEventBridge();
                loadCustomScripts();
                if (window.electronAPI && typeof window.electronAPI.markProviderSuccess === 'function') {
                    try {
                        var markSuccessPromise = window.electronAPI.markProviderSuccess({ success: true });
                        if (markSuccessPromise && typeof markSuccessPromise.then === 'function') {
                            markSuccessPromise.catch(function() { return null; });
                        }
                    } catch (e) {}
                }
                // --- Phase 3: Resource Caching Implementation ---
                function injectFontOverrideCss() {
                    if (
                        !window.electronAPI ||
                        typeof window.electronAPI.getFontOverrideCss !== 'function'
                    ) return;
                    if (window.__cscFontOverrideCssInstalling) return;
                    window.__cscFontOverrideCssInstalling = true;

                    function disableCompetingFontFaces() {
                        let styles = document.querySelectorAll ? document.querySelectorAll('style') : [];
                        for (let i = 0; i < styles.length; i++) {
                            let styleNode = styles[i];
                            if (!styleNode || styleNode.id === 'csc-font-override-css') continue;
                            let text = styleNode.textContent || '';
                            if (/@font-face/i.test(text) && /(?:ResourceHanRounded(?:TW|CN)|TTF-NPRodin|UDKakugo_LargePr6N)/.test(text)) {
                                styleNode.disabled = true;
                            }
                        }
                    }

                    function refreshFontOverrideLabels() {
                        if (!window.cc || !cc.director || typeof cc.director.getScene !== 'function' || !cc.Label) return;
                        let now = Date.now();
                        if (window.__cscFontOverrideLabelRefreshAt && now - window.__cscFontOverrideLabelRefreshAt < 1000) return;
                        window.__cscFontOverrideLabelRefreshAt = now;

                        function walk(node) {
                            if (!node) return;
                            let label = node.getComponent && node.getComponent(cc.Label);
                            if (label) {
                                let font = label.font || label._font;
                                let fontName = (font && (font._name || font.name || font._native)) || label.fontFamily || label._fontFamily || '';
                                if (/(?:ResourceHanRounded(?:TW|CN)|TTF-NPRodin|UDKakugo_LargePr6N)/.test(fontName)) {
                                    if (typeof label._forceUpdateRenderData === 'function') label._forceUpdateRenderData();
                                    if (typeof label.setVertsDirty === 'function') label.setVertsDirty();
                                    if (typeof label.markForUpdateRenderData === 'function') label.markForUpdateRenderData();
                                }
                            }
                            let children = node.children || [];
                            for (let i = 0; i < children.length; i++) walk(children[i]);
                        }

                        walk(cc.director.getScene());
                    }

                    window.electronAPI.getFontOverrideCss().then(css => {
                        if (!css) return;
                        let target = document.head || document.documentElement;
                        if (!target) return;

                        function ensureFontOverrideCss() {
                            disableCompetingFontFaces();
                            let style = document.getElementById ? document.getElementById('csc-font-override-css') : null;
                            if (!style) {
                                style = document.createElement('style');
                                style.id = 'csc-font-override-css';
                                style.type = 'text/css';
                                style.textContent = css;
                            }
                            if (style.parentNode !== target || target.lastChild !== style) {
                                target.appendChild(style);
                            }
                            refreshFontOverrideLabels();
                        }

                        ensureFontOverrideCss();
                        if (!window.__cscFontOverrideCssObserver && typeof MutationObserver === 'function') {
                            window.__cscFontOverrideCssObserver = new MutationObserver(() => {
                                setTimeout(ensureFontOverrideCss, 0);
                            });
                            window.__cscFontOverrideCssObserver.observe(target, { childList: true });
                        }
                        if (!window.__cscFontOverrideCssTimer) {
                            window.__cscFontOverrideCssTimer = setInterval(ensureFontOverrideCss, 1000);
                        }
                        if (!window.__cscFontOverrideCssInjected) {
                            window.__cscFontOverrideCssInjected = true;
                            console.log('[CSC] Injected font override CSS');
                        }
                    }).catch(() => {}).finally(() => {
                        window.__cscFontOverrideCssInstalling = false;
                    });
                }
                function prepareCacheLoader() {
                    if (
                        typeof __require !== 'function' ||
                        typeof window.cc !== 'object' ||
                        !window.cc.assetManager ||
                        !window.cc.assetManager.packManager
                    ) {
                        requestAnimationFrame(prepareCacheLoader);
                        return;
                    }
                    
                    try { __require('Singleton'); } catch(e) { requestAnimationFrame(prepareCacheLoader); return; }

                    let env = __require('Singleton').Environment;
                    if (!env) { requestAnimationFrame(prepareCacheLoader); return; }
                    let version = env.getWebClientVersion();
                    if (!version) { requestAnimationFrame(prepareCacheLoader); return; }

                    let clientHost = window.location.protocol + '//' + window.location.host + '/';
                    window.electronAPI.setCacheConfig({
                        clientVersion: version,
                        clientHost: clientHost,
                        fontOverrideVersion: fontOverrideVersion
                    });

                    let packManager = window.cc.assetManager.packManager;
                    if (!packManager.__cscOriginalLoad && typeof packManager.load === 'function') {
                        packManager.__cscOriginalLoad = packManager.load;
                    }
                    if (typeof packManager.__cscOriginalLoad !== 'function') {
                        requestAnimationFrame(prepareCacheLoader);
                        return;
                    }
                    let originalLoad = packManager.__cscOriginalLoad;
                    let pathname = window.location.pathname;
                    let pathStr = pathname.substring(0, pathname.lastIndexOf('/')) + '/';
                    let fontOverrideCacheBust = Date.now();

                    function appendFontOverrideCacheBust(url) {
                        if (typeof url !== 'string' || !/\.ttf(?:[?#]|$)/i.test(url)) return url;
                        let joiner = url.indexOf('?') >= 0 ? '&' : '?';
                        return url + joiner + 'csc_font_override=' + fontOverrideCacheBust;
                    }

                    window.electronAPI.getProxyPort().then(port => {
                        if (!port) return;
                        let newHost = 'http://localhost:' + port + '/';
                        injectFontOverrideCss();

                        // 1. Intercept client assets
                        if (!packManager.__cscCachePatched) {
                            packManager.load = function (t) {
                                if (!t || !t.url) return originalLoad.apply(this, arguments);
                                if (t.url.startsWith('http')) return originalLoad.apply(this, arguments);
                                t.url = appendFontOverrideCacheBust(newHost + 'client' + pathStr + t.url);
                                return originalLoad.apply(this, arguments);
                            };
                            packManager.__cscCachePatched = true;
                        }

                        function waitForAssetLoader() {
                            let assetLoader = __require('Singleton').assetLoader;
                            let host = assetLoader ? assetLoader._host : null;
                            if (!host) { requestAnimationFrame(waitForAssetLoader); return; }

                            window.electronAPI.setCacheConfig({ resourceHost: host });
                            console.log('[CSC] Caching asset server', host, 'on proxy port', port);

                            assetLoader._host = newHost;
                            let hostPath = newHost + 'resources/';
                            assetLoader._hostUrl = assetLoader._hostUrl.replace(host, hostPath);
                            assetLoader._loader._hostUrl = assetLoader._loader._hostUrl.replace(host, hostPath);
                        }
                        waitForAssetLoader();
                    });
                }
                prepareCacheLoader();


                // Ported from legacy canvas initialization logic.
                // Forces WebGL preserveDrawingBuffer so the ambient canvas can read from it.
                function canvasInitialize(gameCanvas) {
                    if (gameCanvas) {
                        renderGl = gameCanvas.getContext('webgl', {
                            alpha: true,
                            antialias: false,
                            depth: true,
                            desynchronized: false,
                            powerPreference: 'default',
                            premultipliedAlpha: true,
                            preserveDrawingBuffer: true,
                            stencil: true,
                        });
                    }
                }

                // Ported from legacy ambient-canvas logic.
                // Places a blurred mirror of the game canvas behind the game div,
                // creating the ambient glow effect and covering the side artwork.
                function createAmbientCanvas(gameDiv, sourceCanvas) {
                    if (runtimeConfig && runtimeConfig.ambient === false) return;
                    if (!gameDiv || !sourceCanvas) return;

                    sourceCanvas.style.boxShadow = '0px 0px 64px black';

                    var ambientCanvasElement = document.createElement('canvas');
                    ambientCanvasElement.id = 'Ambient';
                    ambientCanvasElement.style.position = 'absolute';
                    ambientCanvasElement.style.width = '100%';
                    ambientCanvasElement.style.height = '100%';
                    ambientCanvasElement.style.filter = 'blur(128px) brightness(75%)';
                    ambientCanvasElement.width = 512;
                    ambientCanvasElement.height = 512;
                    gameDiv.parentElement.insertBefore(ambientCanvasElement, gameDiv);

                    var ambientCtx = ambientCanvasElement.getContext('2d');
                    if (!ambientCtx) return;

                    function drawAmbient() {
                        try {
                            if (!skipRender) {
                                ambientCtx.drawImage(sourceCanvas, 0, 0, 512, 512);
                            }
                        } catch(e) {}
                        requestAnimationFrame(drawAmbient);
                    }
                    requestAnimationFrame(drawAmbient);
                    return ambientCanvasElement;
                }

                // Wait for the Cocos game canvas to appear, then initialize
                var initialized = false;
                function tryInitCanvas() {
                    if (initialized) return;
                    gameCanvas = document.querySelector('#GameCanvas') || document.querySelector('canvas');
                    if (!gameCanvas) { requestAnimationFrame(tryInitCanvas); return; }
                    var gameDiv = document.querySelector('#GameDiv') || gameCanvas.parentElement;
                    if (!gameDiv) { requestAnimationFrame(tryInitCanvas); return; }
                    initialized = true;

                    if (shellStripEnabled) {
                        // Hide decorative background (character artwork on sides)
                        var background = document.querySelector('#Background');
                        if (background) background.style.display = 'none';

                        // Make sure the page background is black and non-scrollable
                        document.body.style.backgroundColor = 'black';
                        document.body.style.margin = '0';
                        document.body.style.overflow = 'hidden';

                        // Remove news/ad footer iframe
                        var footer = document.querySelector('#NewsFooter');
                        if (footer && footer.parentElement) footer.parentElement.removeChild(footer);

                        // Align game container to the viewport top before resize logic takes over
                        gameDiv.style.top = '0px';
                    }

                    console.log('[CSC] Game canvas found, initializing ambient canvas...');
                    canvasInitialize(gameCanvas);
                    ambientCanvas = createAmbientCanvas(gameDiv, gameCanvas);
                    installFrameRateControl();
                    applyFrameRateMode(0);
                    startBlackoutAnimation();
                    applyBlackoutState();

                    // Inject CSS: fill body/html with window size
                    var style = document.createElement('style');
                    style.textContent = 'html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }';
                    document.head.appendChild(style);

                    // Ported from legacy resize/zoom logic.
                    var zoomLevel = 0;
                    var resizing = false;

                    function getZoomLevel() {
                        try {
                            if (window.electronAPI && typeof window.electronAPI.getZoomLevel === 'function') {
                                return window.electronAPI.getZoomLevel();
                            }
                        } catch(e) {}
                        return zoomLevel;
                    }

                    function setZoomLevel(level) {
                        zoomLevel = level;
                        try {
                            if (window.electronAPI && typeof window.electronAPI.setZoomLevel === 'function') {
                                window.electronAPI.setZoomLevel(level);
                            }
                        } catch(e) {}
                    }

                    function updateZoom() {
                        var zoom = Math.pow(1.2, getZoomLevel());
                        var innerWidth = window.innerWidth * zoom;
                        var innerHeight = window.innerHeight * zoom;
                        var gameWidth = parseInt(gameCanvas.style.width, 10) || gameCanvas.clientWidth || gameCanvas.width;
                        var gameHeight = parseInt(gameCanvas.style.height, 10) || gameCanvas.clientHeight || gameCanvas.height;
                        if (!gameWidth || !gameHeight) return;

                        var widthZoom = innerWidth / gameWidth;
                        var heightZoom = innerHeight / gameHeight;
                        var nextZoomLevel = Math.log(Math.min(widthZoom, heightZoom)) / Math.log(1.2);
                        if (!isFinite(nextZoomLevel)) return;

                        setZoomLevel(nextZoomLevel);
                        if (gameDiv) {
                            gameDiv.style.top = (window.innerHeight - gameHeight) / 2.0 + 'px';
                        }
                    }

                    function updateCanvas() {
                        gameDiv.style.width = window.innerWidth + 'px';
                        gameDiv.style.height = window.innerHeight + 'px';
                        try {
                            if (window.cc && cc.view) {
                                if (typeof cc.view._resizeEvent === 'function') cc.view._resizeEvent(true);
                                else if (typeof cc.view.setCanvasSize === 'function') cc.view.setCanvasSize(window.innerWidth, window.innerHeight);
                            }
                        } catch(e) {}
                    }

                    var lastCanvasWidth = parseInt(gameCanvas.style.width, 10) || gameCanvas.clientWidth || gameCanvas.width;
                    var lastCanvasHeight = parseInt(gameCanvas.style.height, 10) || gameCanvas.clientHeight || gameCanvas.height;
                    var canvasChangeDetector = new MutationObserver(function() {
                        var currentCanvasWidth = parseInt(gameCanvas.style.width, 10) || gameCanvas.clientWidth || gameCanvas.width;
                        var currentCanvasHeight = parseInt(gameCanvas.style.height, 10) || gameCanvas.clientHeight || gameCanvas.height;
                        if (lastCanvasWidth === currentCanvasWidth && lastCanvasHeight === currentCanvasHeight) return;

                        console.log('[CSC] Canvas Change Detected. Rescaling.');
                        lastCanvasWidth = currentCanvasWidth;
                        lastCanvasHeight = currentCanvasHeight;
                        updateZoom();
                        updateCanvas();
                    });

                    var resizeTimeout = null;
                    window.addEventListener('resize', function() {
                        if (resizeTimeout) {
                            clearTimeout(resizeTimeout);
                        }
                        resizeTimeout = setTimeout(function() {
                            updateCanvas();
                            updateZoom();
                            resizeTimeout = null;
                            resizing = false;
                        }, 100);
                        resizing = true;
                        updateZoom();
                    });

                    canvasChangeDetector.observe(gameCanvas, { attributes: true });
                    updateCanvas();
                    updateZoom();

                    // --- Phase 4: Background Execution (Anti-pause) ---
                    console.log('[CSC] Initializing background execution anti-pause patches...');
                    
                    // 1. Disable bgWorker to prevent the game engine from relying on Worker throttling
                    window.Worker = class {
                        postMessage() {}
                        terminate() {}
                    };

                    let backgroundMode = false;
                    document.addEventListener('visibilitychange', () => {
                        backgroundMode = document.visibilityState === 'hidden';
                        blackoutBackgroundMode = backgroundMode;
                        if (backgroundMode) {
                            stopRender();
                        } else if (!blackoutEnabled) {
                            resumeRender();
                        } else {
                            applyBlackoutState();
                        }
                    });

                    function autoLongPress(mousePosition) {
                        if (!window.cc || !cc.director || typeof cc.director.getScene !== 'function') {
                            return false;
                        }
                        var scene = cc.director.getScene();
                        if (!scene) {
                            return false;
                        }

                        function getLongPressHandler(component) {
                            if (!component) return null;
                            var keys = Object.keys(component);
                            var preferred = ['_onlongpress', '_longpress', '_onlongtap', '_longtap', '_onlongtouch', '_longtouch'];
                            for (var i = 0; i < preferred.length; i++) {
                                var preferredKey = preferred[i];
                                for (var j = 0; j < keys.length; j++) {
                                    var exactKey = keys[j];
                                    if (!exactKey || exactKey.charAt(0) !== '_') continue;
                                    if (exactKey.toLowerCase() !== preferredKey) continue;
                                    if (typeof component[exactKey] !== 'function') continue;
                                    return component[exactKey];
                                }
                            }
                            for (var k = 0; k < keys.length; k++) {
                                var key = keys[k];
                                if (!key || key.charAt(0) !== '_') continue;
                                if (key.toLowerCase().indexOf('long') < 0) continue;
                                if (typeof component[key] !== 'function') continue;
                                return component[key];
                            }
                            return null;
                        }

                        function getNodeName(node) {
                            return String(node && (node.name || node._name || '') || '');
                        }

                        function getNodeSortZ(node) {
                            var z = Number(node && (node.zIndex != null ? node.zIndex : node._localZOrder));
                            return isFinite(z) ? z : 0;
                        }

                        function getNodeSortOrder(node) {
                            var order = Number(node && node._orderOfArrival);
                            return isFinite(order) ? order : 0;
                        }

                        function getNodeChain(node) {
                            var chain = [];
                            var current = node;
                            var guard = 0;
                            while (current && guard < 64) {
                                chain.unshift(current);
                                current = current.parent || current._parent || null;
                                guard += 1;
                            }
                            return chain;
                        }

                        function compareSceneOrder(a, b) {
                            if (!a || !b || a === b) return 0;
                            var aChain = getNodeChain(a);
                            var bChain = getNodeChain(b);
                            var length = Math.min(aChain.length, bChain.length);
                            var index = 0;
                            while (index < length && aChain[index] === bChain[index]) {
                                index += 1;
                            }
                            var aNode = aChain[index] || a;
                            var bNode = bChain[index] || b;
                            var zDiff = getNodeSortZ(aNode) - getNodeSortZ(bNode);
                            if (zDiff !== 0) return zDiff;
                            return getNodeSortOrder(aNode) - getNodeSortOrder(bNode);
                        }

                        function isModalBlockerNode(node) {
                            if (!node || !node._activeInHierarchy) return false;
                            var name = getNodeName(node).toLowerCase();
                            return name === 'modal' || name === 'modallayer';
                        }

                        function getBlockingModal(selectedCandidate, modalBlockers) {
                            if (!selectedCandidate || !Array.isArray(modalBlockers)) return null;
                            for (var i = 0; i < modalBlockers.length; i++) {
                                var blocker = modalBlockers[i];
                                if (compareSceneOrder(blocker, selectedCandidate.node) >= 0) {
                                    return blocker;
                                }
                            }
                            return null;
                        }

                        // Collect every node whose world bounding box contains mousePosition
                        // and has a long press handler, then pick the best match:
                        // smallest bbox area first (most specific visual target),
                        // then closest bbox centre as tiebreaker.
                        var candidates = [];
                        var modalBlockers = [];

                        function gatherCandidates(node) {
                            if (!node || !node._activeInHierarchy) return;

                            var children = node._children;
                            if (Array.isArray(children)) {
                                for (var i = 0; i < children.length; i++) {
                                    gatherCandidates(children[i]);
                                }
                            }

                            var bbox = null;
                            try {
                                bbox = node.getBoundingBoxToWorld();
                            } catch (e) { return; }
                            if (!bbox || !bbox.contains(mousePosition)) return;
                            if (isModalBlockerNode(node)) {
                                modalBlockers.push(node);
                            }

                            if (!Array.isArray(node._components)) return;
                            for (var j = 0; j < node._components.length; j++) {
                                var component = node._components[j];
                                if (!component) continue;
                                var handler = getLongPressHandler(component);
                                if (typeof handler !== 'function') continue;
                                candidates.push({
                                    node: node,
                                    component: component,
                                    handler: handler,
                                    area: bbox.width * bbox.height,
                                    distSq: Math.pow(bbox.x + bbox.width * 0.5 - mousePosition.x, 2) +
                                            Math.pow(bbox.y + bbox.height * 0.5 - mousePosition.y, 2),
                                });
                                break;
                            }
                        }

                        gatherCandidates(scene);
                        if (candidates.length === 0) return false;

                        candidates.sort(function(a, b) {
                            var areaDiff = a.area - b.area;
                            if (Math.abs(areaDiff) > 100) return areaDiff;
                            return a.distSq - b.distSq;
                        });

                        try {
                            var blockingModal = getBlockingModal(candidates[0], modalBlockers);
                            if (blockingModal) return false;
                            candidates[0].handler.apply(candidates[0].component);
                            return true;
                        } catch (e) {}
                        return false;
                    }

                    function resolveViewportRect(rect) {
                        var fallback = { x: 0, y: 0, width: rect.width, height: rect.height };
                        if (!window.cc || !cc.view) return fallback;

                        var rawViewport = null;
                        if (cc.view._viewportRect && typeof cc.view._viewportRect === 'object') {
                            rawViewport = cc.view._viewportRect;
                        } else if (typeof cc.view.getViewportRect === 'function') {
                            try {
                                rawViewport = cc.view.getViewportRect();
                            } catch (e) {
                                rawViewport = null;
                            }
                        }

                        var vpX = Number(rawViewport && rawViewport.x);
                        var vpY = Number(rawViewport && rawViewport.y);
                        var vpWidth = Number(rawViewport && rawViewport.width);
                        var vpHeight = Number(rawViewport && rawViewport.height);
                        if (!isFinite(vpX) || !isFinite(vpY) || !isFinite(vpWidth) || !isFinite(vpHeight) || vpWidth <= 0 || vpHeight <= 0) {
                            return fallback;
                        }

                        var canvasPixelWidth = Number(gameCanvas && gameCanvas.width);
                        var canvasPixelHeight = Number(gameCanvas && gameCanvas.height);
                        if (!isFinite(canvasPixelWidth) || canvasPixelWidth <= 0) canvasPixelWidth = rect.width;
                        if (!isFinite(canvasPixelHeight) || canvasPixelHeight <= 0) canvasPixelHeight = rect.height;

                        var scaleX = rect.width / canvasPixelWidth;
                        var scaleY = rect.height / canvasPixelHeight;

                        return {
                            x: vpX * scaleX,
                            y: vpY * scaleY,
                            width: vpWidth * scaleX,
                            height: vpHeight * scaleY
                        };
                    }

                    function handleRightClick(ev) {
                        if (!ev) return false;
                        var runCommand =
                            window.electronAPI && typeof window.electronAPI.runCommand === 'function'
                                ? window.electronAPI.runCommand
                                : null;
                        function openContextMenu() {
                            if (!runCommand) return;
                            // Let Electron resolve the popup at the current cursor position.
                            // This avoids renderer/main coordinate drift after fullscreen/zoom transitions.
                            runCommand('openContextMenu');
                        }

                        if (
                            !runCommand ||
                            !gameCanvas ||
                            ev.ctrlKey ||
                            ev.metaKey ||
                            !window.cc ||
                            !cc.view ||
                            !cc.view._visibleRect
                        ) {
                            openContextMenu();
                            return false;
                        }

                        var rect = gameCanvas.getClientRects()[0];
                        if (!rect || !rect.width || !rect.height) {
                            openContextMenu();
                            return false;
                        }

                        var canvasMousePosition = {
                            x: ev.clientX - rect.left,
                            y: rect.height - (ev.clientY - rect.top)
                        };
                        var viewportRect = resolveViewportRect(rect);

                        if (
                            canvasMousePosition.x < viewportRect.x ||
                            canvasMousePosition.y < viewportRect.y ||
                            canvasMousePosition.x >= viewportRect.x + viewportRect.width ||
                            canvasMousePosition.y >= viewportRect.y + viewportRect.height
                        ) {
                            openContextMenu();
                            return false;
                        }

                        if (
                            canvasMousePosition.x >= viewportRect.x + viewportRect.width - 64 &&
                            canvasMousePosition.x <= viewportRect.x + viewportRect.width &&
                            canvasMousePosition.y >= viewportRect.y + viewportRect.height - 64 &&
                            canvasMousePosition.y <= viewportRect.y + viewportRect.height
                        ) {
                            openContextMenu();
                            return false;
                        }

                        var visibleRect = cc.view._visibleRect;
                        var sceneMousePosition = {
                            x: ((canvasMousePosition.x - viewportRect.x) / viewportRect.width) * visibleRect.width,
                            y: ((canvasMousePosition.y - viewportRect.y) / viewportRect.height) * visibleRect.height
                        };

                        autoLongPress(sceneMousePosition);
                        return false;
                    }

                    var lastRightMouseDownAt = 0;
                    document.addEventListener('mousedown', function(ev) {
                        if (!ev || ev.button !== 2) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        lastRightMouseDownAt = Date.now();
                        handleRightClick(ev);
                        return false;
                    }, true);

                    document.addEventListener('contextmenu', function(ev) {
                        if (!ev) return;
                        var elapsedMs = Date.now() - lastRightMouseDownAt;
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (elapsedMs < 500) return false;
                        handleRightClick(ev);
                        return false;
                    }, true);

                    // 2. Manually step the game engine when in the background
                    setInterval(() => {
                        if (backgroundMode) {
                            try {
                                if (window.cc && window.cc.game && window.cc.game.step) {
                                    window.cc.game.step();
                                }
                            } catch(e) {}
                        }
                    }, 16); // Target 60fps

                    // 3. Disable audio muting when the tab loses focus (fixes Howler internal logic)
                    function disableBackgroundMute() {
                        try {
                            if (window.Howler) {
                                window.Howler.autoSuspend = false;
                                if (window.Howler.ctx && window.Howler.ctx.state === 'suspended') {
                                    window.Howler.ctx.resume();
                                    
                                    // Sometimes we need to actively unmute master audio
                                    if (window.Howler._muted) {
                                        window.Howler.mute(false);
                                    }
                                }
                            }

                            if (window.cc && window.cc.game) {
                                if (!window.__cscOriginalPauseGame && typeof window.cc.game.pause === 'function') {
                                    window.__cscOriginalPauseGame = window.cc.game.pause;
                                }
                                if (typeof window.cc.game.pause !== 'function' || window.cc.game.pause !== window.__cscNoopPause) {
                                    if (!window.__cscNoopPause) {
                                        window.__cscNoopPause = function() {};
                                    }
                                    window.cc.game.pause = window.__cscNoopPause;
                                }

                                if (!window.__cscGameControl || typeof window.__cscGameControl !== 'object') {
                                    window.__cscGameControl = {};
                                }

                                if (typeof window.__cscGameControl.pauseGame !== 'function') {
                                    window.__cscGameControl.pauseGame = function() {
                                        if (typeof window.__cscOriginalPauseGame === 'function') {
                                            window.__cscOriginalPauseGame.apply(window.cc.game);
                                        }
                                    };
                                }
                                if (typeof window.__cscGameControl.resumeGame !== 'function') {
                                    window.__cscGameControl.resumeGame = function() {
                                        if (window.cc && window.cc.game && typeof window.cc.game.resume === 'function') {
                                            window.cc.game.resume();
                                        }
                                    };
                                }

                                if (!window.__cscBridge || typeof window.__cscBridge !== 'object') {
                                    window.__cscBridge = {};
                                }
                                window.__cscBridge.gameControl = window.__cscGameControl;
                            }
                        } catch(e) {}
                        requestAnimationFrame(disableBackgroundMute);
                    }
                    requestAnimationFrame(disableBackgroundMute);
                }
                requestAnimationFrame(tryInitCanvas);
            }
        })();
    `;
    document.documentElement.appendChild(script);
});
