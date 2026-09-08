import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  APIError,
  config as appConfig,
  constants,
  createLogger,
  decryptString,
  encryptString,
  isConfigUuid,
  isEncrypted,
  resolveConfigAlias,
  UserRepository,
  validateConfig,
  JellyfinRepository,
  JellyfinService,
  uuidToJellyfinUserId,
  type UserData,
  type ItemBuildContext,
} from '@aiostreams/core';
import { syncUserDataUrls } from '../../utils/syncUserData.js';

const logger = createLogger('jellyfin');

export const JELLYFIN_SERVER_VERSION = '10.10.7';
export const JELLYFIN_PRODUCT_NAME = 'Jellyfin Server';

export interface JellyfinRequestContext {
  uuid: string;
  encryptedPassword: string;
  userData: UserData;
  userId: string;
  serverId: string;
  service: JellyfinService;
  build: ItemBuildContext;
  baseUrl: string;
  apiKey: string;
  client: { name: string; device: string; deviceId: string; version: string };
  preAuthenticated: boolean;
}

export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export interface TokenPayload {
  u: string;
  p: string;
  d?: string;
}

export function mintToken(payload: TokenPayload): string {
  const res = encryptString(JSON.stringify(payload));
  if (!res.success || !res.data) throw new Error('Failed to create token');
  return res.data;
}

export function readToken(token: string): TokenPayload | null {
  const res = decryptString(token);
  if (!res.success || !res.data) return null;
  try {
    const parsed = JSON.parse(res.data);
    if (parsed && typeof parsed.u === 'string' && typeof parsed.p === 'string')
      return parsed;
  } catch {}
  return null;
}

export function parseMediaBrowserHeader(
  value: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  const body = value.replace(/^(MediaBrowser|Emby)\s+/i, '');
  const re = /([A-Za-z]+)\s*=\s*"([^"]*)"|([A-Za-z]+)\s*=\s*([^,\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const k = (m[1] ?? m[3]).toLowerCase();
    const v = m[2] ?? m[4] ?? '';
    out[k] = v;
  }
  return out;
}

export function serverIdFor(uuid: string): string {
  return uuidToJellyfinUserId(uuid);
}

export function requestOrigin(req: Request): string {
  const host = req.get('x-forwarded-host') || req.get('host');
  if (host) {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'http')
      .split(',')[0]
      .trim();
    return `${proto}://${host}`;
  }
  if (appConfig.bootstrap.baseUrl)
    return appConfig.bootstrap.baseUrl.replace(/\/$/, '');
  return `http://localhost:${appConfig.bootstrap.port}`;
}

async function loadVerifiedUser(
  uuidOrAlias: string,
  encryptedPassword: string
): Promise<{ uuid: string; userData: UserData } | null> {
  let uuid = uuidOrAlias;
  if (!isConfigUuid(uuidOrAlias)) {
    const alias = await resolveConfigAlias(uuidOrAlias);
    if (!alias) return null;
    uuid = alias.uuid;
  }
  if (!(await UserRepository.checkUserExists(uuid))) return null;
  const dec = decryptString(encryptedPassword);
  if (!dec.success || dec.data == null) return null;
  try {
    const userData = await UserRepository.getUser(uuid, dec.data);
    if (!userData) return null;
    return { uuid, userData };
  } catch (error) {
    if (
      error instanceof APIError &&
      error.code === constants.ErrorCode.USER_INVALID_DETAILS
    ) {
      return null;
    }
    throw error;
  }
}

export async function verifyCredentials(
  uuidOrAlias: string,
  encryptedPassword: string
): Promise<string | null> {
  let uuid = uuidOrAlias;
  if (!isConfigUuid(uuidOrAlias)) {
    const alias = await resolveConfigAlias(uuidOrAlias);
    if (!alias) return null;
    uuid = alias.uuid;
  }
  const dec = decryptString(encryptedPassword);
  if (!dec.success || dec.data == null) return null;
  return (await UserRepository.verifyCredentials(uuid, dec.data)) ? uuid : null;
}

