const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, clipboard, session, shell, screen } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const cache = require('./cache'); // Import the caching proxy
const ini = require('./ini');
const { decode: decodeMsgpack } = require('@msgpack/msgpack');
const { createSettingsStore, DEFAULT_SETTINGS } = require('./settings-store');

let mainWindow;
let mainWindowWebSecurity = null;
let webSecuritySwitchInProgress = false;
let settingsStore = null;
let tray = null;
let isQuitting = false;
let contextMenuPopupHandler = null;
let persistedWindowBounds = null;
function getTrayIconAssetPath() {
    if (process.platform === 'darwin') {
        return path.join(__dirname, 'icon_mac.png');
    }
    if (process.platform === 'win32') {
        return path.join(__dirname, 'icon.ico');
    }
    return path.join(__dirname, 'icon.png');
}

function getNotificationIconPath() {
    if (process.platform === 'darwin') {
        return path.join(__dirname, 'icon_mac.png');
    }
    return path.join(__dirname, 'icon.png');
}

function createTrayIcon() {
    const icon = nativeImage.createFromPath(getTrayIconAssetPath());
    if (process.platform === 'darwin') {
        icon.setTemplateImage(true);
    }
    return icon;
}
const CONFIG_INI_PATH = path.resolve(__dirname, '..', 'config.ini');
const PROVIDER_PREFS_FILE = 'provider-preferences.json';
const CUSTOM_DIR_PATH = path.resolve(__dirname, '..', 'custom');
let providerPreferencesPath = null;
let providerPreferences = { languageByProvider: {} };
const PROVIDER_REGEX_FIELDS = Object.freeze(['loginRegex', 'pageRegex', 'gameRegex', 'wrapperRegex']);
const WINDOWS_APP_USER_MODEL_ID = 'com.cravesaga.client';
const WINDOWS_TOAST_SHORTCUT_NAME = 'Crave Saga.lnk';
const WINDOW_STATE_ID = 'CraveSaga';
const WINDOW_STATE_FILE_NAME = `window-state-${WINDOW_STATE_ID}.json`;
const DEFAULT_WINDOW_WIDTH = 375;
const DEFAULT_WINDOW_HEIGHT = 667;
const WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 200;

const ALLOWED_FRAME_RATES = new Set([0, 30, 15, 5]);
const BLACKOUT_POINTER_POLL_INTERVAL_MS = 120;
let blackoutPointerTrackingTimer = null;
let lastBlackoutPointerInsideState = null;

function findMacAppBundlePath(execPath) {
    if (!execPath || typeof execPath !== 'string') return null;
    let current = path.resolve(execPath);
    while (current && current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.app')) {
            return current;
        }
        current = path.dirname(current);
    }
    return null;
}

function canWriteToFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') return false;
    try {
        fs.mkdirSync(folderPath, { recursive: true });
        const probePath = path.join(folderPath, `.csc-write-probe-${process.pid}-${Date.now()}`);
        fs.writeFileSync(probePath, 'ok');
        fs.unlinkSync(probePath);
        return true;
    } catch (_) {
        return false;
    }
}

function resolvePackagedCacheFolder() {
    if (process.platform === 'win32') {
        return path.join(path.dirname(process.execPath), 'cache');
    }

    if (process.platform === 'darwin') {
        const appBundlePath = findMacAppBundlePath(process.execPath);
        if (appBundlePath) {
            const siblingCacheFolder = path.join(path.dirname(appBundlePath), 'cache');
            if (canWriteToFolder(siblingCacheFolder)) {
                return siblingCacheFolder;
            }
            console.warn(`[Cache] mac sibling cache is not writable: ${siblingCacheFolder}. Falling back to userData.`);
        }
    }

    return path.join(app.getPath('userData'), 'cache');
}

const gameCommandState = {
    isFullscreen: false,
    isAlwaysOnTop: false,
    blackout: false,
    frameRate: 0,
    muteAll: false,
    muteBgm: false,
    muteSe: false
};

const modifierState = {
    control: false,
    meta: false
};

function cloneDefaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function getSettingsSnapshot() {
    return settingsStore ? settingsStore.getAll() : cloneDefaultSettings();
}

function syncAudioStateFromSettings() {
    const audio = getSettingsSnapshot().audio || {};
    gameCommandState.muteAll = !!audio.muteAll;
    gameCommandState.muteBgm = !!audio.muteBgm;
    gameCommandState.muteSe = !!audio.muteSe;
}

function broadcastSettingsSnapshot() {
    emitMainEvent('settings-updated', getSettingsSnapshot());
    updateTrayDisplay();
}

function setNotificationSetting(key, value) {
    if (!settingsStore) return getSettingsSnapshot();
    const next = settingsStore.set(['notifications', key], !!value);
    broadcastSettingsSnapshot();
    return next;
}

function setAudioSetting(key, value) {
    if (!settingsStore) return getSettingsSnapshot();
    const next = settingsStore.set(['audio', key], !!value);
    syncAudioStateFromSettings();
    broadcastSettingsSnapshot();
    return next;
}

function isNotificationEnabled(type) {
    if (!type) return true;
    const notifications = getSettingsSnapshot().notifications || {};
    return Object.prototype.hasOwnProperty.call(notifications, type) ? !!notifications[type] : true;
}

// Store provider/session state shared within the main process.
const globalState = {
    provider: null,
    defaultProvider: null,
    status: 'Logging in...',
    loginRegex: [],
    pageRegex: [],
    gameRegex: [],
    wrapperRegex: [],
    cookieHosts: [],
    entryUrl: null,
    lang: null,
    langs: [],
    success: false
};

function isErolabsUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /https?:\/\/([^/]+\.)?(ero-labs|erolabs)\./i.test(url);
}

function isJohrenUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /https?:\/\/([^/]+\.)?johren\.(?:net|games)\b/i.test(url);
}

function isErolabsLoginPageUrl(url) {
    if (!isErolabsUrl(url)) return false;
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();
        if (!/\/(?:[a-z]{2}\/)?game\.html$/.test(pathname)) return false;
        const id = parsed.searchParams.get('id');
        return !id || id === '47';
    } catch {
        return /\/(?:[a-z]{2}\/)?game\.html(?:[?#]|$)/i.test(url);
    }
}

function isJohrenLoginPageUrl(url) {
    if (!isJohrenUrl(url)) return false;
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();
        if (/\/login(?:\/|$)/.test(pathname)) return true;
        return false;
    } catch {
        return /\/login(?:[/?#]|$)/i.test(url);
    }
}

function resolveWebSecurityForUrl(url) {
    // Keep EROLABS site pages in secure mode during login/challenge flow.
    // Switch back to runtime baseline when entering non-EROLABS pages (e.g. game client domains).
    if (isErolabsUrl(url) && !isGamePageUrl(url)) return true;
    if (isErolabsLoginPageUrl(url)) return true;
    // Johren login/challenge flows also rely on standard browser security behavior.
    if (isJohrenUrl(url) && !isGamePageUrl(url)) return true;
    if (isJohrenLoginPageUrl(url)) return true;
    return !!runtimeFlags.webSecurity;
}
function isPlayableSessionUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.includes('/selector.html')) return false;
    return true;
}

function safeTrimmedString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function normalizeWindowBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

    const normalized = { width, height };
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
        normalized.x = x;
        normalized.y = y;
    }
    return normalized;
}

function getWindowStateFilePath() {
    return path.join(app.getPath('userData'), WINDOW_STATE_FILE_NAME);
}

function readPersistedWindowBounds() {
    try {
        const filePath = getWindowStateFilePath();
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed?.id !== WINDOW_STATE_ID) return null;
        return normalizeWindowBounds(parsed?.bounds);
    } catch (error) {
        console.warn(`[Window] Failed to read ${WINDOW_STATE_FILE_NAME}: ${error?.message || error}`);
        return null;
    }
}

function persistWindowBounds(windowRef) {
    if (!windowRef || windowRef.isDestroyed()) return;

    try {
        const shouldUseNormalBounds =
            (typeof windowRef.isMaximized === 'function' && windowRef.isMaximized()) ||
            (typeof windowRef.isFullScreen === 'function' && windowRef.isFullScreen());
        const rawBounds =
            shouldUseNormalBounds && typeof windowRef.getNormalBounds === 'function'
                ? windowRef.getNormalBounds()
                : windowRef.getBounds();
        const bounds = normalizeWindowBounds(rawBounds);
        if (!bounds) return;

        persistedWindowBounds = bounds;
        const filePath = getWindowStateFilePath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
            filePath,
            `${JSON.stringify({ id: WINDOW_STATE_ID, bounds }, null, 2)}\n`,
            'utf8'
        );
    } catch (error) {
        console.warn(`[Window] Failed to persist ${WINDOW_STATE_FILE_NAME}: ${error?.message || error}`);
    }
}

function normalizeRegexContractList(value, fieldName) {
    if (!Array.isArray(value)) return [];
    const normalized = [];
    for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        const source = safeTrimmedString(item?.source);
        if (!source) continue;
        const flags = typeof item?.flags === 'string' ? item.flags : '';
        try {
            // Validate regex syntax during state write; invalid rules are ignored.
            new RegExp(source, flags);
            normalized.push({ source, flags });
        } catch (error) {
            console.warn(
                `[ProviderRegex] Invalid ${fieldName || 'regex'}[${i}] /${source}/${flags}: ${error?.message || error}`
            );
        }
    }
    return normalized;
}

function cloneRegexContractList(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => ({
        source: typeof item?.source === 'string' ? item.source : '',
        flags: typeof item?.flags === 'string' ? item.flags : ''
    }));
}

function checkRegexContract(url, value, fieldName) {
    if (!url || typeof url !== 'string') return false;
    if (!Array.isArray(value) || value.length === 0) return false;

    for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        const source = safeTrimmedString(item?.source);
        if (!source) continue;
        const flags = typeof item?.flags === 'string' ? item.flags : '';
        try {
            if (new RegExp(source, flags).test(url)) return true;
        } catch (error) {
            console.warn(
                `[ProviderRegex] Failed to compile ${fieldName || 'regex'}[${i}] /${source}/${flags}: ${error?.message || error}`
            );
        }
    }

    return false;
}

function isGamePageUrl(url) {
    return checkRegexContract(url, globalState.gameRegex, 'gameRegex');
}

function maskProxyUrl(proxyUrl) {
    if (typeof proxyUrl !== 'string') return '';
    return proxyUrl.replace(/\/\/([^@/]+)@/, '//***@');
}

