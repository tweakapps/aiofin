import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../utils/index.js';
import { rememberImages, recallImages } from './images.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('jellyfin image memory', () => {
  it('does not let a catalog preview claim to be the whole answer', async () => {
    rememberImages('u1', 'preview-item', { Primary: 'poster.jpg' });
    await settle();

    const entry = await recallImages('u1', 'preview-item');
    assert.equal(entry?.images.Primary, 'poster.jpg');
    assert.equal(entry?.complete, false);
  });

  it('lets a full build claim completeness', async () => {
    rememberImages(
      'u1',
      'full-item',
      { Primary: 'p', Backdrop: 'b', Logo: 'l' },
      true
    );
    await settle();

    const entry = await recallImages('u1', 'full-item');
    assert.equal(entry?.complete, true);
    assert.equal(entry?.images.Logo, 'l');
  });

  it('remembers a complete-but-empty result as a definitive "no artwork"', async () => {
    rememberImages('u1', 'artless', {}, true);
    await settle();

    const entry = await recallImages('u1', 'artless');
    assert.ok(entry);
    assert.equal(entry.complete, true);
    assert.deepEqual(entry.images, {});
  });

  it('does not write an incomplete-and-empty result, which says nothing', async () => {
    rememberImages('u1', 'unknown', {});
    await settle();

    assert.equal(await recallImages('u1', 'unknown'), undefined);
  });

  it('scopes remembered URLs per user', async () => {
    rememberImages('u1', 'shared-id', {
      Primary: 'https://addon/p.jpg?key=SECRET',
    });
    await settle();

    assert.equal(await recallImages('u2', 'shared-id'), undefined);
  });

  it('reads entries written before completeness existed as incomplete', async () => {
    const raw = Cache.getInstance<string, unknown>('jellyfin-images', 50_000);
    await raw.set('u1|legacy', { Primary: 'old.jpg' }, 3600);
    await settle();

    const entry = await recallImages('u1', 'legacy');
    assert.equal(entry?.images.Primary, 'old.jpg');
    assert.equal(entry?.complete, false);
  });
});
