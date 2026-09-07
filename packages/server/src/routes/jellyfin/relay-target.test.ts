import { describe, it, expect } from 'vitest';
import { isRelayLoop } from './relay-target.js';

const SELF = new Set(['https://aio.example.com', 'http://localhost:3000']);

describe('isRelayLoop', () => {
  it('rejects a target pointing back at this server’s own image relay', () => {
    expect(
      isRelayLoop(
        'https://aio.example.com/jellyfin/Items/abc123/Images/Primary',
        SELF
      )
    ).toBe(true);
    expect(
      isRelayLoop(
        'https://aio.example.com/jellyfin/uuid/pwd/Items/abc/Images/Backdrop/0',
        SELF
      )
    ).toBe(true);
    expect(
      isRelayLoop('http://localhost:3000/jellyfin/Items/x/Images/Logo', SELF)
    ).toBe(true);
  });

  it('rejects a target pointing back at the subtitle relay', () => {
    expect(
      isRelayLoop(
        'https://aio.example.com/jellyfin/Videos/item1/ms1/Subtitles/0/0/Stream.srt',
        SELF
      )
    ).toBe(true);
  });

  it('allows other routes on this same origin', () => {
    expect(
      isRelayLoop('https://aio.example.com/builtins/gdrive/poster.jpg', SELF)
    ).toBe(false);
    expect(isRelayLoop('https://aio.example.com/logo.png', SELF)).toBe(false);
    expect(
      isRelayLoop('https://aio.example.com/api/v1/posters/abc.jpg', SELF)
    ).toBe(false);
  });

  it('allows relay-shaped paths on somebody else’s origin', () => {
    expect(
      isRelayLoop(
        'https://images.metahub.space/poster/medium/tt0111161/img',
        SELF
      )
    ).toBe(false);
    expect(
      isRelayLoop(
        'https://other.example.com/jellyfin/Items/abc/Images/Primary',
        SELF
      )
    ).toBe(false);
  });

  it('treats an unparseable target as not-a-loop, leaving it to the fetch', () => {
    expect(isRelayLoop('not a url', SELF)).toBe(false);
    expect(isRelayLoop('', SELF)).toBe(false);
  });
});
