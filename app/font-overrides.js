//@ts-check
const fs = require('fs');
const path = require('path');

const FONT_CONTENT_TYPES = Object.freeze({
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const FONT_VERSION_DEFINITIONS = Object.freeze([
  {
    id: 'tw',
    label: '繁體中文',
    hostPatterns: [
      /dl4zp4nhv8if1\.cloudfront\.net$/i,
      /erolabs-client-ch\.r\.cravesaga\.johren\.games$/i,
    ],
  },
  {
    id: 'cn',
    label: '简体中文',
    hostPatterns: [
      /d33gp7h5nxkdvq\.cloudfront\.net$/i,
      /erolabs-client-ch\.r\.cravesaga\.johren\.games$/i,
    ],
  },
  {
    id: 'en',
    label: 'English',
    hostPatterns: [
      /d2z1bqkh6aowmt\.cloudfront\.net$/i,
      /(?:johren|nutaku)-client-en\.(?:g|r)\.cravesaga\.johren\.games$/i,
    ],
  },
  {
    id: 'ja',
    label: '日本語',
    hostPatterns: [
      /gg-client-[wr]\.crave-saga\.net$/i,
      /gg-dmm-gadgets\.crave-saga\.net$/i,
    ],
  },
]);

const FONT_TARGETS = Object.freeze([
  {
    key: 'twBold',
    version: 'tw',
    label: 'ResourceHanRoundedTW-Bold',
    fontName: 'ResourceHanRoundedTW-Bold.ttf',
  },
  {
    key: 'twHeavy',
    version: 'tw',
    label: 'ResourceHanRoundedTW-Heavy',
    fontName: 'ResourceHanRoundedTW-Heavy.ttf',
  },
  {
    key: 'cnHeavy',
    version: 'cn',
    label: 'ResourceHanRoundedCN-Heavy',
    fontName: 'ResourceHanRoundedCN-Heavy.ttf',
  },
  {
    key: 'cnBold',
    version: 'cn',
    label: 'ResourceHanRoundedCN-Bold',
    fontName: 'ResourceHanRoundedCN-Bold.ttf',
  },
  {
    key: 'enText',
    version: 'en',
    label: 'TTF-NPRodin-EB',
    fontName: 'TTF-NPRodin-EB.ttf',
  },
  {
    key: 'enTextBold',
    version: 'en',
    label: 'TTF-NPRodin-B',
    fontName: 'TTF-NPRodin-B.ttf',
  },
  {
    key: 'jaText',
    version: 'ja',
    label: 'UDKakugo_LargePr6N-HV',
    fontName: 'UDKakugo_LargePr6N-HV.ttf',
  },
  {
    key: 'jaTextBold',
    version: 'ja',
    label: 'UDKakugo_LargePr6N-B',
    fontName: 'UDKakugo_LargePr6N-B.ttf',
  },
]);

const DEFAULT_FONT_NAMES = Object.freeze([...new Set(FONT_TARGETS.map(target => target.fontName))]);

const FONT_ROLE_TO_NAME = Object.freeze({
  bold: 'ResourceHanRoundedTW-Bold.ttf',
  heavy: 'ResourceHanRoundedTW-Heavy.ttf',
  twBold: 'ResourceHanRoundedTW-Bold.ttf',
  twHeavy: 'ResourceHanRoundedTW-Heavy.ttf',
  cnHeavy: 'ResourceHanRoundedCN-Heavy.ttf',
  cnBold: 'ResourceHanRoundedCN-Bold.ttf',
  enText: 'TTF-NPRodin-EB.ttf',
  enTextBold: 'TTF-NPRodin-B.ttf',
  jaText: 'UDKakugo_LargePr6N-HV.ttf',
  jaTextBold: 'UDKakugo_LargePr6N-B.ttf',
});

function normalizeFontName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const base = path.basename(trimmed);
  return base === trimmed ? base : '';
}

function isSupportedFontPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONT_CONTENT_TYPES, ext);
}

function getSupportedFontExtensionsLabel() {
  return Object.keys(FONT_CONTENT_TYPES).join(', ');
}

