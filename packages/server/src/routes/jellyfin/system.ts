import { Router, type Request, type Response } from 'express';
import {
  config as appConfig,
  createLogger,
  encryptString,
  isConfigUuid,
  resolveConfigAlias,
  UserRepository,
  uuidToJellyfinUserId,
  JellyfinRepository,
} from '@aiostreams/core';
import {
  JELLYFIN_PRODUCT_NAME,
  JELLYFIN_SERVER_VERSION,
  jf,
  mintToken,
  parseMediaBrowserHeader,
  requestOrigin,
  resolveUserData,
  serverIdFor,
  type JellyfinRequestContext,
  param,
} from './context.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

const serverName = () => appConfig.branding.addonName || 'AIOStreams';

function publicInfo(req: Request) {
  const ctx = req.jf;
  return {
    LocalAddress: `${requestOrigin(req)}${req.baseUrl}`,
    ServerName: ctx?.userData.addonName || serverName(),
    Version: JELLYFIN_SERVER_VERSION,
    ProductName: JELLYFIN_PRODUCT_NAME,
    OperatingSystem: 'Linux',
    Id: ctx?.serverId ?? 'aiostreams00000000000000000000000',
    StartupWizardCompleted: true,
  };
}

router.get('/System/Info/Public', (req, res) => {
  res.json(publicInfo(req));
});

router.get(
  '/System/Info',
  jf(async (req, res, ctx) => {
    res.json({
      ...publicInfo(req),
      SystemArchitecture: 'X64',
      OperatingSystemDisplayName: 'Linux',
      HasPendingRestart: false,
      IsShuttingDown: false,
      SupportsLibraryMonitor: false,
      WebSocketPortNumber: appConfig.bootstrap.port,
      CompletedInstallations: [],
      CanSelfRestart: false,
      CanLaunchWebBrowser: false,
      ProgramDataPath: '/config',
      WebPath: '/web',
      ItemsByNamePath: '/config/metadata',
      CachePath: '/cache',
      LogPath: '/config/log',
      InternalMetadataPath: '/config/metadata',
      TranscodingTempPath: '/cache/transcodes',
      HasUpdateAvailable: false,
      EncoderLocation: 'NotFound',
      PackageName: 'aiostreams',
      LocalAddress: `${requestOrigin(req)}${req.baseUrl}`,
      ServerName: ctx.userData.addonName || serverName(),
    });
  })
);

router.all('/System/Ping', (_req, res) => {
  res.json(JELLYFIN_PRODUCT_NAME);
});

router.get('/System/Endpoint', (req, res) => {
  res.json({ IsLocal: false, IsInNetwork: false });
});

router.get(
  '/System/Configuration',
  jf(async (_req, res) => {
    res.json({
      EnableMetrics: false,
      ServerName: serverName(),
      PreferredMetadataLanguage: 'en',
      MetadataCountryCode: 'US',
      EnableCaseSensitiveItemIds: true,
      EnableFolderView: false,
      EnableGroupingIntoCollections: false,
      DisplaySpecialsWithinSeasons: true,
      UICulture: 'en-US',
      SaveMetadataHidden: false,
      ContentTypes: [],
      RemoteClientBitrateLimit: 0,
      EnableSlowResponseWarning: false,
      LibraryScanFanoutConcurrency: 0,
      LibraryMetadataRefreshConcurrency: 0,
      PluginRepositories: [],
      CorsHosts: ['*'],
      IsStartupWizardCompleted: true,
    });
  })
);

router.get('/Branding/Configuration', (_req, res) => {
  res.json({
    LoginDisclaimer: `Sign in with your ${serverName()} config UUID and password.`,
    CustomCss: '',
    SplashscreenEnabled: false,
  });
});
router.get(['/Branding/Css', '/Branding/Css.css'], (_req, res) => {
  res.type('text/css').send('');
});
router.get('/Branding/Splashscreen', (_req, res) => {
  res.redirect(302, '/logo.png');
});

function userDto(
  ctx: Pick<JellyfinRequestContext, 'uuid' | 'userData' | 'serverId'>
) {
  const userId = uuidToJellyfinUserId(ctx.uuid);
  return {
    Name: ctx.userData.addonName || serverName(),
    ServerId: ctx.serverId,
    Id: userId,
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: true,
    LastLoginDate: new Date().toISOString(),
    LastActivityDate: new Date().toISOString(),
    Configuration: userConfiguration(),
    Policy: userPolicy(),
  };
}

