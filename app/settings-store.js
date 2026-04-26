const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
    notifications: {
        battleEnd: true,
        raidDeath: true,
        expedition: true,
        eventExpedition: true,
        stamina: true,
        battlepoint: true
    },
    audio: {
        muteAll: false,
        muteBgm: false,
        muteSe: false
    },
    mobileNotifications: {
        telegram: { enabled: false, botToken: '', chatId: '' },
        discord: { enabled: false, webhookUrl: '' }
    }
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function normalizeSettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    const notifications = source.notifications && typeof source.notifications === 'object' ? source.notifications : {};
    const audio = source.audio && typeof source.audio === 'object' ? source.audio : {};
    const mobile = source.mobileNotifications && typeof source.mobileNotifications === 'object' ? source.mobileNotifications : {};
    const mobileTelegram = mobile.telegram && typeof mobile.telegram === 'object' ? mobile.telegram : {};
    const mobileDiscord = mobile.discord && typeof mobile.discord === 'object' ? mobile.discord : {};

    return {
        notifications: {
            battleEnd: normalizeBoolean(notifications.battleEnd, DEFAULT_SETTINGS.notifications.battleEnd),
            raidDeath: normalizeBoolean(notifications.raidDeath, DEFAULT_SETTINGS.notifications.raidDeath),
            expedition: normalizeBoolean(notifications.expedition, DEFAULT_SETTINGS.notifications.expedition),
            eventExpedition: normalizeBoolean(notifications.eventExpedition, DEFAULT_SETTINGS.notifications.eventExpedition),
            stamina: normalizeBoolean(notifications.stamina, DEFAULT_SETTINGS.notifications.stamina),
            battlepoint: normalizeBoolean(notifications.battlepoint, DEFAULT_SETTINGS.notifications.battlepoint)
        },
        audio: {
            muteAll: normalizeBoolean(audio.muteAll, DEFAULT_SETTINGS.audio.muteAll),
            muteBgm: normalizeBoolean(audio.muteBgm, DEFAULT_SETTINGS.audio.muteBgm),
            muteSe: normalizeBoolean(audio.muteSe, DEFAULT_SETTINGS.audio.muteSe)
        },
        mobileNotifications: {
            telegram: {
                enabled: normalizeBoolean(mobileTelegram.enabled, DEFAULT_SETTINGS.mobileNotifications.telegram.enabled),
                botToken: normalizeString(mobileTelegram.botToken, DEFAULT_SETTINGS.mobileNotifications.telegram.botToken),
                chatId: normalizeString(mobileTelegram.chatId, DEFAULT_SETTINGS.mobileNotifications.telegram.chatId)
            },
            discord: {
                enabled: normalizeBoolean(mobileDiscord.enabled, DEFAULT_SETTINGS.mobileNotifications.discord.enabled),
                webhookUrl: normalizeString(mobileDiscord.webhookUrl, DEFAULT_SETTINGS.mobileNotifications.discord.webhookUrl)
            }
        }
    };
}

function pathParts(pathOrKey) {
    if (Array.isArray(pathOrKey)) return pathOrKey.filter(Boolean);
    if (typeof pathOrKey === 'string' && pathOrKey.trim()) return pathOrKey.split('.').filter(Boolean);
    return [];
}

function getByPath(source, parts) {
    let current = source;
    for (const part of parts) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function setByPath(source, parts, value) {
    const next = clone(source);
    let current = next;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!current[key] || typeof current[key] !== 'object') {
            current[key] = {};
        }
        current = current[key];
    }
    current[parts[parts.length - 1]] = value;
    return next;
}

function mergeSettings(current, patch) {
    const next = clone(current);
    if (patch && typeof patch === 'object') {
        if (patch.notifications && typeof patch.notifications === 'object') {
            next.notifications = {
                ...next.notifications,
                ...patch.notifications
            };
        }
        if (patch.audio && typeof patch.audio === 'object') {
            next.audio = {
                ...next.audio,
                ...patch.audio
            };
        }
        if (patch.mobileNotifications && typeof patch.mobileNotifications === 'object') {
            const mb = patch.mobileNotifications;
            next.mobileNotifications = {
                ...next.mobileNotifications,
                ...(mb.telegram && typeof mb.telegram === 'object'
                    ? { telegram: { ...next.mobileNotifications.telegram, ...mb.telegram } }
                    : {}),
                ...(mb.discord && typeof mb.discord === 'object'
                    ? { discord: { ...next.mobileNotifications.discord, ...mb.discord } }
                    : {})
            };
        }
    }
    return normalizeSettings(next);
}

function createSettingsStore(app, fileName = 'settings.json') {
    const filePath = path.join(app.getPath('userData'), fileName);
    let state = normalizeSettings(null);

    function save() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }

    function load() {
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf8');
                state = normalizeSettings(raw ? JSON.parse(raw) : null);
                return getAll();
            }
        } catch {
            // Fall through to defaults when the settings file is missing or corrupt.
        }

        state = normalizeSettings(null);
        save();
        return getAll();
    }

    function getAll() {
        return clone(state);
    }

    function get(pathOrKey) {
        const parts = pathParts(pathOrKey);
        if (!parts.length) return getAll();
        return getByPath(state, parts);
    }

    function set(pathOrKey, value) {
        const parts = pathParts(pathOrKey);
        if (!parts.length) return getAll();
        state = normalizeSettings(setByPath(state, parts, value));
        save();
        return getAll();
    }

    function update(patch) {
        state = mergeSettings(state, patch);
        save();
        return getAll();
    }

    load();

    return {
        filePath,
        getAll,
        get,
        set,
        update,
        load,
        save
    };
}

module.exports = {
    DEFAULT_SETTINGS,
    createSettingsStore,
    normalizeSettings
};
