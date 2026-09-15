import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The core barrel (packages/core/src/index.ts) is imported once by
// packages/core/test/setup.ts before any test file runs, resolving the
// pre-existing config <-> tasks <-> logger circular dependency the same
// way production does (packages/server/src/app.ts pulls it in first).
import { parsePlaybackUrl } from './failover.js';
import {
  withPlaybackDisplaySegment,
  PLAYBACK_PATH_PREFIX,
} from '../debrid/utils.js';

const OWNED_5_SEG =
  'http://localhost:3000' +
  PLAYBACK_PATH_PREFIX +
  'storeAuth123/-/fileInfoABC/meta456/S01E01%20-%20Turning%20Point.mkv';

describe('parsePlaybackUrl on a decorated URL', () => {
  it('returns the same filename/fileInfoRaw/metadataId as the undecorated one', () => {
    const decorated = withPlaybackDisplaySegment(OWNED_5_SEG, 'My Label.mkv');
    const undecoratedTarget = parsePlaybackUrl(OWNED_5_SEG);
    const decoratedTarget = parsePlaybackUrl(decorated);

    assert.ok(undecoratedTarget);
    assert.ok(decoratedTarget);
    assert.equal(decoratedTarget?.filename, undecoratedTarget?.filename);
    assert.equal(decoratedTarget?.fileInfoRaw, undecoratedTarget?.fileInfoRaw);
    assert.equal(decoratedTarget?.metadataId, undecoratedTarget?.metadataId);
    assert.equal(
      decoratedTarget?.encryptedStoreAuth,
      undecoratedTarget?.encryptedStoreAuth
    );
  });
});