interface CachedUser {
  uuid: string;
  parentUuid?: string;
  version: string;
  userData: UserData;
  at: number;
  service?: JellyfinService;
}
const userCache = new Map<string, CachedUser>();
const userInFlight = new Map<string, Promise<CachedUser | null>>();
const USER_CACHE_MAX = 5_000;
const USER_CACHE_TTL_MS = 5 * 60_000;

function versionFor(
  versions: Map<string, string>,
  uuid: string,
  parentUuid?: string
): string {
  const own = versions.get(uuid);
  if (own == null) return '';
  return parentUuid ? `${own}|${versions.get(parentUuid) ?? ''}` : own;
}

async function resolveUuid(uuidOrAlias: string): Promise<string | null> {
  if (isConfigUuid(uuidOrAlias)) return uuidOrAlias;
  const alias = await resolveConfigAlias(uuidOrAlias);
  return alias?.uuid ?? null;
}

async function getOrBuildCachedUser(
  uuidOrAlias: string,
  encryptedPassword: string
): Promise<CachedUser | null> {
  const uuid = await resolveUuid(uuidOrAlias);
  if (!uuid) return null;
  const key = `${uuid}|${encryptedPassword}`;

  let entry = await freshCachedUser(key);
  if (!entry) {
    let inFlight = userInFlight.get(key);
    if (!inFlight) {
      inFlight = buildCachedUser(uuid, encryptedPassword).finally(() =>
        userInFlight.delete(key)
      );
      userInFlight.set(key, inFlight);
    }
    entry = await inFlight;
    if (!entry) return null;
  }
  return entry;
}

export async function resolveUserData(
  uuidOrAlias: string,
  encryptedPassword: string,
  ip?: string
): Promise<{ uuid: string; userData: UserData } | null> {
  const entry = await getOrBuildCachedUser(uuidOrAlias, encryptedPassword);
  if (!entry) return null;
  const userData = structuredClone(entry.userData);
  userData.ip = ip;
  return { uuid: entry.uuid, userData };
}

/**
 * Returns the cached user entry itself (not a per-request clone), so callers
 * that need to reuse or attach state (e.g. a JellyfinService instance) can do
 * so keyed identically to the user cache (`uuid|encryptedPassword`), and have
 * it evicted automatically alongside the CachedUser entry.
 */
export async function getCachedUserEntry(
  uuidOrAlias: string,
  encryptedPassword: string
): Promise<CachedUser | null> {
  return getOrBuildCachedUser(uuidOrAlias, encryptedPassword);
}

async function freshCachedUser(key: string): Promise<CachedUser | null> {
  const cached = userCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.at < USER_CACHE_TTL_MS) {
    const versions = await JellyfinRepository.userVersions([
      cached.uuid,
      cached.parentUuid ?? '',
    ]);
    if (
      versionFor(versions, cached.uuid, cached.parentUuid) === cached.version
    ) {
      return cached;
    }
  }
  userCache.delete(key);
  return null;
}