function getPackagedUserDataPath() {
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && app.isPackaged && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch (_) {
    // Non-Electron test runs use the repo-local custom directory.
  }
  return '';
}

function isAsarPath(value) {
  if (typeof value !== 'string') return false;
  return value.split(path.sep).some(part => part.toLowerCase().endsWith('.asar'));
}

function resolveDefaultCustomRoot(repoRoot, options = {}) {
  if (options.customRoot) return path.resolve(options.customRoot);
  const packagedUserDataRoot = typeof options.packagedUserDataRoot === 'string'
    ? options.packagedUserDataRoot.trim()
    : '';
  const electronUserDataRoot = packagedUserDataRoot || getPackagedUserDataPath();
  if (electronUserDataRoot && isAsarPath(repoRoot)) {
    return path.resolve(electronUserDataRoot, 'custom');
  }
  return path.resolve(path.join(repoRoot, 'custom'));
}

function createFontOverridePaths(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..'));
  const customRoot = resolveDefaultCustomRoot(repoRoot, options);
  const configPath = path.resolve(options.configPath || path.join(customRoot, 'font-overrides.json'));
  const defaultFontRoot = path.resolve(options.defaultFontRoot || path.join(customRoot, 'fonts'));
  return {
    repoRoot,
    customRoot,
    configPath,
    defaultFontRoot,
  };
}

function resolveDefaultFontPath(defaultFontRoot, fontName) {
  const parsed = path.parse(fontName);
  const candidates = [
    path.join(defaultFontRoot, fontName),
    ...Object.keys(FONT_CONTENT_TYPES)
      .filter(ext => ext !== parsed.ext.toLowerCase())
      .map(ext => path.join(defaultFontRoot, `${parsed.name}${ext}`)),
  ];
  return candidates.find(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  }) || candidates[0];
}

function resolveRulePath(value, repoRoot, customRoot) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const source = value.trim();
  if (path.isAbsolute(source)) return path.resolve(source);
  if (source === 'custom' || source.startsWith(`custom${path.sep}`) || source.startsWith('custom/')) {
    return path.resolve(repoRoot, source);
  }
  return path.resolve(customRoot, source);
}

function getFontTarget(targetKey) {
  return FONT_TARGETS.find(target => target.key === targetKey) || null;
}

function getVersionDefinition(versionId) {
  return FONT_VERSION_DEFINITIONS.find(version => version.id === versionId) || null;
}

function normalizeHost(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const source = value.trim();
  try {
    return new URL(source).hostname.toLowerCase();
  } catch (_) {
    return source.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':')[0].toLowerCase();
  }
}

function getFontVersionForHost(hostValue) {
  const host = normalizeHost(hostValue);
  if (!host) return '';
  for (const version of FONT_VERSION_DEFINITIONS) {
    if (version.hostPatterns.some(pattern => pattern.test(host))) return version.id;
  }
  return '';
}

function normalizeFontVersion(value) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (source === 'zh' || source === 'tw') return 'tw';
  if (source === 'cn' || source === 'sc') return 'cn';
  if (source === 'en') return 'en';
  if (source === 'ja' || source === 'jp') return 'ja';
  return '';
}

function getTargetFamilyNames(target) {
  const family = target.fontName.replace(/\.[^.]+$/, '');
  return [family, `${family}_LABEL`];
}

function readFontOverrideConfig(options = {}) {
  const { configPath } = createFontOverridePaths(options);
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn(`[FontOverride] Failed to read ${configPath}: ${error?.message || error}`);
    return null;
  }
}