function parseBooleanRuntimeValue(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

function sanitizeUserAgent(userAgent) {
    if (typeof userAgent !== 'string') return '';
    return userAgent.replace(/\s+Electron\/[^\s]+/i, '').replace(/\s{2,}/g, ' ').trim();
}

function readRuntimeConfig() {
    try {
        if (!fs.existsSync(CONFIG_INI_PATH)) return {};
        const raw = fs.readFileSync(CONFIG_INI_PATH, 'utf8');
        const parsed = ini.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn(`[Config] Failed to read config.ini: ${error?.message || error}`);
        return {};
    }
}

function parseProxyConfig(config) {
    const proxySection = config && typeof config.proxy === 'object' ? config.proxy : null;
    if (!proxySection) return null;

    const host = safeTrimmedString(proxySection.host);
    const portRaw = proxySection.port;
    const port = safeTrimmedString(typeof portRaw === 'number' ? String(portRaw) : portRaw);
    if (!host || !port) return null;

    const username = safeTrimmedString(proxySection.username);
    const password = typeof proxySection.password === 'string' ? proxySection.password : '';
    const proxyServer = `${host}:${port}`;

    let proxyCredentialPart = '';
    if (username) {
        const encodedUsername = encodeURIComponent(username);
        if (password.length > 0) {
            proxyCredentialPart = `${encodedUsername}:${encodeURIComponent(password)}@`;
        } else {
            proxyCredentialPart = `${encodedUsername}@`;
        }
    }

    const proxyUrl = `${proxyCredentialPart}${proxyServer}`;

    return {
        host,
        port,
        username,
        password,
        proxyServer,
        proxyUrl,
        httpProxy: `http://${proxyUrl}`
    };
}

const runtimeConfig = readRuntimeConfig();
const runtimeFlags = {
    tray: parseBooleanRuntimeValue(runtimeConfig.tray, true),
    nocache: parseBooleanRuntimeValue(runtimeConfig.nocache, false),
    ambient: parseBooleanRuntimeValue(runtimeConfig.ambient, true),
    webSecurity: parseBooleanRuntimeValue(runtimeConfig.web_security, false),
    maskElectronUA: parseBooleanRuntimeValue(runtimeConfig.mask_electron_ua, false)
};
const proxyConfig = parseProxyConfig(runtimeConfig);

if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

function ensureWindowsToastShortcut() {
    if (process.platform !== 'win32') return;
    if (!app.isPackaged) return;
    try {
        const appDataPath = process.env.APPDATA || app.getPath('appData');
        const shortcutPath = path.join(
            appDataPath,
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs',
            WINDOWS_TOAST_SHORTCUT_NAME
        );

        const shortcutOptions = {
            target: process.execPath,
            cwd: path.dirname(process.execPath),
            description: 'Crave Saga',
            icon: process.execPath,
            iconIndex: 0,
            appUserModelId: WINDOWS_APP_USER_MODEL_ID
        };

        fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
        const operation = fs.existsSync(shortcutPath) ? 'update' : 'create';
        const ok = shell.writeShortcutLink(shortcutPath, operation, shortcutOptions);
        console.log(`[NotificationDebug] Start Menu shortcut ${operation} ${ok ? 'succeeded' : 'failed'}: ${shortcutPath}`);
    } catch (error) {
        console.warn(`[NotificationDebug] Failed to ensure Start Menu shortcut: ${error?.message || error}`);
    }
}

if (proxyConfig && proxyConfig.proxyServer) {
    app.commandLine.appendSwitch('proxy-server', proxyConfig.proxyServer);
    console.log(`[Proxy] Browser proxy enabled: ${proxyConfig.proxyServer}`);
}

app.on('login', (event, webContents, request, authInfo, callback) => {
    if (!proxyConfig || !proxyConfig.username) return;
    if (!authInfo || !authInfo.isProxy) return;
    event.preventDefault();
    callback(proxyConfig.username, proxyConfig.password || '');
});

function applyProxyEnvironment() {
    if (proxyConfig && proxyConfig.httpProxy) {
        process.env.HTTP_PROXY = proxyConfig.httpProxy;
        process.env.HTTPS_PROXY = proxyConfig.httpProxy;
        global.cacheProxyUrl = proxyConfig.httpProxy;
        console.log(`[Proxy] Cache proxy enabled: ${maskProxyUrl(proxyConfig.httpProxy)}`);
        return;
    }

    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    global.cacheProxyUrl = null;
    console.log('[Proxy] Disabled (direct connection)');
}

function ensureProviderPreferencesLoaded() {
    if (providerPreferencesPath) return;
    providerPreferencesPath = path.join(app.getPath('userData'), PROVIDER_PREFS_FILE);

    try {
        if (!fs.existsSync(providerPreferencesPath)) {
            providerPreferences = { languageByProvider: {} };
            return;
        }
        const raw = fs.readFileSync(providerPreferencesPath, 'utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        const languageByProvider =
            parsed && typeof parsed.languageByProvider === 'object' && parsed.languageByProvider
                ? parsed.languageByProvider
                : {};
        providerPreferences = { languageByProvider };
    } catch (error) {
        console.warn(`[ProviderPrefs] Failed to load preferences: ${error?.message || error}`);
        providerPreferences = { languageByProvider: {} };
    }
}

function saveProviderPreferences() {
    if (!providerPreferencesPath) return;
    try {
        fs.mkdirSync(path.dirname(providerPreferencesPath), { recursive: true });
        fs.writeFileSync(providerPreferencesPath, `${JSON.stringify(providerPreferences, null, 2)}\n`, 'utf8');
    } catch (error) {
        console.warn(`[ProviderPrefs] Failed to save preferences: ${error?.message || error}`);
    }
}

function getProviderLanguagePreference(providerKey) {
    const key = safeTrimmedString(providerKey);
    if (!key) return null;
    return safeTrimmedString(providerPreferences?.languageByProvider?.[key]);
}

function setProviderLanguagePreference(providerKey, languageId) {
    const key = safeTrimmedString(providerKey);
    const normalizedLanguageId = safeTrimmedString(languageId);
    if (!key || !normalizedLanguageId) return false;

    if (!providerPreferences || typeof providerPreferences !== 'object') {
        providerPreferences = { languageByProvider: {} };
    }
    if (!providerPreferences.languageByProvider || typeof providerPreferences.languageByProvider !== 'object') {
        providerPreferences.languageByProvider = {};
    }

    providerPreferences.languageByProvider[key] = normalizedLanguageId;
    saveProviderPreferences();
    return true;
}

function normalizeLanguageList(rawLanguages) {
    if (!Array.isArray(rawLanguages)) return [];

    const normalized = [];
    const usedIds = new Set();

    for (let index = 0; index < rawLanguages.length; index += 1) {
        const item = rawLanguages[index];
        if (!item || typeof item !== 'object') continue;

        const url = safeTrimmedString(item.url);
        if (!url) continue;

        const fallbackId = `lang-${index + 1}`;
        const candidateId = safeTrimmedString(item.id) || safeTrimmedString(item.key) || safeTrimmedString(item.name) || fallbackId;
        let id = candidateId;
        let suffix = 2;
        while (usedIds.has(id)) {
            id = `${candidateId}-${suffix}`;
            suffix += 1;
        }
        usedIds.add(id);

        const name = safeTrimmedString(item.name) || id;
        normalized.push({ id, name, url });
    }

    return normalized;
}

function resolveLanguageSelection(languages, preferredLanguageId, fallbackUrl) {
    const normalizedLanguages = normalizeLanguageList(languages);
    if (normalizedLanguages.length === 0) {
        const fallback = safeTrimmedString(fallbackUrl);
        if (!fallback) return null;
        return {
            id: safeTrimmedString(preferredLanguageId) || 'default',
            name: safeTrimmedString(preferredLanguageId) || 'Default',
            url: fallback
        };
    }

    const preferred = safeTrimmedString(preferredLanguageId);
    if (preferred) {
        const found = normalizedLanguages.find(language => language.id === preferred);
        if (found) return found;
    }

    const fallback = safeTrimmedString(fallbackUrl);
    if (fallback) {
        const foundByUrl = normalizedLanguages.find(language => language.url === fallback);
        if (foundByUrl) return foundByUrl;
    }

    return normalizedLanguages[0];
}

function matchLanguageByUrl(languages, currentUrl) {
    const normalizedLanguages = normalizeLanguageList(languages);
    const target = safeTrimmedString(currentUrl);
    if (!target || normalizedLanguages.length === 0) return null;

    const targetLower = target.toLowerCase();
    for (const language of normalizedLanguages) {
        if (safeTrimmedString(language.url).toLowerCase() === targetLower) {
            return language;
        }
    }

    try {
        const targetUrl = new URL(target);

        if (isErolabsUrl(target)) {
            const segments = targetUrl.pathname.split('/').filter(Boolean);
            const firstSegment = safeTrimmedString(segments[0]).toLowerCase();
            if (firstSegment) {
                const bySegment = normalizedLanguages.find(
                    language => safeTrimmedString(language.id).toLowerCase() === firstSegment
                );
                if (bySegment) return bySegment;
            }
        }
    } catch (error) {
        return null;
    }

    return null;
}

function syncLanguagePreferenceFromUrl(url) {
    const providerKey = safeTrimmedString(globalState.defaultProvider);
    if (!providerKey) return;

    const matchedLanguage = matchLanguageByUrl(globalState.langs, url);
    if (!matchedLanguage) return;

    if (globalState.lang !== matchedLanguage.id) {
        setProviderState({ lang: matchedLanguage.id }, { emitEvent: false });
    }
    setProviderLanguagePreference(providerKey, matchedLanguage.id);
}

function loadCustomScripts() {
    if (!fs.existsSync(CUSTOM_DIR_PATH)) return [];

    let entries = [];
    try {
        entries = fs
            .readdirSync(CUSTOM_DIR_PATH, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.js'))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        console.warn(`[Custom] Failed to read custom directory: ${error?.message || error}`);
        return [];
    }

    const scripts = [];
    for (const filename of entries) {
        const sourcePath = path.join(CUSTOM_DIR_PATH, filename);
        try {
            const code = fs.readFileSync(sourcePath, 'utf8');
            scripts.push({
                id: path.basename(filename, path.extname(filename)),
                source: sourcePath,
                code
            });
        } catch (error) {
            console.warn(`[Custom] Failed to load script ${filename}: ${error?.message || error}`);
        }
    }
    return scripts;
}

function normalizeCookieHosts(hosts, entryUrl) {
    const hostSet = new Set();
    const addHost = value => {
        if (typeof value !== 'string') return;
        const normalized = value.trim().replace(/^\.+/, '').toLowerCase();
        if (!normalized) return;
        hostSet.add(normalized);
    };

    if (Array.isArray(hosts)) {
        for (const host of hosts) addHost(host);
    }

    const normalizedEntryUrl = safeTrimmedString(entryUrl);
    if (normalizedEntryUrl) {
        try {
            addHost(new URL(normalizedEntryUrl).hostname);
        } catch {
            // Ignore invalid URLs; they are validated separately.
        }
    }

    return Array.from(hostSet);
}

function cloneProviderState() {
    return {
        provider: globalState.provider || null,
        defaultProvider: globalState.defaultProvider || null,
        loginRegex: cloneRegexContractList(globalState.loginRegex),
        pageRegex: cloneRegexContractList(globalState.pageRegex),
        gameRegex: cloneRegexContractList(globalState.gameRegex),
        wrapperRegex: cloneRegexContractList(globalState.wrapperRegex),
        cookieHosts: Array.isArray(globalState.cookieHosts) ? [...globalState.cookieHosts] : [],
        entryUrl: globalState.entryUrl || null,
        lang: globalState.lang || null,
        langs: Array.isArray(globalState.langs)
            ? globalState.langs.map(language => ({ ...language }))
            : [],
        success: !!globalState.success
    };
}

function emitProviderStateUpdate() {
    emitMainEvent('provider-state-updated', cloneProviderState());
}

function hasConfiguredProviderState() {
    return (
        !!safeTrimmedString(globalState.provider) &&
        !!safeTrimmedString(globalState.entryUrl) &&
        Array.isArray(globalState.gameRegex) &&
        globalState.gameRegex.length > 0 &&
        Array.isArray(globalState.cookieHosts) &&
        globalState.cookieHosts.length > 0
    );
}

function setProviderState(nextState = {}, options = {}) {
    if (!nextState || typeof nextState !== 'object') return cloneProviderState();
    const emitEvent = options.emitEvent !== false;

    const hasProvider = Object.prototype.hasOwnProperty.call(nextState, 'provider');
    const hasEntryUrl = Object.prototype.hasOwnProperty.call(nextState, 'entryUrl');
    const hasCookieHosts = Object.prototype.hasOwnProperty.call(nextState, 'cookieHosts');
    const hasDefaultProvider = Object.prototype.hasOwnProperty.call(nextState, 'defaultProvider');
    const hasLang = Object.prototype.hasOwnProperty.call(nextState, 'lang');
    const hasLangs = Object.prototype.hasOwnProperty.call(nextState, 'langs');
    const hasSuccess = Object.prototype.hasOwnProperty.call(nextState, 'success');
    const hasLoginRegex = Object.prototype.hasOwnProperty.call(nextState, 'loginRegex');
    const hasPageRegex = Object.prototype.hasOwnProperty.call(nextState, 'pageRegex');
    const hasGameRegex = Object.prototype.hasOwnProperty.call(nextState, 'gameRegex');
    const hasWrapperRegex = Object.prototype.hasOwnProperty.call(nextState, 'wrapperRegex');

    if (hasProvider) {
        globalState.provider = safeTrimmedString(nextState.provider);
    }

    if (hasEntryUrl) {
        globalState.entryUrl = safeTrimmedString(nextState.entryUrl);
    }

    if (hasCookieHosts || hasEntryUrl) {
        const sourceHosts = hasCookieHosts ? nextState.cookieHosts : globalState.cookieHosts;
        globalState.cookieHosts = normalizeCookieHosts(sourceHosts, globalState.entryUrl);
    }

    if (hasDefaultProvider) {
        globalState.defaultProvider = safeTrimmedString(nextState.defaultProvider);
    }

    if (hasLoginRegex) {
        globalState.loginRegex = normalizeRegexContractList(nextState.loginRegex, 'loginRegex');
    }

    if (hasPageRegex) {
        globalState.pageRegex = normalizeRegexContractList(nextState.pageRegex, 'pageRegex');
    }

    if (hasGameRegex) {
        globalState.gameRegex = normalizeRegexContractList(nextState.gameRegex, 'gameRegex');
    }

    if (hasWrapperRegex) {
        globalState.wrapperRegex = normalizeRegexContractList(nextState.wrapperRegex, 'wrapperRegex');
    }

    if (hasLangs) {
        globalState.langs = normalizeLanguageList(nextState.langs);
    }

    if (hasLang) {
        globalState.lang = safeTrimmedString(nextState.lang);
    }

    if (hasSuccess) {
        globalState.success = !!nextState.success;
    }

    if (!hasConfiguredProviderState()) {
        globalState.success = false;
    }

    updateTrayDisplay();
    if (emitEvent) emitProviderStateUpdate();
    return cloneProviderState();
}

function resetProviderState(options = {}) {
    const keepRuntimeProvider = !!options.keepRuntimeProvider;

    if (!keepRuntimeProvider) {
        globalState.provider = null;
        globalState.entryUrl = null;
        globalState.cookieHosts = [];
        for (const field of PROVIDER_REGEX_FIELDS) {
            globalState[field] = [];
        }
    }

    globalState.defaultProvider = null;
    globalState.lang = null;
    globalState.langs = [];
    globalState.success = false;

    updateTrayDisplay();
    emitProviderStateUpdate();
    return cloneProviderState();
}

function getSelectorFilePath() {
    return path.join(__dirname, 'selector.html');
}

async function loadSelectorPage(query) {
    if (!hasMainWindow()) return false;
    if (query && typeof query === 'object' && Object.keys(query).length > 0) {
        await mainWindow.loadFile(getSelectorFilePath(), { query });
        return true;
    }
    await mainWindow.loadFile(getSelectorFilePath());
    return true;
}

function getLogoutHosts() {
    return normalizeCookieHosts(globalState.cookieHosts, globalState.entryUrl);
}

async function removeCookiesForHost(session, host) {
    const cookieMap = new Map();
    const domains = [host, `.${host}`];

    for (const domain of domains) {
        let cookies = [];
        try {
            cookies = await session.cookies.get({ domain });
        } catch {
            cookies = [];
        }

        for (const cookie of cookies) {
            const domainName = String(cookie.domain || domain).replace(/^\./, '');
            const cookiePath = cookie.path || '/';
            const key = `${domainName}|${cookiePath}|${cookie.name}|${cookie.secure ? '1' : '0'}`;
            cookieMap.set(key, cookie);
        }
    }

    let removed = 0;
    for (const cookie of cookieMap.values()) {
        const protocol = cookie.secure ? 'https://' : 'http://';
        const cookieDomain = String(cookie.domain || host).replace(/^\./, '');
        const cookiePath = cookie.path || '/';
        const normalizedPath = cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`;
        const cookieUrl = `${protocol}${cookieDomain}${normalizedPath}`;
        try {
            await session.cookies.remove(cookieUrl, cookie.name);
            removed += 1;
        } catch (error) {
            console.warn(`[Logout] Failed to remove cookie ${cookie.name} for host=${host}: ${error?.message || error}`);
        }
    }

    return {
        host,
        total: cookieMap.size,
        removed
    };
}

async function clearOriginStorageForHosts(session, hosts) {
    const storages = ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'];
    const origins = new Set();

    for (const host of hosts) {
        origins.add(`https://${host}`);
        origins.add(`http://${host}`);
    }

    for (const origin of origins) {
        try {
            await session.clearStorageData({ origin, storages });
        } catch (error) {
            console.warn(`[Logout] Failed to clear storage for ${origin}: ${error?.message || error}`);
        }
    }
}

async function executeLogoutFlow() {
    if (!hasMainWindow()) {
        return {
            ok: false,
            error: 'WINDOW_UNAVAILABLE'
        };
    }

    const entryUrl = safeTrimmedString(globalState.entryUrl);
    const hosts = getLogoutHosts();
    const session = mainWindow.webContents.session;
    const cookieResults = [];

    for (const host of hosts) {
        cookieResults.push(await removeCookiesForHost(session, host));
    }

    if (hosts.length > 0) {
        await clearOriginStorageForHosts(session, hosts);
    }

    setProviderState(
        {
            defaultProvider: null,
            success: false
        },
        { emitEvent: true }
    );

    if (!entryUrl) {
        resetProviderState({ keepRuntimeProvider: false });
        await loadSelectorPage({ reselect: '1' });
        return {
            ok: true,
            redirectedToSelector: true,
            cookieResults
        };
    }

    try {
        await mainWindow.loadURL(entryUrl);
        return {
            ok: true,
            entryUrl,
            hosts,
            cookieResults
        };
    } catch (error) {
        console.warn(`[Logout] Failed to load entry URL: ${error?.message || error}`);
        resetProviderState({ keepRuntimeProvider: false });
        await loadSelectorPage({ reselect: '1' });
        return {
            ok: true,
            entryUrl,
            hosts,
            cookieResults,
            redirectedToSelector: true
        };
    }
}

async function enforceProviderStateForUrl(url) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('chrome-extension://')) return;
    if (url.includes('/selector.html')) return;
    if (hasConfiguredProviderState()) return;

    console.warn(`[ProviderGuard] Missing provider state for URL: ${url}`);
    resetProviderState({ keepRuntimeProvider: false });
    await loadSelectorPage({ reselect: '1' });
}

function syncWindowFlagsToState() {
    if (!hasMainWindow()) return;
    gameCommandState.isFullscreen = mainWindow.isFullScreen();
    gameCommandState.isAlwaysOnTop = mainWindow.isAlwaysOnTop();
}

function toBooleanFromPayload(payload) {
    if (typeof payload === 'boolean') return payload;
    if (typeof payload?.enabled === 'boolean') return payload.enabled;
    if (typeof payload?.value === 'boolean') return payload.value;
    return null;
}

function toFrameRate(payload) {
    const explicitRate =
        typeof payload === 'number'
            ? payload
            : typeof payload?.fps === 'number'
                ? payload.fps
                : typeof payload?.value === 'number'
                    ? payload.value
                    : null;
    if (!ALLOWED_FRAME_RATES.has(explicitRate)) return 0;
    return explicitRate;
}

function commandOrControlPressed(input) {
    return process.platform === 'darwin' ? !!input.meta : !!input.control;
}

function hasCommandOrControlModifier(modifiers, options = {}) {
    const allowStateFallback = options && options.allowStateFallback !== false;
    const list = Array.isArray(modifiers) ? modifiers.map(v => String(v).toLowerCase()) : [];
    const useStateFallback = allowStateFallback && list.length === 0;
    const hasCtrl = list.includes('control') || list.includes('ctrl') || (useStateFallback && modifierState.control);
    const hasMeta =
        list.includes('meta') ||
        list.includes('command') ||
        list.includes('cmd') ||
        list.includes('super') ||
        (useStateFallback && modifierState.meta);
    return process.platform === 'darwin' ? hasMeta : hasCtrl;
}

async function isEditableElementFocused() {
    if (!hasMainWindow()) return false;
    try {
        return await mainWindow.webContents.executeJavaScript(
            `(() => {
                const blockedInputTypes = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color']);
                const visitedDocuments = new WeakSet();

                function isEditableElement(element) {
                    if (!element) return false;
                    if (element.isContentEditable) return true;
                    const tag = (element.tagName || '').toLowerCase();
                    if (tag === 'textarea' || tag === 'select') return true;
                    if (tag === 'input') {
                        const inputType = (element.type || '').toLowerCase();
                        return !blockedInputTypes.has(inputType);
                    }
                    return element.getAttribute && element.getAttribute('role') === 'textbox';
                }

                function findFocusedEditable(doc) {
                    if (!doc || visitedDocuments.has(doc)) return false;
                    visitedDocuments.add(doc);

                    let active = null;
                    try {
                        active = doc.activeElement;
                    } catch {
                        return false;
                    }
                    if (!active) return false;
                    if (isEditableElement(active)) return true;

                    if (active.shadowRoot) {
                        const shadowEditable = findFocusedEditable(active.shadowRoot);
                        if (shadowEditable) return true;
                    }

                    const tag = (active.tagName || '').toLowerCase();
                    if (tag === 'iframe' || tag === 'frame') {
                        try {
                            return findFocusedEditable(active.contentDocument);
                        } catch {
                            return false;
                        }
                    }

                    return false;
                }

                return findFocusedEditable(document);
            })()`,
            true
        );
    } catch {
        return false;
    }
}

function emitRendererCommand(command, payload = null) {
    return emitMainEvent('renderer-command', { command, payload });
}

function isCursorInsideMainWindowBounds() {
    if (!hasMainWindow()) return false;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;

    let bounds = null;
    let cursor = null;
    try {
        bounds = mainWindow.getBounds();
        cursor = screen.getCursorScreenPoint();
    } catch {
        return false;
    }
    if (!bounds || !cursor) return false;

    return (
        cursor.x >= bounds.x &&
        cursor.x < bounds.x + bounds.width &&
        cursor.y >= bounds.y &&
        cursor.y < bounds.y + bounds.height
    );
}

function emitBlackoutPointerInsideWindow(force = false) {
    const isInside = isCursorInsideMainWindowBounds();
    if (!force && lastBlackoutPointerInsideState === isInside) return true;
    lastBlackoutPointerInsideState = isInside;
    return emitRendererCommand('setWindowPointerInside', { enabled: isInside });
}

function stopBlackoutPointerTracking() {
    if (blackoutPointerTrackingTimer) {
        clearInterval(blackoutPointerTrackingTimer);
        blackoutPointerTrackingTimer = null;
    }
    lastBlackoutPointerInsideState = null;
}

function startBlackoutPointerTracking() {
    if (blackoutPointerTrackingTimer) return;
    emitBlackoutPointerInsideWindow(true);
    blackoutPointerTrackingTimer = setInterval(() => {
        if (!hasMainWindow()) {
            stopBlackoutPointerTracking();
            return;
        }
        emitBlackoutPointerInsideWindow(false);
    }, BLACKOUT_POINTER_POLL_INTERVAL_MS);
}

function syncBlackoutPointerTracking() {
    if (!gameCommandState.blackout) {
        stopBlackoutPointerTracking();
        return;
    }
    startBlackoutPointerTracking();
    emitBlackoutPointerInsideWindow(false);
}

function updateStatusByUrl(url) {
    if (!url || typeof url !== 'string') {
        globalState.status = 'Logging in...';
        updateTrayDisplay();
        return;
    }

    if (url.includes('/selector.html')) {
        globalState.status = 'Provider selection';
        updateTrayDisplay();
        return;
    }

    if (isGamePageUrl(url)) {
        globalState.status = 'In game';
        updateTrayDisplay();
        return;
    }

    try {
        const parsed = new URL(url);
        globalState.status = `Page: ${parsed.hostname}`;
    } catch {
        globalState.status = 'Loading...';
    }
    updateTrayDisplay();
}

function getProviderLabel() {
    return globalState.provider || 'Crave Saga';
}

function getStatusLabel() {
    return globalState.status || 'Logging in...';
}

function getTrayTooltip() {
    return `Crave Saga | ${getStatusLabel()}`;
}

function isMainWindowVisible() {
    return hasMainWindow() && mainWindow.isVisible() && !mainWindow.isMinimized();
}

function showMainWindow() {
    if (!hasMainWindow()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    updateTrayDisplay();
}

function hideMainWindow() {
    if (!hasMainWindow()) return;
    mainWindow.hide();
    updateTrayDisplay();
}

function toggleMainWindowVisibility() {
    if (!hasMainWindow()) return;
    if (isMainWindowVisible()) {
        hideMainWindow();
        return;
    }
    showMainWindow();
}

function quitApplication() {
    isQuitting = true;
    app.quit();
}

function buildTrayMenu() {
    const settings = getSettingsSnapshot();
    const notifications = settings.notifications || {};
    const audio = settings.audio || {};

    const notificationMenu = [
        {
            label: 'Battle end',
            type: 'checkbox',
            checked: !!notifications.battleEnd,
            click: item => void setNotificationSetting('battleEnd', !!item.checked)
        },
        {
            label: 'Team death (Raid)',
            type: 'checkbox',
            checked: !!notifications.raidDeath,
            click: item => void setNotificationSetting('raidDeath', !!item.checked)
        },
        {
            label: 'Expeditions',
            type: 'checkbox',
            checked: !!notifications.expedition,
            click: item => void setNotificationSetting('expedition', !!item.checked)
        },
        {
            label: 'AP full',
            type: 'checkbox',
            checked: !!notifications.stamina,
            click: item => void setNotificationSetting('stamina', !!item.checked)
        },
        {
            label: 'RP full',
            type: 'checkbox',
            checked: !!notifications.battlepoint,
            click: item => void setNotificationSetting('battlepoint', !!item.checked)
        }
    ];

    return Menu.buildFromTemplate([
        {
            label: getProviderLabel(),
            enabled: false
        },
        {
            label: getStatusLabel(),
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Audio',
            submenu: [
                {
                    label: 'Mute All',
                    type: 'checkbox',
                    accelerator: 'M',
                    checked: !!audio.muteAll,
                    click: item => void runCommandDispatcher('setMuteAll', { enabled: !!item.checked })
                },
                { type: 'separator' },
                {
                    label: 'Mute BGM',
                    type: 'checkbox',
                    checked: !!audio.muteBgm,
                    click: item => void runCommandDispatcher('setMuteBgm', { enabled: !!item.checked })
                },
                {
                    label: 'Mute SE',
                    type: 'checkbox',
                    checked: !!audio.muteSe,
                    click: item => void runCommandDispatcher('setMuteSe', { enabled: !!item.checked })
                }
            ]
        },
        {
            label: 'Notifications',
            submenu: notificationMenu
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => quitApplication()
        }
    ]);
}

function updateTrayDisplay() {
    if (!tray) return;
    tray.setToolTip(getTrayTooltip());
    if (process.platform === 'darwin') {
        tray.setContextMenu(null);
        return;
    }
    tray.setContextMenu(buildTrayMenu());
}

function createTray() {
    if (tray) return tray;
    tray = new Tray(createTrayIcon());
    if (process.platform === 'darwin') {
        tray.on('click', event => {
            if (event && event.ctrlKey) {
                tray.popUpContextMenu(buildTrayMenu());
                return;
            }
            toggleMainWindowVisibility();
        });
        tray.on('right-click', () => {
            tray.popUpContextMenu(buildTrayMenu());
        });
    } else {
        tray.on('click', toggleMainWindowVisibility);
    }
    updateTrayDisplay();
    return tray;
}

function buildContextMenu() {
    syncWindowFlagsToState();
    const settings = getSettingsSnapshot();
    const notifications = settings.notifications || {};
    const audio = settings.audio || {};
    const languages = normalizeLanguageList(globalState.langs);
    const currentLanguage = resolveLanguageSelection(languages, globalState.lang, globalState.entryUrl);

    const frameRateMenu = [
        {
            label: 'Original',
            type: 'radio',
            checked: gameCommandState.frameRate === 0,
            click: () => void runCommandDispatcher('setFrameRate', { fps: 0 })
        },
        {
            label: '30 FPS',
            type: 'radio',
            checked: gameCommandState.frameRate === 30,
            click: () => void runCommandDispatcher('setFrameRate', { fps: 30 })
        },
        {
            label: '15 FPS',
            type: 'radio',
            checked: gameCommandState.frameRate === 15,
            click: () => void runCommandDispatcher('setFrameRate', { fps: 15 })
        },
        {
            label: '5 FPS',
            type: 'radio',
            checked: gameCommandState.frameRate === 5,
            click: () => void runCommandDispatcher('setFrameRate', { fps: 5 })
        }
    ];

    const notificationMenu = [
        {
            label: 'Battle end',
            type: 'checkbox',
            checked: !!notifications.battleEnd,
            click: item => void setNotificationSetting('battleEnd', !!item.checked)
        },
        {
            label: 'Team death (Raid)',
            type: 'checkbox',
            checked: !!notifications.raidDeath,
            click: item => void setNotificationSetting('raidDeath', !!item.checked)
        },
        {
            label: 'Expeditions',
            type: 'checkbox',
            checked: !!notifications.expedition,
            click: item => void setNotificationSetting('expedition', !!item.checked)
        },
        {
            label: 'AP full',
            type: 'checkbox',
            checked: !!notifications.stamina,
            click: item => void setNotificationSetting('stamina', !!item.checked)
        },
        {
            label: 'RP full',
            type: 'checkbox',
            checked: !!notifications.battlepoint,
            click: item => void setNotificationSetting('battlepoint', !!item.checked)
        }
    ];

    const languageMenuItem =
        languages.length > 1
            ? {
                  label: 'Language',
                  submenu: languages.map(language => ({
                      label: language.name,
                      type: 'radio',
                      checked: currentLanguage ? currentLanguage.id === language.id : false,
                      click: () => void runCommandDispatcher('changeLanguage', { lang: language.id })
                  }))
              }
            : null;

    return Menu.buildFromTemplate([
        {
            label: getProviderLabel(),
            enabled: false
        },
        {
            label: getStatusLabel(),
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Fullscreen',
            type: 'checkbox',
            accelerator: 'F',
            checked: gameCommandState.isFullscreen,
            click: item => void runCommandDispatcher('setFullscreen', { enabled: !!item.checked })
        },
        {
            label: 'Blackout',
            type: 'checkbox',
            accelerator: 'B',
            checked: gameCommandState.blackout,
            click: item => void runCommandDispatcher('setBlackout', { enabled: !!item.checked })
        },
        {
            label: 'Frame rate',
            submenu: frameRateMenu
        },
        {
            label: 'Always on top',
            type: 'checkbox',
            checked: gameCommandState.isAlwaysOnTop,
            click: item => void runCommandDispatcher('setAlwaysOnTop', { enabled: !!item.checked })
        },
        {
            label: 'Screenshot to clipboard',
            accelerator: 'F12',
            click: () => void runCommandDispatcher('screenshotToClipboard')
        },
        { type: 'separator' },
        {
            label: 'Audio',
            submenu: [
                {
                    label: 'Mute All',
                    type: 'checkbox',
                    accelerator: 'M',
                    checked: !!audio.muteAll,
                    click: item => void runCommandDispatcher('setMuteAll', { enabled: !!item.checked })
                },
                { type: 'separator' },
                {
                    label: 'Mute BGM',
                    type: 'checkbox',
                    checked: !!audio.muteBgm,
                    click: item => void runCommandDispatcher('setMuteBgm', { enabled: !!item.checked })
                },
                {
                    label: 'Mute SE',
                    type: 'checkbox',
                    checked: !!audio.muteSe,
                    click: item => void runCommandDispatcher('setMuteSe', { enabled: !!item.checked })
                }
            ]
        },
        {
            label: 'Notifications',
            submenu: notificationMenu
        },
        ...(languageMenuItem ? [languageMenuItem] : []),
        { type: 'separator' },
        {
            label: 'Change provider',
            click: () => void runCommandDispatcher('changeProvider')
        },
        { type: 'separator' },
        {
            label: 'Data',
            submenu: [
                { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => void runCommandDispatcher('reload') },
                { type: 'separator' },
                {
                    label: 'Clear cache and reload',
                    accelerator: 'CommandOrControl+Shift+R',
                    click: async () => {
                        const confirmed = await confirmAction('Are you sure you want to clear cache?');
                        if (!confirmed) return;
                        void runCommandDispatcher('clearCacheAndReload');
                    }
                },
                {
                    label: 'Logout',
                    click: async () => {
                        const confirmed = await confirmAction('Are you sure you want to logout?');
                        if (!confirmed) return;
                        void runCommandDispatcher('logout');
                    }
                }
            ]
        },
        { type: 'separator' },
        {
            label: 'Download',
            submenu: [{ label: 'Download Resources', click: () => void runCommandDispatcher('downloadResources') }]
        }
    ]);
}

function attachContextMenu() {
    if (!hasMainWindow()) return;

    contextMenuPopupHandler = (x, y) => {
        const currentUrl = mainWindow.webContents.getURL();
        if (!isPlayableSessionUrl(currentUrl)) return;

        const menu = buildContextMenu();
        const options = { window: mainWindow };
        if (Number.isFinite(x) && Number.isFinite(y)) {
            options.x = Math.round(x);
            options.y = Math.round(y);
        }
        options.callback = () => {
            // Native menu popups can swallow keyup events in some wrappers,
            // so clear cached modifier state after the menu is dismissed.
            modifierState.control = false;
            modifierState.meta = false;
        };
        menu.popup(options);
    };

    mainWindow.webContents.on('before-mouse-event', (event, mouse) => {
        if (!mouse || mouse.type !== 'mouseDown' || mouse.button !== 'right') return;
        const currentUrl = mainWindow.webContents.getURL();
        if (!isPlayableSessionUrl(currentUrl)) return;
        if (isGamePageUrl(currentUrl)) return;

        const openContextMenu = hasCommandOrControlModifier(mouse.modifiers, { allowStateFallback: false });
        if (!openContextMenu) return;

        event.preventDefault();
        contextMenuPopupHandler(mouse.x, mouse.y);
    });

    mainWindow.webContents.on('context-menu', (event, params) => {
        const currentUrl = mainWindow.webContents.getURL();
        if (!isPlayableSessionUrl(currentUrl)) return;
        if (isGamePageUrl(currentUrl)) return;
        if (!hasCommandOrControlModifier(params?.modifiers, { allowStateFallback: false })) return;

        event.preventDefault();
        contextMenuPopupHandler(params?.x, params?.y);
    });
}

function attachShortcutHandlers() {
    if (!hasMainWindow()) return;

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (!input) return;
        const keyLower = String(input.key || '').toLowerCase();
        if (input.type === 'keyUp') {
            if (keyLower === 'control') modifierState.control = false;
            if (keyLower === 'meta' || keyLower === 'command') modifierState.meta = false;
            return;
        }
        if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return;
        if (keyLower === 'control') modifierState.control = true;
        if (keyLower === 'meta' || keyLower === 'command') modifierState.meta = true;
        if (input.isAutoRepeat || input.isComposing) return;

        const currentUrl = mainWindow.webContents.getURL();
        if (!isPlayableSessionUrl(currentUrl)) return;

        const code = String(input.code || '');
        const cmdOrCtrl = commandOrControlPressed(input);
        const hasModifier = !!(input.alt || input.control || input.meta || input.shift);

        if ((keyLower === 'f' || code === 'KeyF') && !hasModifier) {
            void isEditableElementFocused().then(isEditable => {
                if (!isEditable) {
                    void runCommandDispatcher('toggleFullscreen');
                }
            });
            return;
        }

        if ((keyLower === 'b' || code === 'KeyB') && !hasModifier) {
            void isEditableElementFocused().then(isEditable => {
                if (!isEditable) {
                    event.preventDefault();
                    void runCommandDispatcher('toggleBlackout');
                }
            });
            return;
        }

        if ((keyLower === 'm' || code === 'KeyM') && !hasModifier) {
            void isEditableElementFocused().then(isEditable => {
                if (!isEditable) {
                    event.preventDefault();
                    void runCommandDispatcher('toggleMuteAll');
                }
            });
            return;
        }

        if ((keyLower === 'f12' || code === 'F12') && !hasModifier) {
            void isEditableElementFocused().then(isEditable => {
                if (!isEditable) {
                    event.preventDefault();
                    void runCommandDispatcher('screenshotToClipboard');
                }
            });
            return;
        }

        if (cmdOrCtrl && keyLower === 'r' && !input.alt && !input.shift) {
            event.preventDefault();
            void runCommandDispatcher('reload');
            return;
        }

        if (cmdOrCtrl && keyLower === 'r' && !input.alt && input.shift) {
            event.preventDefault();
            void runCommandDispatcher('clearCacheAndReload');
        }
    });
}