async function buildCachedUser(
  uuid: string,
  encryptedPassword: string
): Promise<CachedUser | null> {
  const now = Date.now();
  const preVersions = await JellyfinRepository.userVersions([uuid]);
  const verified = await loadVerifiedUser(uuid, encryptedPassword);
  if (!verified) return null;
  let userData = verified.userData;
  userData.encryptedPassword = encryptedPassword;
  userData.uuid = verified.uuid;
  userData.ip = undefined;
  userData = await syncUserDataUrls(userData);
  userData = await validateConfig(userData, {
    skipErrorsFromAddonsOrProxies: true,
    decryptValues: true,
  });

  const parentUuid = verified.userData.parentConfig?.uuid || undefined;
  const versions = parentUuid
    ? await JellyfinRepository.userVersions([parentUuid])
    : new Map<string, string>();
  versions.set(uuid, preVersions.get(uuid) ?? '');

  const entry: CachedUser = {
    uuid: verified.uuid,
    parentUuid,
    version: versionFor(versions, uuid, parentUuid),
    userData,
    at: now,
  };
  const key = `${uuid}|${encryptedPassword}`;
  if (userCache.size >= USER_CACHE_MAX) {
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
  userCache.set(key, entry);
  return entry;
}

function sendUnauthorized(res: Response, message = 'Unauthorized') {
  res.status(401).json({ Message: message });
}

const PUBLIC = [
  /^\/system\/info\/public$/i,
  /^\/system\/ping$/i,
  /^\/users\/authenticatebyname$/i,
  /^\/users\/public$/i,
  /^\/branding\/(configuration|css|css\.css)$/i,
  /^\/quickconnect\/enabled$/i,
  /^\/quickconnect\/initiate$/i,
  /^\/quickconnect\/connect$/i,
  /^\/quickconnect\/authorize$/i,
  /^\/startup\//i,
  /^\/system\/endpoint$/i,
  /^\/items\/[^/]+\/images(\/|$)/i,
  /^\/userimage$/i,
];

/**
 * Subset of PUBLIC reused by the rate-limiter classifier for genuinely
 * unauthenticated, cheap, non-Jellyfin-API traffic (System/Info/Public,
 * Branding/*, QuickConnect/*). Excludes AuthenticateByName (handled by
 * loginRateLimiter) and image paths (handled by jellyfinRateLimiter).
 */
export const PUBLIC_STATIC_LIKE = [
  /^\/system\/info\/public$/i,
  /^\/system\/ping$/i,
  /^\/users\/public$/i,
  /^\/branding\/(configuration|css|css\.css)$/i,
  /^\/quickconnect\/enabled$/i,
  /^\/quickconnect\/initiate$/i,
  /^\/quickconnect\/connect$/i,
  /^\/quickconnect\/authorize$/i,
  /^\/startup\//i,
  /^\/system\/endpoint$/i,
];

const LAZY_CONTEXT_PATHS = [/^\/items\/[^/]+\/images(\/|$)/i];

async function buildContext(
  req: Request,
  uuid: string,
  encryptedPassword: string,
  mb: Record<string, string>,
  reusableToken: string | undefined,
  preAuthenticated: boolean
): Promise<JellyfinRequestContext | null> {
  const entry = await getCachedUserEntry(uuid, encryptedPassword);
  if (!entry) return null;
  // Per-request clone carries the caller's IP; the service is built from the
  // cached (clone-source) userData below so it never captures a request IP.
  const userData = structuredClone(entry.userData);
  userData.ip = req.userIp;
  if (!entry.service) {
    entry.service = new JellyfinService(entry.userData);
  }
  const baseUrl = `${requestOrigin(req)}${req.baseUrl}`.replace(/\/$/, '');
  const apiKey =
    reusableToken ??
    mintToken({ u: entry.uuid, p: encryptedPassword, d: mb.deviceid });
  const serverId = serverIdFor(entry.uuid);
  return {
    uuid: entry.uuid,
    encryptedPassword,
    userData,
    userId: uuidToJellyfinUserId(entry.uuid),
    serverId,
    service: entry.service,
    build: { uuid: entry.uuid, serverId },
    baseUrl,
    apiKey,
    client: {
      name: mb.client || 'Unknown',
      device: mb.device || 'Unknown',
      deviceId: mb.deviceid || 'unknown',
      version: mb.version || '0',
    },
    preAuthenticated,
  };
}

export const jellyfinContext: RequestHandler = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string | undefined>;
    const pathUuid = params.uuid;
    const pathPassword = params.encryptedPassword;

    const mb = parseMediaBrowserHeader(
      req.get('authorization') ?? req.get('x-emby-authorization')
    );
    const token =
      mb.token ||
      req.get('x-emby-token') ||
      req.get('x-mediabrowser-token') ||
      (typeof req.query.api_key === 'string' ? req.query.api_key : undefined) ||
      (typeof req.query.ApiKey === 'string' ? req.query.ApiKey : undefined);

    let uuid: string | undefined;
    let encryptedPassword: string | undefined;
    let preAuthenticated = false;
    let tokenPayload: TokenPayload | null = null;

    if (token) tokenPayload = readToken(token);

    if (pathUuid && pathPassword) {
      if (!isEncrypted(pathPassword)) {
        next('router');
        return;
      }
      uuid = pathUuid;
      encryptedPassword = pathPassword;
      preAuthenticated = true;
    } else if (tokenPayload) {
      uuid = tokenPayload.u;
      encryptedPassword = tokenPayload.p;
    }

    const isPublic = PUBLIC.some((re) => re.test(req.path));
    if (!uuid || !encryptedPassword) {
      if (isPublic) {
        next();
        return;
      }
      sendUnauthorized(res);
      return;
    }

    const authedUuid = uuid;
    const authedPassword = encryptedPassword;
    const makeContext = () =>
      buildContext(
        req,
        authedUuid,
        authedPassword,
        mb,
        tokenPayload ? token : undefined,
        preAuthenticated
      );

    if (LAZY_CONTEXT_PATHS.some((re) => re.test(req.path))) {
      const verifiedUuid = await verifyCredentials(authedUuid, authedPassword);
      if (!verifiedUuid) {
        if (isPublic) {
          next();
          return;
        }
        sendUnauthorized(res, 'Invalid credentials');
        return;
      }
      req.uuid = verifiedUuid;
      let inFlight: Promise<JellyfinRequestContext | null> | null = null;
      req.jfLazy = () => (inFlight ??= makeContext());
      next();
      return;
    }

    const ctx = await makeContext();
    if (!ctx) {
      if (isPublic) {
        next();
        return;
      }
      sendUnauthorized(res, 'Invalid credentials');
      return;
    }

    req.jf = ctx;
    req.userData = ctx.userData;
    req.uuid = ctx.uuid;
    next();
  } catch (error) {
    logger.error(
      `jellyfin context error: ${error instanceof Error ? error.message : error}`
    );
    res.status(500).json({ Message: 'Internal error' });
  }
};