function userConfiguration() {
  return {
    PlayDefaultAudioTrack: true,
    SubtitleLanguagePreference: '',
    DisplayMissingEpisodes: false,
    GroupedFolders: [],
    SubtitleMode: 'Default',
    DisplayCollectionsView: false,
    EnableLocalPassword: false,
    OrderedViews: [],
    LatestItemsExcludes: [],
    MyMediaExcludes: [],
    HidePlayedInLatest: true,
    RememberAudioSelections: true,
    RememberSubtitleSelections: true,
    EnableNextEpisodeAutoPlay: true,
    CastReceiverId: '',
  };
}

function userPolicy() {
  return {
    IsAdministrator: false,
    IsHidden: false,
    EnableCollectionManagement: false,
    EnableSubtitleManagement: false,
    EnableLyricManagement: false,
    IsDisabled: false,
    BlockedTags: [],
    AllowedTags: [],
    EnableUserPreferenceAccess: true,
    AccessSchedules: [],
    BlockUnratedItems: [],
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableRemoteAccess: true,
    EnableLiveTvManagement: false,
    EnableLiveTvAccess: false,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: false,
    EnableVideoPlaybackTranscoding: false,
    EnablePlaybackRemuxing: false,
    ForceRemoteSourceTranscoding: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: true,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnabledDevices: [],
    EnableAllDevices: true,
    EnabledChannels: [],
    EnableAllChannels: true,
    EnabledFolders: [],
    EnableAllFolders: true,
    InvalidLoginAttemptCount: 0,
    LoginAttemptsBeforeLockout: -1,
    MaxActiveSessions: 0,
    EnablePublicSharing: false,
    BlockedMediaFolders: [],
    BlockedChannels: [],
    RemoteClientBitrateLimit: 0,
    AuthenticationProviderId:
      'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
    PasswordResetProviderId:
      'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
    SyncPlayAccess: 'None',
  };
}

function sessionInfo(ctx: JellyfinRequestContext, req: Request) {
  const mb = parseMediaBrowserHeader(
    req.get('authorization') ?? req.get('x-emby-authorization')
  );
  return {
    PlayState: {
      CanSeek: true,
      IsPaused: false,
      IsMuted: false,
      RepeatMode: 'RepeatNone',
      PlaybackOrder: 'Default',
    },
    AdditionalUsers: [],
    Capabilities: {
      PlayableMediaTypes: ['Video'],
      SupportedCommands: [],
      SupportsMediaControl: false,
      SupportsPersistentIdentifier: false,
    },
    RemoteEndPoint: req.userIp ?? '',
    PlayableMediaTypes: ['Video'],
    Id: `${ctx.userId}-${mb.deviceid ?? 'device'}`,
    UserId: ctx.userId,
    UserName: ctx.userData.addonName || serverName(),
    Client: mb.client ?? 'Unknown',
    LastActivityDate: new Date().toISOString(),
    LastPlaybackCheckIn: new Date(0).toISOString(),
    DeviceName: mb.device ?? 'Unknown',
    DeviceId: mb.deviceid ?? 'unknown',
    ApplicationVersion: mb.version ?? '0',
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    HasCustomDeviceName: false,
    ServerId: ctx.serverId,
    SupportedCommands: [],
  };
}

router.get('/Users/Public', (req, res) => {
  if (req.jf?.preAuthenticated) {
    res.json([userDto(req.jf)]);
    return;
  }
  res.json([]);
});

router.post('/Users/AuthenticateByName', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = String(body.Username ?? body.username ?? '').trim();
    const pw = String(
      body.Pw ?? body.pw ?? body.Password ?? body.password ?? ''
    );
    const mb = parseMediaBrowserHeader(
      req.get('authorization') ?? req.get('x-emby-authorization')
    );

    let uuid: string | undefined;
    let encryptedPassword: string | undefined;

    if (req.jf?.preAuthenticated) {
      uuid = req.jf.uuid;
      encryptedPassword = req.jf.encryptedPassword;
    } else {
      if (!username) {
        res
          .status(401)
          .json({ Message: 'Username (config UUID or alias) is required' });
        return;
      }
      let candidate = username;
      if (!isConfigUuid(candidate)) {
        const alias = await resolveConfigAlias(candidate);
        if (!alias) {
          res.status(401).json({ Message: 'Unknown user' });
          return;
        }
        candidate = alias.uuid;
        uuid = candidate;
        encryptedPassword = alias.encryptedPassword;
      } else {
        const enc = encryptString(pw);
        if (!enc.success || !enc.data) {
          res.status(500).json({ Message: 'Encryption failure' });
          return;
        }
        uuid = candidate;
        encryptedPassword = enc.data;
      }
    }

    const resolved = await resolveUserData(
      uuid!,
      encryptedPassword!,
      req.userIp
    );
    if (!resolved) {
      res.status(401).json({ Message: 'Invalid username or password' });
      return;
    }
    const token = mintToken({
      u: resolved.uuid,
      p: encryptedPassword!,
      d: mb.deviceid,
    });
    const ctx = {
      uuid: resolved.uuid,
      userData: resolved.userData,
      serverId: serverIdFor(resolved.uuid),
      userId: uuidToJellyfinUserId(resolved.uuid),
    } as JellyfinRequestContext;
    logger.info(
      { uuid: resolved.uuid, client: mb.client, device: mb.device },
      'jellyfin client authenticated'
    );
    res.json({
      User: userDto(ctx),
      SessionInfo: sessionInfo(ctx, req),
      AccessToken: token,
      ServerId: ctx.serverId,
    });
  } catch (error) {
    logger.error(
      `authenticate failed: ${error instanceof Error ? error.message : error}`
    );
    res.status(500).json({ Message: 'Authentication failed' });
  }
});

