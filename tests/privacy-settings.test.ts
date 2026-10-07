import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privacySettings } from '../src/privacy-settings.ts';

test('privacy defaults to always; only an explicit saved ask enables consent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-default-privacy-'));
  try {
    const settings = privacySettings(root);
    assert.equal(settings.get(), 'always');
    for (const value of [{ version: 1 }, { mode: 'unknown' }, null]) {
      writeFileSync(join(root, 'privacy.json'), JSON.stringify(value));
      assert.equal(settings.get(), 'always');
    }
    settings.set('ask');
    assert.equal(privacySettings(root).get(), 'ask');
    settings.set('always');
    assert.equal(privacySettings(root).get(), 'always');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