async function ensureWebSecurityModeForUrl(url) {
    if (!hasMainWindow()) return false;
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (url.startsWith('chrome-extension://')) return false;
    if (url.includes('/selector.html')) return false;
    if (webSecuritySwitchInProgress) return false;

    const desiredWebSecurity = resolveWebSecurityForUrl(url);
    if (mainWindowWebSecurity === desiredWebSecurity) return false;

    const currentWindow = mainWindow;
    const bounds = currentWindow.getBounds();
    const wasVisible = currentWindow.isVisible();
    const wasMinimized = currentWindow.isMinimized();
    const wasFullscreen = currentWindow.isFullScreen();
    const wasAlwaysOnTop = currentWindow.isAlwaysOnTop();

    webSecuritySwitchInProgress = true;
    try {
        const replacementWindow = createWindow({
            webSecurity: desiredWebSecurity,
            bounds,
            initialUrl: url
        });

        if (!wasVisible) replacementWindow.hide();
        if (wasAlwaysOnTop) replacementWindow.setAlwaysOnTop(true);
        if (wasFullscreen) replacementWindow.setFullScreen(true);
        if (wasMinimized) replacementWindow.minimize();

        if (!currentWindow.isDestroyed()) {
            currentWindow.destroy();
        }

        console.log(`[Security] Switched webSecurity=${desiredWebSecurity} for ${url}`);
        return true;
    } finally {
        webSecuritySwitchInProgress = false;
    }
}