router.post('/Users/AuthenticateWithQuickConnect', (_req, res) => {
  res.status(401).json({ Message: 'Quick Connect is not available' });
});
router.get('/QuickConnect/Enabled', (_req, res) => {
  res.json(false);
});
router.all(
  [
    '/QuickConnect/Initiate',
    '/QuickConnect/Connect',
    '/QuickConnect/Authorize',
  ],
  (_req, res) => {
    res.status(401).json({ Message: 'Quick Connect is not available' });
  }
);

router.post('/Sessions/Logout', (_req, res) => {
  res.status(204).end();
});

router.get(
  '/Users/Me',
  jf(async (_req, res, ctx) => {
    res.json(userDto(ctx));
  })
);
router.get(
  '/Users',
  jf(async (_req, res, ctx) => {
    res.json([userDto(ctx)]);
  })
);
router.get(
  '/Users/:userId',
  jf(async (_req, res, ctx) => {
    res.json(userDto(ctx));
  })
);
router.get(
  '/Users/:userId/Configuration',
  jf(async (_req, res) => {
    res.json(userConfiguration());
  })
);
router.post(
  ['/Users/:userId/Configuration', '/Users/Configuration'],
  jf(async (_req, res) => {
    res.status(204).end();
  })
);
router.post(
  [
    '/Users/:userId/Policy',
    '/Users/:userId/Password',
    '/Users/:userId/EasyPassword',
  ],
  jf(async (_req, res) => {
    res.status(204).end();
  })
);

router.get(
  '/Sessions',
  jf(async (req, res, ctx) => {
    res.json([sessionInfo(ctx, req)]);
  })
);
router.post(
  ['/Sessions/Capabilities', '/Sessions/Capabilities/Full'],
  jf(async (_req, res) => {
    res.status(204).end();
  })
);
router.post(
  '/Sessions/Viewing',
  jf(async (_req, res) => {
    res.status(204).end();
  })
);
router.all(
  '/Sessions/:sessionId/{*rest}',
  (req, _res, next) =>
    /^playing$/i.test(String(req.params.sessionId)) ? next('route') : next(),
  jf(async (_req, res) => {
    res.status(204).end();
  })
);
router.get(
  '/Devices',
  jf(async (req, res, ctx) => {
    res.json({
      Items: [
        {
          Name: ctx.client.device,
          Id: ctx.client.deviceId,
          LastUserName: ctx.userData.addonName || serverName(),
          AppName: ctx.client.name,
          AppVersion: ctx.client.version,
          LastUserId: ctx.userId,
          DateLastActivity: new Date().toISOString(),
        },
      ],
      TotalRecordCount: 1,
      StartIndex: 0,
    });
  })
);
router.get(
  '/Devices/Info',
  jf(async (_req, res, ctx) => {
    res.json({
      Name: ctx.client.device,
      Id: ctx.client.deviceId,
      AppName: ctx.client.name,
      AppVersion: ctx.client.version,
    });
  })
);
router.get(
  '/Devices/Options',
  jf(async (_req, res) => {
    res.json({ CustomName: null });
  })
);
router.post(
  '/Devices/Options',
  jf(async (_req, res) => {
    res.status(204).end();
  })
);

const DEFAULT_DISPLAY_PREFS = (id: string, client: string) => ({
  Id: id,
  ViewType: null,
  SortBy: 'SortName',
  IndexBy: null,
  RememberIndexing: false,
  PrimaryImageHeight: 250,
  PrimaryImageWidth: 250,
  CustomPrefs: {},
  ScrollDirection: 'Horizontal',
  ShowBackdrop: true,
  RememberSorting: false,
  SortOrder: 'Ascending',
  ShowSidebar: false,
  Client: client,
});