function getRawTargetSettings(config) {
  const targets = {};
  if (config && config.targets && typeof config.targets === 'object' && !Array.isArray(config.targets)) {
    for (const [key, value] of Object.entries(config.targets)) {
      if (typeof value === 'string') targets[key] = value;
    }
  }

  const legacyRules = config && config.rules && typeof config.rules === 'object' && !Array.isArray(config.rules)
    ? config.rules
    : {};
  if (!targets.twBold && typeof legacyRules['ResourceHanRoundedTW-Bold.ttf'] === 'string') {
    targets.twBold = legacyRules['ResourceHanRoundedTW-Bold.ttf'];
  }
  if (!targets.twHeavy && typeof legacyRules['ResourceHanRoundedTW-Heavy.ttf'] === 'string') {
    targets.twHeavy = legacyRules['ResourceHanRoundedTW-Heavy.ttf'];
  }

  return targets;
}

function loadFontOverrideRules(options = {}) {
  const { repoRoot, customRoot, configPath, defaultFontRoot } = createFontOverridePaths(options);
  let enabled = true;
  const config = readFontOverrideConfig({ configPath });
  const rawTargets = getRawTargetSettings(config);
  const rules = [];

  if (config && config.enabled === false) enabled = false;

  for (const target of FONT_TARGETS) {
    const explicitPath = resolveRulePath(rawTargets[target.key], repoRoot, customRoot);
    const filePath = explicitPath || resolveDefaultFontPath(defaultFontRoot, target.fontName);
    rules.push({
      ...target,
      filePath,
      familyNames: getTargetFamilyNames(target),
    });
  }

  return {
    enabled,
    rules,
  };
}

function getFontOverrideSettings(options = {}) {
  const config = readFontOverrideConfig(options) || {};
  const rawTargets = getRawTargetSettings(config);
  const targets = {};

  for (const target of FONT_TARGETS) {
    targets[target.key] = typeof rawTargets[target.key] === 'string' ? rawTargets[target.key] : '';
  }

  return {
    enabled: config.enabled !== false,
    bold: targets.twBold,
    heavy: targets.twHeavy,
    targets,
    versions: FONT_VERSION_DEFINITIONS.map(version => ({
      id: version.id,
      label: version.label,
    })),
    definitions: FONT_TARGETS.map(target => ({
      key: target.key,
      version: target.version,
      label: target.label,
      fontName: target.fontName,
    })),
  };
}

function normalizeFontOverrideSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const sourceTargets = source.targets && typeof source.targets === 'object' && !Array.isArray(source.targets)
    ? source.targets
    : {};
  const targets = {};

  for (const target of FONT_TARGETS) {
    let value = typeof sourceTargets[target.key] === 'string' ? sourceTargets[target.key].trim() : '';
    if (!value && target.key === 'twBold' && typeof source.bold === 'string') value = source.bold.trim();
    if (!value && target.key === 'twHeavy' && typeof source.heavy === 'string') value = source.heavy.trim();
    if (value && !isSupportedFontPath(value)) {
      const ext = path.extname(value || '').toLowerCase() || '(none)';
      throw new Error(
        `${target.label} uses unsupported font extension ${ext}; supported: ${getSupportedFontExtensionsLabel()}`
      );
    }
    targets[target.key] = value;
  }

  return {
    enabled: source.enabled !== false,
    targets,
  };
}

