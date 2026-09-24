import { describe, expect, it } from 'vitest';

import { Sight } from '../src/ui/sight';

describe('a reader in sight', () => {
  it('is brought forward once, however many say so', () => {
    const s = new Sight();
    expect(s.set(true, false)).toBe(true);
    expect(s.set(true, false)).toBe(false);
    expect(s.on).toBe(true);
  });

  it('is brought forward again after the shell or the layout put it away', () => {
    const s = new Sight();
    s.set(true, false);
    expect(s.set(false, false)).toBe(false);
    expect(s.on).toBe(false);
    expect(s.set(true, false)).toBe(true);
  });

  it('is not brought forward by a browser tab coming back', () => {
    const s = new Sight();
    s.set(true, false);
    expect(s.set(false, true)).toBe(false);
    expect(s.on).toBe(false);
    expect(s.set(true, false)).toBe(false);
    expect(s.on).toBe(true);
    // And after that, the next time it is put away and brought forward
    // is an ordinary one.
    s.set(false, false);
    expect(s.set(true, false)).toBe(true);
  });
});