export function requireContext(
  req: Request,
  res: Response
): JellyfinRequestContext | null {
  if (!req.jf) {
    sendUnauthorized(res);
    return null;
  }
  return req.jf;
}

export function jf(
  handler: (
    req: Request,
    res: Response,
    ctx: JellyfinRequestContext
  ) => Promise<void> | void
): RequestHandler {
  return async (req, res, next: NextFunction) => {
    if (!req.jf && req.jfLazy) {
      try {
        req.jf = (await req.jfLazy()) ?? undefined;
        if (req.jf) req.userData = req.jf.userData;
      } catch (error) {
        logger.error(
          {
            path: req.originalUrl,
            err: error instanceof Error ? error.message : String(error),
          },
          'jellyfin context hydration failed'
        );
        res.status(500).json({ Message: 'Internal error' });
        return;
      }
    }
    const ctx = requireContext(req, res);
    if (!ctx) return;
    try {
      await handler(req, res, ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        { path: req.originalUrl, err: msg },
        'jellyfin handler failed'
      );
      if (!res.headersSent) res.status(500).json({ Message: 'Internal server error' });
      else if (!res.writableEnded) res.end();
    }
  };
}

export function qs(req: Request, name: string): string | undefined {
  const direct = req.query[name];
  if (typeof direct === 'string') return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(req.query)) {
    if (k.toLowerCase() === lower && typeof v === 'string') return v;
  }
  return undefined;
}

export function qi(req: Request, name: string, fallback: number): number {
  const v = qs(req, name);
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function qb(req: Request, name: string): boolean | undefined {
  const v = qs(req, name);
  if (v == null) return undefined;
  const lower = v.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  return undefined;
}

export function qlist(req: Request, name: string): string[] {
  const v = qs(req, name);
  if (!v) return [];
  return v
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
