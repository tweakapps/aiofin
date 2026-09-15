import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The core barrel (packages/core/src/index.ts) is imported once by
// packages/core/test/setup.ts before any test file runs, resolving the
// pre-existing config <-> tasks <-> logger circular dependency the same
// way production does (packages/server/src/app.ts pulls it in first).
import {
  withPlaybackDisplaySegment,
  setPlaybackFallbackKey,
  PLAYBACK_PATH_PREFIX,
} from './utils.js';

const OWNED_5_SEG =
  'http://localhost:3000' +
  PLAYBACK_PATH_PREFIX +
  'storeAuth123/-/fileInfoABC/meta456/S01E01%20-%20Turning%20Point.mkv';

describe('withPlaybackDisplaySegment', () => {
  it('appends an encoded display segment to a 5-segment owned URL', () => {
    const out = withPlaybackDisplaySegment(OWNED_5_SEG, '1080p BluRay · Bento');
    assert.equal(
      out,
      OWNED_5_SEG + '/' + encodeURIComponent('1080p BluRay · Bento')
    );
  });

  it('preserves the first 5 segments verbatim', () => {
    const out = withPlaybackDisplaySegment(OWNED_5_SEG, 'label.mkv');
    const idx = out.indexOf(PLAYBACK_PATH_PREFIX);
    const restSegs = out
      .slice(idx + PLAYBACK_PATH_PREFIX.length)
      .split('/');
    const origSegs = OWNED_5_SEG.slice(
      OWNED_5_SEG.indexOf(PLAYBACK_PATH_PREFIX) + PLAYBACK_PATH_PREFIX.length
    ).split('/');
    for (let i = 0; i < origSegs.length; i++) {
      assert.equal(restSegs[i], origSegs[i]);
    }
    assert.equal(restSegs.length, origSegs.length + 1);
  });

  it('preserves the query string', () => {
    const url = OWNED_5_SEG + '?marker=1';
    const out = withPlaybackDisplaySegment(url, 'label.mkv');
    assert.ok(out.endsWith('?marker=1'));
    assert.ok(
      out.includes('/' + encodeURIComponent('label.mkv') + '?marker=1')
    );
  });

  it('leaves an external URL unchanged', () => {
    const url = 'https://torrentio.strem.fun/stream/movie/tt123.json';
    assert.equal(withPlaybackDisplaySegment(url, 'label.mkv'), url);
  });

  it('leaves a legacy 4-segment owned URL unchanged', () => {
    const legacy =
      'http://localhost:3000' +
      PLAYBACK_PATH_PREFIX +
      'storeAuth123/fileInfoABC/meta456/file.mkv';
    assert.equal(withPlaybackDisplaySegment(legacy, 'label.mkv'), legacy);
  });

  it('leaves an already 6-segment (decorated) URL unchanged', () => {
    const decorated = OWNED_5_SEG + '/already-decorated.mkv';
    assert.equal(
      withPlaybackDisplaySegment(decorated, 'label.mkv'),
      decorated
    );
  });

  it('leaves the URL unchanged when display is empty or whitespace', () => {
    assert.equal(withPlaybackDisplaySegment(OWNED_5_SEG, ''), OWNED_5_SEG);
    assert.equal(withPlaybackDisplaySegment(OWNED_5_SEG, '   '), OWNED_5_SEG);
  });

  it('leaves an unparsable string unchanged', () => {
    const notAUrl = 'not a url at all';
    assert.equal(withPlaybackDisplaySegment(notAUrl, 'label.mkv'), notAUrl);
  });
});

describe('setPlaybackFallbackKey on a decorated URL', () => {
  it('rewrites only segment [1] and keeps the display segment', () => {
    const decorated = withPlaybackDisplaySegment(OWNED_5_SEG, 'My Label.mkv');
    const rewritten = setPlaybackFallbackKey(decorated, '0.2.chainkey');
    const idx = rewritten.indexOf(PLAYBACK_PATH_PREFIX);
    const segs = rewritten.slice(idx + PLAYBACK_PATH_PREFIX.length).split('/');
    assert.equal(segs[0], 'storeAuth123');
    assert.equal(segs[1], '0.2.chainkey');
    assert.equal(segs[2], 'fileInfoABC');
    assert.equal(segs[3], 'meta456');
    assert.equal(segs[4], 'S01E01%20-%20Turning%20Point.mkv');
    assert.equal(segs[5], encodeURIComponent('My Label.mkv'));
  });
});
