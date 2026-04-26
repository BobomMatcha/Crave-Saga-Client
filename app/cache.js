//@ts-check
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');
const decompressResponse = require('decompress-response');
const { ProxyAgent } = require('proxy-agent');

const defaultCacheFolder = path.resolve(__dirname, '..', 'cache');
let cacheFolder = defaultCacheFolder;
let resourceCacheFolder = path.join(cacheFolder, 'resources');
let clientCacheFolder = path.join(cacheFolder, 'client');

function log() {
  console.log(...arguments);
}

function ensureDirectory(targetFolder) {
  if (!targetFolder) return;
  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder, { recursive: true });
  }
}

function setCacheRoot(cacheRootFolder) {
  const resolved = typeof cacheRootFolder === 'string' && cacheRootFolder.trim()
    ? path.resolve(cacheRootFolder)
    : defaultCacheFolder;

  cacheFolder = resolved;
  resourceCacheFolder = path.join(cacheFolder, 'resources');
  clientCacheFolder = path.join(cacheFolder, 'client');
  ensuredClientCacheFolders.clear();
}

function ensureCacheFolders() {
  ensureDirectory(cacheFolder);
  ensureDirectory(resourceCacheFolder);
  ensureDirectory(clientCacheFolder);
}

/** @type {any} */
const anyGlobal = global;

anyGlobal.cacheLoader = true;
anyGlobal.resourceProxyPort = 0;

let streamWatch = {};
const CONTENT_TYPE_CACHE_LIMIT = 1024;
const contentTypeMetadataCache = new Map();
const ensuredClientCacheFolders = new Set();
const createWriteStream = filePath => {
  if (streamWatch[filePath]) {
    return null;
  }

  const stream = fs.createWriteStream(filePath);
  streamWatch[filePath] = stream;
  return stream;
};

const finishWriteStream = filePath => {
  delete streamWatch[filePath];
};

// close all current writing streams
anyGlobal.resetResourceCache = () => {
  for (let filePath in streamWatch) {
    streamWatch[filePath].destroy();
  }
  streamWatch = {};
  contentTypeMetadataCache.clear();
  ensuredClientCacheFolders.clear();
};

let server = null;