function createWindow(options = {}) {
    const webSecurityEnabled =
        typeof options?.webSecurity === 'boolean' ? options.webSecurity : runtimeFlags.webSecurity;
    const initialUrl = safeTrimmedString(options?.initialUrl);
    const requestedBounds = options?.bounds && typeof options.bounds === 'object' ? options.bounds : null;
    const bounds = requestedBounds || persistedWindowBounds;
    const browserWindowOptions = {
        width: Number.isFinite(bounds?.width) ? bounds.width : DEFAULT_WINDOW_WIDTH,
        height: Number.isFinite(bounds?.height) ? bounds.height : DEFAULT_WINDOW_HEIGHT,
        minWidth: DEFAULT_WINDOW_WIDTH,
        minHeight: DEFAULT_WINDOW_HEIGHT,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: webSecurityEnabled,
            nodeIntegrationInSubFrames: true,
            // Disable background throttling to prevent the game from pausing when minimized
            backgroundThrottling: false,
            // Keep context isolation enabled for safety.
            contextIsolation: true,
            nodeIntegration: false
        }
    };

    if (Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y)) {
        browserWindowOptions.x = bounds.x;
        browserWindowOptions.y = bounds.y;
    }

    mainWindow = new BrowserWindow({
        ...browserWindowOptions
    });
    mainWindowWebSecurity = webSecurityEnabled;
    if (process.platform === 'win32') {
        mainWindow.setMenuBarVisibility(false);
        mainWindow.removeMenu();
    }

    if (runtimeFlags.maskElectronUA) {
        const originalUserAgent = mainWindow.webContents.getUserAgent();
        const sanitizedUserAgent = sanitizeUserAgent(originalUserAgent);
        const syncUserAgentForUrl = url => {
            if (!sanitizedUserAgent || sanitizedUserAgent === originalUserAgent) return;
            const shouldMaskForErolabs = isErolabsUrl(url);
            const targetUserAgent = shouldMaskForErolabs ? sanitizedUserAgent : originalUserAgent;
            if (mainWindow.webContents.getUserAgent() !== targetUserAgent) {
                mainWindow.webContents.setUserAgent(targetUserAgent);
                if (shouldMaskForErolabs) {
                    console.log('[Browser] EROLABS UA compatibility mode enabled.');
                }
            }
        };

        syncUserAgentForUrl(mainWindow.webContents.getURL());
        mainWindow.webContents.on('will-navigate', (event, url) => {
            syncUserAgentForUrl(url);
        });
        mainWindow.webContents.on('did-navigate-in-page', (event, url) => {
            syncUserAgentForUrl(url);
        });

        mainWindow.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
            if (!isMainFrame) return;
            syncUserAgentForUrl(url);
        });

        mainWindow.webContents.on('did-finish-load', () => {
            syncUserAgentForUrl(mainWindow.webContents.getURL());
        });
    }

    if (!webSecurityEnabled) {
        console.warn('[Security] web_security=false. Cloudflare verification may fail on some providers.');
    }

    if (initialUrl) {
        mainWindow.loadURL(initialUrl).catch(error => {
            console.warn(`[Window] Failed to load URL ${initialUrl}: ${error?.message || error}`);
            // Do not force-redirect to selector here; it can abort provider redirects mid-flow.
        });
    } else {
        mainWindow.loadFile(getSelectorFilePath());
    }

    // Open DevTools only when explicitly requested.
    if (process.env.CSC_OPEN_DEVTOOLS === '1') {
        mainWindow.webContents.openDevTools();
    }

    syncWindowFlagsToState();
    updateStatusByUrl(mainWindow.webContents.getURL());
    attachContextMenu();
    attachShortcutHandlers();

    mainWindow.on('enter-full-screen', () => {
        gameCommandState.isFullscreen = true;
    });

    mainWindow.on('leave-full-screen', () => {
        gameCommandState.isFullscreen = false;
    });

    mainWindow.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        void ensureWebSecurityModeForUrl(url);
    });

    mainWindow.webContents.on('did-navigate', (event, url) => {
        void ensureWebSecurityModeForUrl(url).then(switched => {
            if (switched) return;
            updateStatusByUrl(url);
            syncLanguagePreferenceFromUrl(url);
            void enforceProviderStateForUrl(url);
        });
    });

    mainWindow.webContents.on('did-navigate-in-page', (event, url) => {
        void ensureWebSecurityModeForUrl(url).then(switched => {
            if (switched) return;
            updateStatusByUrl(url);
            syncLanguagePreferenceFromUrl(url);
            void enforceProviderStateForUrl(url);
        });
    });

    const ownedWindow = mainWindow;

    mainWindow.on('show', updateTrayDisplay);
    mainWindow.on('hide', updateTrayDisplay);
    mainWindow.on('minimize', updateTrayDisplay);
    mainWindow.on('restore', updateTrayDisplay);
    let persistBoundsDebounceTimer = null;
    const persistOwnedWindowBounds = () => {
        if (mainWindow !== ownedWindow) return;
        persistWindowBounds(ownedWindow);
    };
    const schedulePersistOwnedWindowBounds = () => {
        if (mainWindow !== ownedWindow) return;
        if (persistBoundsDebounceTimer) clearTimeout(persistBoundsDebounceTimer);
        persistBoundsDebounceTimer = setTimeout(() => {
            persistBoundsDebounceTimer = null;
            persistOwnedWindowBounds();
        }, WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS);
    };
    const flushPersistOwnedWindowBounds = () => {
        if (persistBoundsDebounceTimer) {
            clearTimeout(persistBoundsDebounceTimer);
            persistBoundsDebounceTimer = null;
        }
        persistOwnedWindowBounds();
    };
    mainWindow.on('resize', schedulePersistOwnedWindowBounds);
    mainWindow.on('move', schedulePersistOwnedWindowBounds);
    mainWindow.on('close', flushPersistOwnedWindowBounds);

    mainWindow.on('close', () => {
        if (webSecuritySwitchInProgress && ownedWindow !== mainWindow) return;
        isQuitting = true;
    });

    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
        if (persistBoundsDebounceTimer) {
            clearTimeout(persistBoundsDebounceTimer);
            persistBoundsDebounceTimer = null;
        }
        if (mainWindow === ownedWindow) {
            mainWindow = null;
            mainWindowWebSecurity = null;
        }
        stopBlackoutPointerTracking();
        updateTrayDisplay();
    });

    mainWindow.on('blur', () => {
        if (mainWindow !== ownedWindow) return;
        modifierState.control = false;
        modifierState.meta = false;
    });

    mainWindow.webContents.on('did-finish-load', () => {
        if (!gameCommandState.blackout) return;
        emitRendererCommand('setBlackout', { enabled: true });
        syncBlackoutPointerTracking();
    });

    return mainWindow;
}

