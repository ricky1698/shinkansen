import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('manifest v3 不應宣告 background.scripts', async () => {
  const manifestUrl = new URL('../../shinkansen/manifest.json', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.background?.service_worker).toBe('background.js');
  expect(manifest.background).not.toHaveProperty('scripts');
});