function convertToValidFilename(string) {
  if (typeof string !== 'string') return '';
  return string.replace(/[\/|\\:*?"<>]/g, '');
}

function getCacheFilename(host, requestPath) {
  if (!requestPath || typeof requestPath !== 'string') return 'unknown.asset';
  const normalizedHost = typeof host === 'string' && host ? host : 'unknown-host';
  const [withoutHash] = requestPath.split('#');
  const [withoutQuery] = withoutHash.split('?');
  const ext = convertToValidFilename(path.extname(withoutQuery || '')) || '';
  const keySource = `${normalizedHost}|${withoutHash}`;
  const hash = crypto.createHash('md5').update(keySource).digest('hex');
  return ext ? `${hash}${ext}` : hash;
}

function isHashedAssetPath(requestPath) {
  if (!requestPath || typeof requestPath !== 'string') return false;
  const [withoutHash] = requestPath.split('#');
  const [withoutQuery] = withoutHash.split('?');
  const base = path.basename(withoutQuery || '');
  return /^[0-9a-f]{32}(?:[._-][a-z0-9_-]+)*$/i.test(base);
}

function getCacheMetadataPath(filePath) {
  return `${filePath}.meta.json`;
}

function getContentTypeMetadataFromMemory(filePath) {
  if (!contentTypeMetadataCache.has(filePath)) return undefined;
  const value = contentTypeMetadataCache.get(filePath);
  contentTypeMetadataCache.delete(filePath);
  contentTypeMetadataCache.set(filePath, value);
  return value;
}

function setContentTypeMetadataCache(filePath, contentType) {
  if (contentTypeMetadataCache.has(filePath)) {
    contentTypeMetadataCache.delete(filePath);
  }
  contentTypeMetadataCache.set(filePath, contentType);
  if (contentTypeMetadataCache.size > CONTENT_TYPE_CACHE_LIMIT) {
    const firstKey = contentTypeMetadataCache.keys().next().value;
    if (firstKey != null) {
      contentTypeMetadataCache.delete(firstKey);
    }
  }
}

async function readCachedContentType(filePath) {
  const memoryCached = getContentTypeMetadataFromMemory(filePath);
  if (memoryCached !== undefined) {
    return memoryCached;
  }
  try {
    const metadataPath = getCacheMetadataPath(filePath);
    const raw = await fs.promises.readFile(metadataPath, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const contentType = typeof parsed?.contentType === 'string' ? parsed.contentType.trim() : '';
    const normalized = contentType || null;
    setContentTypeMetadataCache(filePath, normalized);
    return normalized;
  } catch (_) {
    setContentTypeMetadataCache(filePath, null);
    return null;
  }
}

function writeCachedContentType(filePath, contentType) {
  const normalized = typeof contentType === 'string' ? contentType.trim() : '';
  if (!normalized) return;
  setContentTypeMetadataCache(filePath, normalized);
  fs.promises
    .writeFile(
      getCacheMetadataPath(filePath),
      `${JSON.stringify({ contentType: normalized }, null, 2)}\n`,
      'utf8'
    )
    .catch(error => {
      console.warn(`[Cache] Failed to persist cache metadata for ${filePath}: ${error?.message || error}`);
    });
}

function parseByteRangeHeader(rangeHeader, fileSize) {
  if (typeof rangeHeader !== 'string') return null;
  if (!Number.isInteger(fileSize) || fileSize <= 0) return null;
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;

  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return null;

  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    const boundedLength = Math.min(suffixLength, fileSize);
    return {
      start: Math.max(fileSize - boundedLength, 0),
      end: Math.max(fileSize - 1, 0),
    };
  }

  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0 || start >= fileSize) return null;

  if (!endRaw) {
    return {
      start,
      end: Math.max(fileSize - 1, start),
    };
  }

  const end = Number(endRaw);
  if (!Number.isInteger(end) || end < start) return null;
  return {
    start,
    end: Math.min(end, Math.max(fileSize - 1, start)),
  };
}

function maskProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return '';
  return proxyUrl.replace(/\/\/([^@/]+)@/, '//***@');
}

function appendVaryHeader(existingVary, token) {
  const values = [];
  const seen = new Set();

  const addToken = value => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(normalized);
  };

  if (typeof existingVary === 'string') {
    existingVary.split(',').forEach(addToken);
  }
  addToken(token);
  return values.join(', ');
}