// ─── Automation Server (CraveAuto sidecar bridge) ────────────────────────────

const AUTOMATION_SERVER_HOST = '127.0.0.1';
const AUTOMATION_SERVER_PORT = 9223;
const AUTOMATION_SERVER_IDLE_MS = 15;
const AUTOMATION_RAID_LOG_LIMIT = 10;

let automationServer = null;

function findActiveWindow() {
    const windows = BrowserWindow.getAllWindows();
    for (const windowRef of windows) {
        if (windowRef && !windowRef.isDestroyed()) return windowRef;
    }
    return null;
}

function buildAutomationEvalSource(rawSource) {
    const source = typeof rawSource === 'string' ? rawSource : String(rawSource ?? '');
    const serializedSource = JSON.stringify(source);

    return `(() => {
        const LOG_LIMIT = ${AUTOMATION_RAID_LOG_LIMIT};

        function warnOnce(targetWindow, key, error) {
            const message = error && error.message ? error.message : String(error);
            try {
                if (!targetWindow.__cscAutomationWarnings || typeof targetWindow.__cscAutomationWarnings !== 'object') {
                    targetWindow.__cscAutomationWarnings = {};
                }
                if (targetWindow.__cscAutomationWarnings[key]) return;
                targetWindow.__cscAutomationWarnings[key] = true;
            } catch (_) {
                console.warn('[Automation] Failed to persist warning flag:', message);
            }
            console.warn('[Automation] ' + key + ': ' + message);
        }

        function ensureCompatGlobals(targetWindow) {
            if (!targetWindow.__cscAutomationCompat || typeof targetWindow.__cscAutomationCompat !== 'object') {
                targetWindow.__cscAutomationCompat = {
                    lastRaidList: [],
                    lastRaidLogs: [],
                    lastUserStatus: null
                };
            }

            const state = targetWindow.__cscAutomationCompat;
            if (!Array.isArray(state.lastRaidList)) state.lastRaidList = [];
            if (!Array.isArray(state.lastRaidLogs)) state.lastRaidLogs = [];
            if (!state.lastUserStatus || typeof state.lastUserStatus !== 'object') state.lastUserStatus = null;

            if (!targetWindow.nw || typeof targetWindow.nw !== 'object') {
                targetWindow.nw = {};
            }
            if (!targetWindow.nw.global || typeof targetWindow.nw.global !== 'object') {
                targetWindow.nw.global = {};
            }

            targetWindow.nw.global.lastRaidList = state.lastRaidList;
            targetWindow.nw.global.lastRaidLogs = state.lastRaidLogs;
            targetWindow.nw.global.lastUserStatus = state.lastUserStatus;
            return targetWindow.nw.global;
        }

        function parseNumberOrNull(value) {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) return null;
            return Math.trunc(numberValue);
        }

        function readUserField(user, camelName, snakeName) {
            if (!user || typeof user !== 'object') return null;
            if (Object.prototype.hasOwnProperty.call(user, camelName)) {
                return user[camelName];
            }
            if (snakeName && Object.prototype.hasOwnProperty.call(user, snakeName)) {
                return user[snakeName];
            }
            return null;
        }

        function looksLikeUserObject(candidate) {
            if (!candidate || typeof candidate !== 'object') return false;
            const keys = [
                'staminaValue',
                'battlePointValue',
                'staminaBonus',
                'battlePointBonus',
                'stamina_value',
                'battle_point_value',
                'stamina_bonus',
                'battle_point_bonus'
            ];
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(candidate, key)) return true;
            }
            return false;
        }

        function extractUserObject(data) {
            if (!data || typeof data !== 'object') return null;
            if (data.user && typeof data.user === 'object') return data.user;
            if (looksLikeUserObject(data)) return data;

            const queue = [data];
            const visited = new WeakSet();
            const maxNodeCount = 500;
            let scanned = 0;

            while (queue.length > 0 && scanned < maxNodeCount) {
                const node = queue.shift();
                scanned += 1;
                if (!node || typeof node !== 'object') continue;
                if (visited.has(node)) continue;
                visited.add(node);

                if (node !== data && looksLikeUserObject(node)) {
                    return node;
                }

                if (Array.isArray(node)) {
                    for (const item of node) {
                        if (item && typeof item === 'object') queue.push(item);
                    }
                    continue;
                }

                for (const key of Object.keys(node)) {
                    const value = node[key];
                    if (key === 'user' && value && typeof value === 'object') return value;
                    if (value && typeof value === 'object') queue.push(value);
                }
            }
            return null;
        }

        function buildUserStatusSnapshot(data) {
            if (!data || typeof data !== 'object') return null;
            const user = extractUserObject(data);
            if (!user) return null;

            const apValue = parseNumberOrNull(readUserField(user, 'staminaValue', 'stamina_value'));
            const apBonus = parseNumberOrNull(readUserField(user, 'staminaBonus', 'stamina_bonus'));
            const rpValue = parseNumberOrNull(readUserField(user, 'battlePointValue', 'battle_point_value'));
            const rpBonus = parseNumberOrNull(readUserField(user, 'battlePointBonus', 'battle_point_bonus'));
            const apRemainSec = parseNumberOrNull(readUserField(user, 'staminaRemainSec', 'stamina_remain_sec'));
            const rpRemainSec = parseNumberOrNull(readUserField(user, 'battlePointRemainSec', 'battle_point_remain_sec'));
            const apRecoveryDate = readUserField(user, 'staminaRecoveryDate', 'stamina_recovery_date');
            const rpRecoveryDate = readUserField(user, 'battlePointRecoveryDate', 'battle_point_recovery_date');

            const hasAnyValue = [apValue, apBonus, rpValue, rpBonus, apRemainSec, rpRemainSec].some(
                value => value !== null
            );
            if (!hasAnyValue) return null;

            return {
                capturedAt: new Date().toISOString(),
                ap_value: apValue,
                ap_bonus: apBonus,
                ap_total: (apValue || 0) + (apBonus || 0),
                ap_remain_sec: apRemainSec,
                ap_recovery_date: apRecoveryDate || null,
                rp_value: rpValue,
                rp_bonus: rpBonus,
                rp_total: (rpValue || 0) + (rpBonus || 0),
                rp_remain_sec: rpRemainSec,
                rp_recovery_date: rpRecoveryDate || null
            };
        }

        function decodeResponsePayload(xhr, targetWindow) {
            if (!xhr) return null;
            const response = xhr.response;
            if (response == null) return null;

            if (typeof response === 'string') {
                try {
                    return JSON.parse(response);
                } catch (error) {
                    warnOnce(targetWindow, 'response-json-parse-failed', error);
                    return null;
                }
            }

            if (typeof response === 'object') {
                try {
                    const api = targetWindow.electronAPI;
                    if (api && typeof api.decodeMsgpack === 'function') {
                        const decoded = api.decodeMsgpack(response);
                        if (decoded != null) return decoded;
                    }
                } catch (error) {
                    warnOnce(targetWindow, 'msgpack-decode-failed', error);
                }

                if (response instanceof ArrayBuffer) {
                    try {
                        return JSON.parse(new targetWindow.TextDecoder().decode(new Uint8Array(response)));
                    } catch (error) {
                        warnOnce(targetWindow, 'arraybuffer-json-parse-failed', error);
                        return null;
                    }
                }

                return response;
            }

            return null;
        }

        function updateRaidAutomationState(targetWindow, pathname, data) {
            const compat = ensureCompatGlobals(targetWindow);
            const state = targetWindow.__cscAutomationCompat;
            const userStatusSnapshot = buildUserStatusSnapshot(data);

            if (userStatusSnapshot) {
                state.lastUserStatus = userStatusSnapshot;
                compat.lastUserStatus = state.lastUserStatus;
            }

            if (/\\/raid\\/(?:getRescueList|getBossList|getList)$/.test(pathname)) {
                let nextRaidList = null;
                if (data && Array.isArray(data.bossList)) {
                    nextRaidList = data.bossList;
                } else if (data && Array.isArray(data.rescueRaidDataList)) {
                    nextRaidList = data.rescueRaidDataList;
                }

                if (nextRaidList) {
                    state.lastRaidList = nextRaidList;
                    compat.lastRaidList = state.lastRaidList;
                }
            }

            state.lastRaidLogs.push({
                path: pathname,
                time: new Date().toISOString(),
                keys: data && typeof data === 'object' ? Object.keys(data) : [],
                has_user_status: !!userStatusSnapshot,
                preview: Array.isArray(data) ? 'Array' : data
            });
            if (state.lastRaidLogs.length > LOG_LIMIT) {
                state.lastRaidLogs.shift();
            }
            compat.lastRaidLogs = state.lastRaidLogs;
        }

        function installRaidHook(targetWindow) {
            if (!targetWindow) return;
            if (targetWindow.__cscAutomationRaidHookInstalled) return;
            targetWindow.__cscAutomationRaidHookInstalled = true;
            ensureCompatGlobals(targetWindow);

            const XHR = targetWindow.XMLHttpRequest;
            if (!XHR || !XHR.prototype || typeof XHR.prototype.open !== 'function') return;
            const originalOpen = XHR.prototype.open;

            XHR.prototype.open = function() {
                this.addEventListener(
                    'readystatechange',
                    function() {
                        if (this.readyState !== 4) return;
                        try {
                            const rawUrl = this.responseURL;
                            if (!rawUrl) return;
                            const parsedUrl = new targetWindow.URL(rawUrl, targetWindow.location.href);
                            const pathname = parsedUrl.pathname || '';
                            if (!pathname || pathname.indexOf('/gg/') !== 0) return;
                            const data = decodeResponsePayload(this, targetWindow);
                            if (!data) return;
                            updateRaidAutomationState(targetWindow, pathname, data);
                        } catch (error) {
                            warnOnce(targetWindow, 'xhr-inspection-failed', error);
                        }
                    },
                    false
                );

                return originalOpen.apply(this, arguments);
            };
        }

        function visitWindows(targetWindow, seen) {
            if (!targetWindow || seen.has(targetWindow)) return;
            seen.add(targetWindow);

            try {
                installRaidHook(targetWindow);
            } catch (error) {
                warnOnce(window, 'install-raid-hook-failed', error);
            }

            try {
                const frames = targetWindow.frames;
                if (!frames || typeof frames.length !== 'number') return;
                for (let i = 0; i < frames.length; i += 1) {
                    visitWindows(frames[i], seen);
                }
            } catch (error) {
                warnOnce(window, 'visit-windows-failed', error);
            }
        }

        function findExecutionWindow(targetWindow, seen) {
            if (!targetWindow || seen.has(targetWindow)) return null;
            seen.add(targetWindow);

            try {
                if (targetWindow.cc) return targetWindow;
            } catch (error) {
                warnOnce(window, 'check-execution-window-failed', error);
            }

            try {
                const frames = targetWindow.frames;
                if (!frames || typeof frames.length !== 'number') return null;
                for (let i = 0; i < frames.length; i += 1) {
                    const nested = findExecutionWindow(frames[i], seen);
                    if (nested) return nested;
                }
            } catch (error) {
                warnOnce(window, 'search-execution-window-failed', error);
            }

            return null;
        }

        visitWindows(window, new WeakSet());

        const executionWindow = findExecutionWindow(window, new WeakSet()) || window;
        const compat = ensureCompatGlobals(executionWindow);
        if (!compat.localStorage && executionWindow.localStorage) {
            compat.localStorage = executionWindow.localStorage;
        }

        return executionWindow.eval(${serializedSource});
    })()`;
}

