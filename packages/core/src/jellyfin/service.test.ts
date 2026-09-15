import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// The core barrel (packages/core/src/index.ts) is imported once by
// packages/core/test/setup.ts before any test file runs, resolving the
// pre-existing config <-> tasks <-> logger circular dependency the same
// way production does (packages/server/src/app.ts pulls it in first).
import type { ParsedStream, Subtitle, UserData } from '../db/schemas.js';
import { JellyfinService } from './service.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeStream(): ParsedStream {
  return {
    id: 's-memo-1',
    url: 'https://torrentio.strem.fun/stream/movie/tt-memo.json',
    originalName: '1080p BluRay',
    originalDescription: 'Some Release',
    addon: { name: 'Bento', formatPassthrough: false },
  } as unknown as ParsedStream;
}

function fakeSubtitle(): Subtitle {
  return {
    id: 'sub-memo-1',
    url: 'https://example.com/sub.srt',
    lang: 'eng',
  } as unknown as Subtitle;
}

describe('JellyfinService.resolveStreams — subtitle-independent scrape memo', () => {
  it('shares one scrape across withSubtitles:false then withSubtitles:true for the same (type, videoId)', async () => {
    const svc = new JellyfinService({} as unknown as UserData);

    const fakeEngine = {
      getStreams: mock.fn(async () => ({
        data: { streams: [fakeStream()] },
        errors: [],
      })),
      getStreamContext: mock.fn(() => null),
      getSubtitles: mock.fn(async () => ({
        data: [fakeSubtitle()],
      })),
    };

    (svc as unknown as { engine: unknown }).engine = fakeEngine;

    const r1 = await svc.resolveStreams('movie', 'tt-memo', false);
    await settle();
    assert.deepEqual(r1.subtitles, []);
    assert.equal(r1.streams.length, 1);

    const r2 = await svc.resolveStreams('movie', 'tt-memo', true);
    await settle();
    assert.equal(r2.subtitles.length, 1);
    assert.equal(r2.streams.length, 1);

    assert.equal(fakeEngine.getStreams.mock.callCount(), 1);
    assert.equal(fakeEngine.getSubtitles.mock.callCount(), 1);
  });
});