module.exports = {
  setup: options => {
    setCacheRoot(options?.cacheFolder);
    ensureCacheFolders();

    const http = require('http');
    const https = require('https');

    const configuredProxyUrl =
      (options && typeof options.proxyUrl === 'string' && options.proxyUrl.trim()) ||
      (typeof anyGlobal.cacheProxyUrl === 'string' && anyGlobal.cacheProxyUrl.trim()) ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      null;

    let agent = new ProxyAgent({ keepAlive: true, maxFreeSockets: 12 });
    if (configuredProxyUrl) {
      try {
        agent = new ProxyAgent(configuredProxyUrl);
        console.log(`[Cache] Proxy enabled: ${maskProxyUrl(configuredProxyUrl)}`);
      } catch (error) {
        console.warn(`[Cache] Failed to initialize proxy agent: ${error?.message || error}`);
      }
    }

    const proxy = http.createServer(async (req, res) => {
      try {
        const requestOrigin =
          typeof req.headers.origin === 'string' && req.headers.origin.trim()
            ? req.headers.origin
            : '*';
        let resourceHost = null;
        let url = req.url ?? '';
        let clientAsset = false;
        let cacheFolderReady = true;
        let targetCacheFolder = cacheFolder;
        // check whether first part of req.url is resource
        if (url.startsWith('/resources/')) {
          resourceHost = anyGlobal.resourceHost ? new URL(anyGlobal.resourceHost) : null;
          url = url?.substring(10);
          targetCacheFolder = resourceCacheFolder;
        } else if (url.startsWith('/client/')) {
          resourceHost = anyGlobal.clientHost ? new URL(anyGlobal.clientHost) : null;
          url = url?.substring(7);
          clientAsset = true;
          if (resourceHost) {
            targetCacheFolder = path.join(
              clientCacheFolder,
              convertToValidFilename(resourceHost.host),
              anyGlobal.clientVersion || 'unknown'
            );
            if (!ensuredClientCacheFolders.has(targetCacheFolder)) {
              try {
                await fs.promises.mkdir(targetCacheFolder, { recursive: true });
                ensuredClientCacheFolders.add(targetCacheFolder);
              } catch (error) {
                cacheFolderReady = false;
                console.warn(
                  `[Cache WARN] Failed to ensure client cache folder ${targetCacheFolder}: ${error?.message || error}`
                );
              }
            }
          }
        }

        if (!resourceHost) {
          res.writeHead(404);
          res.end();
          return;
        }

        let protocol = resourceHost.protocol === 'https:' ? https : http;
        let port = resourceHost.port
          ? parseInt(resourceHost.port, 10)
          : resourceHost.protocol === 'https:'
            ? 443
            : 80;

        if (!url.startsWith('/')) {
          url = '/' + url;
        }

        const hostPath = resourceHost.pathname && resourceHost.pathname !== '/'
          ? resourceHost.pathname.replace(/\/+$/, '')
          : '';
        if (hostPath && !url.startsWith(hostPath + '/')) {
          url = hostPath + url;
        }

        const options = {
          host: resourceHost.hostname,
          port: port,
          path: url,
          method: req.method,
          headers: { ...req.headers, host: resourceHost.host },
          agent: agent,
        };
        if (resourceHost.hostname === 'localhost' || resourceHost.hostname === '127.0.0.1') {
          console.warn(`[Cache WARN] resourceHost points to localhost: ${resourceHost.href}`);
        }

        const filename = getCacheFilename(resourceHost?.host, url);
        const isGetRequest = String(req.method || '').toUpperCase() === 'GET';
        const isAsset = clientAsset || isHashedAssetPath(url);
        const shouldUseCache = isAsset && isGetRequest && cacheFolderReady;

        // create file write stream if it's an asset
        const filePath = path.join(targetCacheFolder, filename);

        let cachedFileStat = null;
        if (shouldUseCache) {
          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile()) {
              cachedFileStat = stat;
            }
          } catch (_) {
            cachedFileStat = null;
          }
        }

        if (cachedFileStat) {
          console.log(`[Cache HIT] ${filename}`);
          const contentType = (await readCachedContentType(filePath)) || mime.lookup(filePath) || 'binary/octet-stream';
          const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
          const range = rangeHeader ? parseByteRangeHeader(rangeHeader, cachedFileStat.size) : null;

          if (rangeHeader && !range) {
            res.writeHead(416, {
              'content-range': `bytes */${cachedFileStat.size}`,
              'access-control-allow-origin': requestOrigin,
              'access-control-allow-credentials': 'true',
              'access-control-allow-methods': '*',
              vary: appendVaryHeader('', 'Origin'),
              'accept-ranges': 'bytes',
            });
            res.end();
            return;
          }

          const responseHeaders = {
            'content-type': contentType,
            'access-control-allow-origin': requestOrigin,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': '*',
            vary: appendVaryHeader('', 'Origin'),
            'accept-ranges': 'bytes',
          };
          let statusCode = 200;
          let fileStreamOptions = undefined;
          if (range) {
            statusCode = 206;
            responseHeaders['content-range'] = `bytes ${range.start}-${range.end}/${cachedFileStat.size}`;
            responseHeaders['content-length'] = String(range.end - range.start + 1);
            fileStreamOptions = { start: range.start, end: range.end };
          } else {
            responseHeaders['content-length'] = String(cachedFileStat.size);
          }

          res.writeHead(statusCode, responseHeaders);
          const fileStream = fileStreamOptions
            ? fs.createReadStream(filePath, fileStreamOptions)
            : fs.createReadStream(filePath);
          fileStream.pipe(res);
          fileStream.on('error', e => {
            console.error(e);
            res.end();
          });

          req.on('error', e => {
            console.error(e);
          });

          res.on('close', () => {
            fileStream.destroy();
          });
          res.on('error', e => {
            console.error(e);
          });
          return;
        }

        if (shouldUseCache) {
          console.log(`[Cache MISS (Downloading)] ${filename}`);
        }

        const backend_req = protocol.request(options, async backend_res => {
          try {
            backend_res = decompressResponse(backend_res);
            const upstreamContentTypeHeader = backend_res.headers['content-type'];
            const upstreamContentType = Array.isArray(upstreamContentTypeHeader)
              ? upstreamContentTypeHeader[0]
              : upstreamContentTypeHeader;

            delete backend_res.headers['content-length'];
            delete backend_res.headers['transfer-encoding'];
            backend_res.headers['access-control-allow-origin'] = requestOrigin;
            backend_res.headers['access-control-allow-credentials'] = 'true';
            backend_res.headers['access-control-allow-methods'] = '*';
            backend_res.headers.vary = appendVaryHeader(
              backend_res.headers.vary || backend_res.headers.Vary,
              'Origin'
            );
            delete backend_res.headers.Vary;

            res.writeHead(backend_res.statusCode || 500, backend_res.headers);

            const isSuccessful = backend_res.statusCode == 200;
            const tmpFilePath = filePath + '.tmp';
            const fileStream = isSuccessful && shouldUseCache ? createWriteStream(tmpFilePath) : null;
            if (fileStream && fileStream.writable) {
              backend_res.pipe(fileStream);
            }
            backend_res.pipe(res);

            backend_res.on('error', e => {
              console.error(e);
              res.end();
              fileStream?.destroy();
            });

            fileStream?.on('finish', () => {
              fs.rename(tmpFilePath, filePath, renameError => {
                if (renameError) {
                  console.error(renameError);
                  return;
                }
                writeCachedContentType(filePath, upstreamContentType);
              });
            });

            fileStream?.on('close', () => {
              finishWriteStream(tmpFilePath);
            });

            fileStream?.on('error', e => {
              console.error(`[Cache WARN] failed to write cache file ${tmpFilePath}`);
              console.error(e);
              finishWriteStream(tmpFilePath);
              fs.promises.unlink(tmpFilePath).catch(() => { });
            });
          } catch (e) {
            console.error(`[Cache ERROR] response handling failed for ${resourceHost.protocol}//${resourceHost.host}${url}`);
            console.error(e);
            if (!res.headersSent) {
              res.writeHead(502);
            }
            if (!res.writableEnded) {
              res.end();
            }
          }
        });

        backend_req.on('error', e => {
          console.error(`[Cache ERROR] upstream=${resourceHost.protocol}//${resourceHost.host}${url}`);
          console.error(e);
          if (!res.headersSent) {
            res.writeHead(502);
          }
          res.end();
        });
        req.pipe(backend_req);
        req.on('error', e => {
          console.error(e);
          backend_req.destroy();
        });
        res.on('close', () => {
          backend_req.destroy();
        });
        res.on('error', e => {
          backend_req.destroy();
        });
      } catch (e) {
        console.error('[Cache ERROR] proxy request handling failed');
        console.error(e);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        if (!res.writableEnded) {
          res.end();
        }
      }
    });

    server = proxy.listen(0, 'localhost', () => {
      anyGlobal.resourceProxyPort = server.address().port;
    });
  },
  dispose: () => {
    server?.close();
  },
  getResourceCacheFolder: () => resourceCacheFolder,
};