async function evaluateAutomationScript(rawSource) {
    const targetWindow = findActiveWindow();
    if (!targetWindow) {
        return 'Error: Main window is unavailable';
    }

    try {
        const wrappedSource = buildAutomationEvalSource(rawSource);
        const result = await targetWindow.webContents.executeJavaScript(wrappedSource, true);
        return result == null ? '' : String(result);
    } catch (error) {
        return `Error: ${error?.message || error}`;
    }
}

function stopAutomationServer() {
    if (!automationServer) return;
    const serverRef = automationServer;
    automationServer = null;
    try {
        serverRef.close();
    } catch (error) {
        console.warn(`[Automation] Failed to stop server: ${error?.message || error}`);
    }
}

function startAutomationServer() {
    if (automationServer) return;

    automationServer = net.createServer(socket => {
        socket.setEncoding('utf8');

        let requestBuffer = '';
        let settleTimer = null;
        let replied = false;

        const clearSettleTimer = () => {
            if (!settleTimer) return;
            clearTimeout(settleTimer);
            settleTimer = null;
        };

        const writeResponse = async () => {
            if (replied) return;
            replied = true;
            clearSettleTimer();

            const responseText = await evaluateAutomationScript(requestBuffer);
            try {
                socket.write(`${responseText}\n`);
            } catch (error) {
                console.warn(`[Automation] Failed to write response: ${error?.message || error}`);
            }
            socket.end();
        };

        const scheduleResponse = () => {
            if (replied) return;
            clearSettleTimer();
            settleTimer = setTimeout(() => {
                void writeResponse();
            }, AUTOMATION_SERVER_IDLE_MS);
        };

        socket.on('data', chunk => {
            if (replied) return;
            requestBuffer += chunk;
            scheduleResponse();
        });

        socket.on('end', () => {
            void writeResponse();
        });

        socket.on('error', error => {
            clearSettleTimer();
            if (replied) return;
            replied = true;
            console.warn(`[Automation] Client socket error: ${error?.message || error}`);
            try {
                socket.write(`Error: ${error?.message || error}\n`);
            } catch (writeError) {
                console.warn(
                    `[Automation] Failed to write socket error response: ${writeError?.message || writeError}`
                );
            }
        });

        socket.on('close', clearSettleTimer);
    });

    automationServer.on('error', error => {
        console.warn(`[Automation] Server error: ${error?.message || error}`);
    });

    automationServer.listen(AUTOMATION_SERVER_PORT, AUTOMATION_SERVER_HOST, () => {
        console.log(
            `[Automation] Compatibility server listening on ${AUTOMATION_SERVER_HOST}:${AUTOMATION_SERVER_PORT}`
        );
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(async () => {
    settingsStore = createSettingsStore(app);
    persistedWindowBounds = readPersistedWindowBounds();
    ensureProviderPreferencesLoaded();
    applyProxyEnvironment();
    ensureWindowsToastShortcut();
    try {
        if (proxyConfig && proxyConfig.proxyServer) {
            await session.defaultSession.setProxy({ proxyRules: proxyConfig.proxyServer });
        } else {
            await session.defaultSession.setProxy({ mode: 'direct' });
        }
    } catch (error) {
        console.warn(`[Proxy] Failed to apply session proxy: ${error?.message || error}`);
    }
    syncAudioStateFromSettings();
    if (!runtimeFlags.nocache) {
        // Start the local proxy server for caching
        const cacheOptions = {
            proxyUrl: global.cacheProxyUrl || null
        };
        if (app.isPackaged) {
            cacheOptions.cacheFolder = resolvePackagedCacheFolder();
        }
        cache.setup({
            ...cacheOptions
        });
    }

    createWindow();
    if (runtimeFlags.tray) {
        createTray();
    }
    startAutomationServer();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        if (runtimeFlags.tray) {
            createTray();
        }
        showMainWindow();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
    stopBlackoutPointerTracking();
    stopAutomationServer();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
    stopAutomationServer();
    if (!runtimeFlags.nocache) {
        cache.dispose(); // Cleanup proxy server when quitting
    }
    app.quit();
});

function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    updateTrayDisplay();
}

function hasMainWindow() {
    return !!mainWindow && !mainWindow.isDestroyed();
}

async function confirmAction(message) {
    const ownerWindow = hasMainWindow() ? mainWindow : undefined;
    const { response } = await dialog.showMessageBox(ownerWindow, {
        type: 'question',
        buttons: ['Confirm', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message
    });
    return response === 0;
}

function emitMainEvent(type, payload = null) {
    if (!hasMainWindow()) return false;
    mainWindow.webContents.send('main-event', {
        type,
        payload,
        timestamp: Date.now()
    });
    return true;
}

async function captureWindowToClipboard() {
    if (!hasMainWindow()) {
        return { ok: false, error: 'WINDOW_UNAVAILABLE' };
    }

    try {
        const image = await mainWindow.webContents.capturePage();
        if (!image || image.isEmpty()) {
            return { ok: false, error: 'EMPTY_CAPTURE' };
        }
        clipboard.writeImage(image);
        return { ok: true, method: 'capturePage' };
    } catch (error) {
        return {
            ok: false,
            error: 'CAPTURE_FAILED',
            message: error?.message || String(error)
        };
    }
}

async function runCommandDispatcher(command, payload) {
    if (typeof command !== 'string' || !command.trim()) {
        return {
            ok: false,
            error: 'INVALID_COMMAND',
            message: 'Command must be a non-empty string.'
        };
    }

    if (!hasMainWindow()) {
        return {
            ok: false,
            error: 'WINDOW_UNAVAILABLE',
            command
        };
    }

    const applyAudioPatch = (audioPatch, fallbackUpdater) => {
        if (settingsStore) {
            settingsStore.update({ audio: audioPatch });
            syncAudioStateFromSettings();
            broadcastSettingsSnapshot();
            return;
        }
        fallbackUpdater();
    };

    const runFullscreenCommand = explicitValue => {
        const isFullscreen = explicitValue == null ? !mainWindow.isFullScreen() : explicitValue;
        mainWindow.setFullScreen(isFullscreen);
        gameCommandState.isFullscreen = mainWindow.isFullScreen();
        return { ok: true, command, isFullscreen: gameCommandState.isFullscreen };
    };

    const runBlackoutCommand = enabled => {
        gameCommandState.blackout = enabled;
        const sent = emitRendererCommand('setBlackout', { enabled });
        if (!enabled) {
            stopBlackoutPointerTracking();
            return { ok: sent, command, enabled };
        }
        startBlackoutPointerTracking();
        const pointerSent = emitBlackoutPointerInsideWindow(true);
        return { ok: sent && pointerSent, command, enabled };
    };

    const runMuteAllCommand = enabled => {
        applyAudioPatch(
            {
                muteAll: enabled,
                muteBgm: enabled,
                muteSe: enabled
            },
            () => {
                gameCommandState.muteAll = enabled;
                gameCommandState.muteBgm = enabled;
                gameCommandState.muteSe = enabled;
            }
        );
        const sent = emitRendererCommand('setMuteAll', { enabled });
        return { ok: sent, command, enabled };
    };

    const runMuteBgmCommand = enabled => {
        applyAudioPatch(
            {
                muteBgm: enabled,
                muteAll: enabled && gameCommandState.muteSe
            },
            () => {
                gameCommandState.muteBgm = enabled;
                gameCommandState.muteAll = gameCommandState.muteBgm && gameCommandState.muteSe;
            }
        );
        const sent = emitRendererCommand('setMuteBgm', { enabled });
        return { ok: sent, command, enabled, muteAll: gameCommandState.muteAll };
    };

    const runMuteSeCommand = enabled => {
        applyAudioPatch(
            {
                muteSe: enabled,
                muteAll: gameCommandState.muteBgm && enabled
            },
            () => {
                gameCommandState.muteSe = enabled;
                gameCommandState.muteAll = gameCommandState.muteBgm && gameCommandState.muteSe;
            }
        );
        const sent = emitRendererCommand('setMuteSe', { enabled });
        return { ok: sent, command, enabled, muteAll: gameCommandState.muteAll };
    };

    try {
        switch (command) {
            case 'reload':
                mainWindow.webContents.reload();
                return { ok: true, command };
            case 'clearCacheAndReload': {
                await mainWindow.webContents.session.clearCache();
                mainWindow.webContents.reload();
                return { ok: true, command, cacheCleared: true };
            }
            case 'setFullscreen': {
                const explicitValue = toBooleanFromPayload(payload);
                return runFullscreenCommand(explicitValue);
            }
            case 'toggleFullscreen': {
                return runFullscreenCommand(null);
            }
            case 'toggleFullScreen': {
                return runFullscreenCommand(null);
            }
            case 'setAlwaysOnTop': {
                const explicitValue = toBooleanFromPayload(payload);
                const nextValue = explicitValue == null ? !mainWindow.isAlwaysOnTop() : explicitValue;
                mainWindow.setAlwaysOnTop(nextValue);
                gameCommandState.isAlwaysOnTop = mainWindow.isAlwaysOnTop();
                return {
                    ok: true,
                    command,
                    isAlwaysOnTop: gameCommandState.isAlwaysOnTop
                };
            }
            case 'setBlackout': {
                const explicitValue = toBooleanFromPayload(payload);
                const enabled = explicitValue == null ? !gameCommandState.blackout : explicitValue;
                return runBlackoutCommand(enabled);
            }
            case 'toggleBlackout': {
                const enabled = !gameCommandState.blackout;
                return runBlackoutCommand(enabled);
            }
            case 'setFrameRate': {
                const fps = toFrameRate(payload);
                gameCommandState.frameRate = fps;
                const sent = emitRendererCommand('setFrameRate', { fps });
                return { ok: sent, command, fps };
            }
            case 'setMuteAll': {
                const explicitValue = toBooleanFromPayload(payload);
                const enabled = explicitValue == null ? !gameCommandState.muteAll : explicitValue;
                return runMuteAllCommand(enabled);
            }
            case 'toggleMute':
            case 'toggleMuteAll': {
                const enabled = !gameCommandState.muteAll;
                return runMuteAllCommand(enabled);
            }
            case 'setMuteBgm': {
                const explicitValue = toBooleanFromPayload(payload);
                const enabled = explicitValue == null ? !gameCommandState.muteBgm : explicitValue;
                return runMuteBgmCommand(enabled);
            }
            case 'toggleMuteBgm': {
                const enabled = !gameCommandState.muteBgm;
                return runMuteBgmCommand(enabled);
            }
            case 'setMuteSe': {
                const explicitValue = toBooleanFromPayload(payload);
                const enabled = explicitValue == null ? !gameCommandState.muteSe : explicitValue;
                return runMuteSeCommand(enabled);
            }
            case 'toggleMuteSe': {
                const enabled = !gameCommandState.muteSe;
                return runMuteSeCommand(enabled);
            }
            case 'screenshotToClipboard': {
                const nativeCapture = await captureWindowToClipboard();
                if (nativeCapture.ok) {
                    return { ok: true, command, method: nativeCapture.method };
                }

                const sent = emitRendererCommand('screenshotToClipboard');
                return {
                    ok: sent,
                    command,
                    fallback: nativeCapture
                };
            }
            case 'downloadResources': {
                const sent = emitRendererCommand('downloadResources');
                return { ok: sent, command };
            }
            case 'openContextMenu': {
                if (typeof contextMenuPopupHandler !== 'function') {
                    return { ok: false, error: 'CONTEXT_MENU_UNAVAILABLE', command };
                }
                const x = Number(payload?.x);
                const y = Number(payload?.y);
                contextMenuPopupHandler(Number.isFinite(x) ? x : undefined, Number.isFinite(y) ? y : undefined);
                return { ok: true, command };
            }
            case 'changeLanguage': {
                const languages = normalizeLanguageList(globalState.langs);
                if (languages.length === 0) {
                    return { ok: false, error: 'LANGUAGE_UNAVAILABLE', command };
                }

                const requestedLanguageId =
                    typeof payload === 'string' ? payload : safeTrimmedString(payload?.lang || payload?.id);
                const nextLanguage = resolveLanguageSelection(languages, requestedLanguageId, globalState.entryUrl);
                if (!nextLanguage) {
                    return { ok: false, error: 'LANGUAGE_UNAVAILABLE', command };
                }

                setProviderState(
                    {
                        langs: languages,
                        lang: nextLanguage.id,
                        entryUrl: nextLanguage.url
                    },
                    { emitEvent: true }
                );

                if (globalState.defaultProvider) {
                    setProviderLanguagePreference(globalState.defaultProvider, nextLanguage.id);
                }

                await mainWindow.loadURL(nextLanguage.url);
                return {
                    ok: true,
                    command,
                    lang: nextLanguage.id,
                    entryUrl: nextLanguage.url
                };
            }
            case 'logout': {
                const result = await executeLogoutFlow();
                return {
                    ...result,
                    command
                };
            }
            case 'changeProvider': {
                resetProviderState({ keepRuntimeProvider: false });
                const requestedReselect = safeTrimmedString(payload?.reselect);
                await loadSelectorPage({ reselect: requestedReselect || '1' });
                return { ok: true, command, redirectedToSelector: true };
            }
            case 'recover-provider-state': {
                if (!hasConfiguredProviderState()) {
                    resetProviderState({ keepRuntimeProvider: false });
                }
                await loadSelectorPage({ reselect: '1' });
                return { ok: true, command, redirectedToSelector: true };
            }
            case 'emitRendererEvent': {
                const type = payload?.type || 'custom';
                const eventPayload = payload?.payload ?? payload ?? null;
                const sent = emitMainEvent(type, eventPayload);
                return { ok: sent, command, type };
            }
            default:
                return {
                    ok: false,
                    error: 'UNKNOWN_COMMAND',
                    command
                };
        }
    } catch (error) {
        return {
            ok: false,
            error: 'COMMAND_FAILED',
            command,
            message: error?.message || String(error)
        };
    }
}

function notifyElectron(payload) {
    const { Notification } = require('electron');
    const title = payload?.title || 'Crave Saga';
    const body = payload?.body || '';
    const result = {
        electronSupported: false,
        electronAttempted: false,
        electronShown: false
    };

    try {
        result.electronSupported = Notification.isSupported();
        console.log(`[NotificationDebug] Notification.isSupported=${result.electronSupported}`);
        if (result.electronSupported) {
            result.electronAttempted = true;
            const notificationOptions = {
                title,
                body,
                silent: false
            };
            if (process.platform !== 'darwin') {
                notificationOptions.icon = getNotificationIconPath();
            }
            const notify = new Notification(notificationOptions);
            notify.on('click', () => {
                focusMainWindow();
            });
            notify.show();
            result.electronShown = true;
            console.log('[NotificationDebug] electron notify.show() called');
        }
    } catch (error) {
        console.log(`[NotificationDebug] electron notification error: ${error?.message || error}`);
    }

    return result;
}

function notifyRouter(payload) {
    const title = payload?.title || 'Crave Saga';
    const body = payload?.body || '';
    const type = payload?.type || null;
    const result = {
        electronSupported: false,
        electronAttempted: false,
        electronShown: false
    };

    if (!isNotificationEnabled(type)) {
        console.log(`[NotificationDebug] skipped notification type=${type || 'unknown'}`);
        return {
            ...result,
            skippedBySetting: true
        };
    }

    console.log(`[NotificationDebug] IPC received: ${title} | ${body}`);
    return {
        ...result,
        ...notifyElectron(payload)
    };
}

function dispatchNotification(payload) {
    return notifyRouter(payload);
}

ipcMain.handle('show-notification', (event, payload) => {
    return dispatchNotification(payload);
});

ipcMain.on('get-settings-sync', event => {
    event.returnValue = getSettingsSnapshot();
});

ipcMain.handle('get-settings', () => {
    return getSettingsSnapshot();
});

ipcMain.handle('update-settings', (event, patch) => {
    if (!settingsStore) return getSettingsSnapshot();
    const next = settingsStore.update(patch);
    syncAudioStateFromSettings();
    broadcastSettingsSnapshot();
    return next;
});

ipcMain.handle('set-setting', (event, request) => {
    if (!settingsStore) return getSettingsSnapshot();
    const next = settingsStore.set(request?.path, request?.value);
    syncAudioStateFromSettings();
    broadcastSettingsSnapshot();
    return next;
});

ipcMain.handle('run-command', (event, request) => {
    const command = request?.command;
    const payload = request?.payload;
    return runCommandDispatcher(command, payload);
});

function applyGameProviderState(data) {
    ensureProviderPreferencesLoaded();

    const nextProvider = safeTrimmedString(data?.provider);
    const nextEntryUrl = safeTrimmedString(data?.entryUrl);
    const nextDefaultProvider = safeTrimmedString(data?.defaultProvider);
    const nextLangs = normalizeLanguageList(data?.langs);
    const preferredLang = safeTrimmedString(data?.lang) || getProviderLanguagePreference(nextDefaultProvider);
    const selectedLanguage = resolveLanguageSelection(nextLangs, preferredLang, nextEntryUrl);
    const resolvedEntryUrl = selectedLanguage ? selectedLanguage.url : nextEntryUrl;
    const hasSuccess = Object.prototype.hasOwnProperty.call(data || {}, 'success');

    if (!nextProvider || !resolvedEntryUrl) {
        resetProviderState({ keepRuntimeProvider: false });
        return cloneProviderState();
    }

    const nextState = setProviderState(
        {
            provider: nextProvider,
            cookieHosts: Array.isArray(data?.cookieHosts) ? data.cookieHosts : [],
            entryUrl: resolvedEntryUrl,
            defaultProvider: nextDefaultProvider,
            loginRegex: data?.loginRegex,
            pageRegex: data?.pageRegex,
            gameRegex: data?.gameRegex,
            wrapperRegex: data?.wrapperRegex,
            langs: nextLangs,
            lang: selectedLanguage ? selectedLanguage.id : null,
            success: hasSuccess ? !!data.success : false
        },
        { emitEvent: true }
    );

    if (nextDefaultProvider && selectedLanguage?.id) {
        setProviderLanguagePreference(nextDefaultProvider, selectedLanguage.id);
    }

    return nextState;
}

ipcMain.handle('set-game-provider', (event, data) => {
    console.log('Provider set from UI:', data?.provider);
    return applyGameProviderState(data);
});

ipcMain.on('set-game-provider', (event, data) => {
    console.log('Provider set from UI:', data?.provider);
    applyGameProviderState(data);
});

ipcMain.handle('get-provider-language-preference', (event, providerKey) => {
    ensureProviderPreferencesLoaded();
    return getProviderLanguagePreference(providerKey);
});

ipcMain.handle('set-provider-language-preference', (event, payload) => {
    ensureProviderPreferencesLoaded();
    return setProviderLanguagePreference(payload?.provider, payload?.lang);
});

ipcMain.handle('get-custom-scripts', () => {
    return loadCustomScripts();
});

ipcMain.on('get-provider-state-sync', event => {
    event.returnValue = cloneProviderState();
});

ipcMain.on('get-runtime-config-sync', event => {
    event.returnValue = { ...runtimeFlags };
});

ipcMain.handle('get-provider-state', () => {
    return cloneProviderState();
});

ipcMain.handle('clear-provider-state', (event, payload) => {
    const keepRuntimeProvider = !!payload?.keepRuntimeProvider;
    return resetProviderState({ keepRuntimeProvider });
});

ipcMain.on('mark-provider-success', (event, payload) => {
    setProviderState(
        {
            success: payload?.success !== false
        },
        { emitEvent: true }
    );
});

ipcMain.handle('mark-provider-success', (event, payload) => {
    return setProviderState(
        {
            success: payload?.success !== false
        },
        { emitEvent: true }
    );
});

ipcMain.on('set-tray-status', (event, payload) => {
    const nextStatus = typeof payload === 'string' ? payload : payload?.status;
    if (typeof nextStatus === 'string' && nextStatus.trim()) {
        globalState.status = nextStatus;
        updateTrayDisplay();
    }
});

// --- Phase 3: Cache IPC Handlers ---
// Return the dynamically assigned port of the local proxy server
ipcMain.handle('get-proxy-port', () => {
    return global.resourceProxyPort || 0;
});

// Receive target host information from the game renderer and store it in global context
ipcMain.on('set-cache-config', (event, data) => {
    if (data.resourceHost) global.resourceHost = data.resourceHost;
    if (data.clientHost) global.clientHost = data.clientHost;
    if (data.clientVersion) global.clientVersion = data.clientVersion;
    console.log(`[Cache Config] Res: ${global.resourceHost}, Client: ${global.clientHost}, Ver: ${global.clientVersion}`);
});

ipcMain.on('decode-msgpack-sync', (event, arrayBuffer) => {
    try {
        if (!arrayBuffer) {
            event.returnValue = null;
            return;
        }
        event.returnValue = decodeMsgpack(new Uint8Array(arrayBuffer), { useMap: false });
    } catch (e) {
        event.returnValue = null;
    }
});