function saveFontOverrideSettings(input, options = {}) {
  const { customRoot, configPath } = createFontOverridePaths(options);
  const settings = normalizeFontOverrideSettings(input);
  const targets = {};

  for (const target of FONT_TARGETS) {
    if (settings.targets[target.key]) targets[target.key] = settings.targets[target.key];
  }

  const config = {
    enabled: settings.enabled,
    targets,
  };

  fs.mkdirSync(customRoot, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return getFontOverrideSettings(options);
}

function targetMatchesContext(rule, context = {}) {
  if (context.targetKey) return rule.key === context.targetKey;
  const version = normalizeFontVersion(context.version) || getFontVersionForHost(context.host || context.clientHost || '');
  if (!version) return true;
  return rule.version === version;
}

function getFontOverrideSummary(options = {}) {
  const config = loadFontOverrideRules(options);
  const context = {
    version: normalizeFontVersion(options.version),
    host: options.host || options.clientHost,
    targetKey: options.targetKey,
  };
  const rules = [];

  for (const rule of config.rules) {
    if (!targetMatchesContext(rule, context)) continue;
    let exists = false;
    try {
      exists = fs.statSync(rule.filePath).isFile();
    } catch (_) {
      exists = false;
    }
    rules.push({
      key: rule.key,
      version: rule.version,
      label: rule.label,
      fontName: rule.fontName,
      familyNames: rule.familyNames,
      filePath: rule.filePath,
      exists,
    });
  }

  return {
    enabled: config.enabled,
    version: context.version || getFontVersionForHost(context.host || ''),
    rules,
  };
}

function buildFontOverrideCss(proxyBaseUrl, options = {}) {
  if (typeof proxyBaseUrl !== 'string' || !proxyBaseUrl.trim()) return '';
  const summary = getFontOverrideSummary(options);
  if (!summary.enabled) return '';

  const baseUrl = proxyBaseUrl.replace(/\/+$/, '');
  const stamp = Date.now();
  const blocks = [];

  for (const rule of summary.rules) {
    if (!rule.exists) continue;
    const fontUrl = `${baseUrl}/font-overrides/${encodeURIComponent(rule.key)}/${encodeURIComponent(rule.fontName)}?csc_font_override=${stamp}`;
    for (const fontFamily of rule.familyNames) {
      blocks.push(`@font-face { font-family: "${fontFamily}"; src: url("${fontUrl}"); }`);
    }
  }

  return blocks.join('\n');
}

function getRequestedFontName(requestPath) {
  if (typeof requestPath !== 'string' || !requestPath) return '';
  const [withoutHash] = requestPath.split('#');
  const [withoutQuery] = withoutHash.split('?');
  return normalizeFontName(path.basename(withoutQuery || ''));
}

function parseFontOverrideEndpoint(requestPath) {
  const [withoutHash] = String(requestPath || '').split('#');
  const [withoutQuery] = withoutHash.split('?');
  const parts = withoutQuery.split('/').filter(Boolean).map(part => decodeURIComponent(part));
  if (parts.length >= 2 && getFontTarget(parts[0])) {
    return {
      targetKey: parts[0],
      fontName: normalizeFontName(parts[parts.length - 1]),
    };
  }
  return {
    targetKey: '',
    fontName: normalizeFontName(path.basename(withoutQuery || '')),
  };
}

function getFontOverrideForRequest(requestPath, options = {}) {
  if (typeof requestPath !== 'string' || !requestPath) return null;

  const endpoint = options.targetKey
    ? { targetKey: options.targetKey, fontName: getRequestedFontName(requestPath) }
    : parseFontOverrideEndpoint(requestPath);
  const requestedFontName = endpoint.fontName || getRequestedFontName(requestPath);
  if (!requestedFontName) return null;

  const config = loadFontOverrideRules(options);
  if (!config.enabled) return null;

  const context = {
    targetKey: options.targetKey || endpoint.targetKey,
    version: normalizeFontVersion(options.version),
    host: options.host || options.clientHost,
  };
  const rule = config.rules.find(candidate => (
    candidate.fontName === requestedFontName &&
    targetMatchesContext(candidate, context)
  ));
  if (!rule || !rule.filePath || !isSupportedFontPath(rule.filePath)) return null;

  try {
    const stat = fs.statSync(rule.filePath);
    if (!stat.isFile()) return null;
    return {
      targetKey: rule.key,
      version: rule.version,
      requestedFontName,
      filePath: rule.filePath,
      size: stat.size,
      contentType: FONT_CONTENT_TYPES[path.extname(rule.filePath).toLowerCase()] || 'application/octet-stream',
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_FONT_NAMES,
  FONT_CONTENT_TYPES,
  FONT_ROLE_TO_NAME,
  FONT_TARGETS,
  FONT_VERSION_DEFINITIONS,
  buildFontOverrideCss,
  getFontOverrideForRequest,
  getFontOverrideSettings,
  getFontOverrideSummary,
  getFontVersionForHost,
  getRequestedFontName,
  getTargetFamilyNames,
  loadFontOverrideRules,
  normalizeFontName,
  saveFontOverrideSettings,
};