router.get(
  '/DisplayPreferences/:id',
  jf(async (req, res, ctx) => {
    const client =
      (typeof req.query.client === 'string' ? req.query.client : 'emby') ||
      'emby';
    const stored = await JellyfinRepository.getDisplayPrefs(
      ctx.uuid,
      param(req, 'id'),
      client
    );
    res.json({
      ...DEFAULT_DISPLAY_PREFS(param(req, 'id'), client),
      ...(stored ?? {}),
    });
  })
);
router.post(
  '/DisplayPreferences/:id',
  jf(async (req, res, ctx) => {
    const client =
      (typeof req.query.client === 'string' ? req.query.client : 'emby') ||
      'emby';
    const body = (
      req.body && typeof req.body === 'object' ? req.body : {}
    ) as Record<string, unknown>;
    await JellyfinRepository.setDisplayPrefs(
      ctx.uuid,
      param(req, 'id'),
      client,
      body
    );
    res.status(204).end();
  })
);

router.get('/Localization/Cultures', (_req, res) => {
  res.json([
    {
      Name: 'English',
      DisplayName: 'English',
      TwoLetterISOLanguageName: 'en',
      ThreeLetterISOLanguageName: 'eng',
      ThreeLetterISOLanguageNames: ['eng'],
    },
  ]);
});
router.get('/Localization/Countries', (_req, res) => {
  res.json([
    {
      Name: 'US',
      DisplayName: 'United States',
      TwoLetterISORegionName: 'US',
      ThreeLetterISORegionName: 'USA',
    },
  ]);
});
router.get('/Localization/Options', (_req, res) => {
  res.json([{ Name: 'English (United States)', Value: 'en-US' }]);
});
router.get('/Localization/ParentalRatings', (_req, res) => {
  res.json([]);
});

for (const p of [
  '/Plugins',
  '/ScheduledTasks',
  '/Packages',
  '/Repositories',
  '/Notifications/Types',
  '/Notifications/Services',
  '/System/ActivityLog/Entries',
  '/Auth/Keys',
  '/Auth/PasswordResetProviders',
  '/Auth/Providers',
  '/Environment/Drives',
  '/Environment/NetworkShares',
  '/Library/PhysicalPaths',
  '/Sessions/SyncPlay/List',
  '/SyncPlay/List',
  '/LiveTv/Programs',
  '/LiveTv/Recordings',
  '/LiveTv/Timers',
  '/LiveTv/SeriesTimers',
  '/LiveTv/Channels',
  '/LiveTv/Programs/Recommended',
  '/Channels',
  '/Playlists',
  '/Collections',
  '/Studios',
  '/Artists',
  '/Artists/AlbumArtists',
  '/Years',
  '/Persons',
  '/Trailers',
  '/Audio/Genres',
  '/MusicGenres',
  '/Items/Intros',
  '/Users/:userId/Items/Intros',
]) {
  router.get(p, (_req, res) => {
    if (
      /Items|Channels|Playlists|Collections|Studios|Artists|Years|Persons|Trailers|Genres|Programs|Recordings|Timers|Intros|Entries/.test(
        p
      )
    ) {
      res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    } else {
      res.json([]);
    }
  });
}
router.get('/LiveTv/Info', (_req, res) => {
  res.json({ Services: [], IsEnabled: false, EnabledUsers: [] });
});
router.get('/LiveTv/GuideInfo', (_req, res) => {
  res.json({
    StartDate: new Date().toISOString(),
    EndDate: new Date().toISOString(),
  });
});
router.get('/Notifications/:userId/Summary', (_req, res) => {
  res.json({ UnreadCount: 0, MaxUnreadNotificationLevel: 'Normal' });
});
router.get('/Notifications/:userId', (_req, res) => {
  res.json({ Notifications: [], TotalRecordCount: 0 });
});
router.get('/Playback/BitrateTest', (req, res) => {
  const size = Math.min(
    Number(req.query.Size ?? req.query.size ?? 102400) || 102400,
    10 * 1024 * 1024
  );
  res.type('application/octet-stream').send(Buffer.alloc(size));
});
router.get('/Startup/{*rest}', (_req, res) => {
  res.json({});
});
router.post('/Startup/{*rest}', (_req, res) => {
  res.status(204).end();
});
router.post(['/Items/:itemId/Refresh', '/Library/Refresh'], (_req, res) => {
  res.status(204).end();
});
router.get('/ClientLog/Document', (_req, res) => {
  res.status(204).end();
});
router.post('/ClientLog/Document', (_req, res) => {
  res.json({ FileName: 'client.log' });
});

export default router;
