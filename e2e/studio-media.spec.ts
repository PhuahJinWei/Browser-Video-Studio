import { expect, test } from '@playwright/test';

async function syntheticWebm(page: import('@playwright/test').Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const videoStream = canvas.captureStream(30);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const level = audioContext.createGain();
    const audioDestination = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = 220;
    level.gain.value = 0.04;
    oscillator.connect(level).connect(audioDestination);
    oscillator.start();
    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm',
      videoBitsPerSecond: 800_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(100);
    const started = performance.now();
    while (performance.now() - started < 1200) {
      const elapsed = performance.now() - started;
      context.fillStyle = `hsl(${Math.round(elapsed / 5) % 360} 75% 48%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.font = '28px sans-serif';
      context.fillText('Browser Video Studio', 20, 94);
      await new Promise((resolve) => setTimeout(resolve, 33));
    }
    recorder.stop();
    await stopped;
    oscillator.stop();
    await audioContext.close();
    stream.getTracks().forEach((track) => track.stop());
    return [...new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())];
  });
  return Buffer.from(bytes);
}

test('imports real media and exercises source editing, keyframes, proxy, and export gating', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/');
  await expect(page.getByText('Browser Video Studio')).toBeVisible();

  // Isolate the test from projects left by another run.
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Editing proxies').selectOption('never');

  const media = await syntheticWebm(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await (await chooser).setFiles({
    name: 'e2e-source.webm',
    mimeType: 'video/webm',
    buffer: media,
  });
  const card = page.locator('.bin-item', { hasText: 'e2e-source.webm' });
  await expect(card).toBeVisible({ timeout: 20_000 });

  await card.dblclick();
  await expect(page.getByText('Source', { exact: true })).toBeVisible();
  const sourceScrubber = page.getByRole('slider', { name: 'Preview position' });
  await sourceScrubber.press('ArrowRight');
  await page.getByRole('button', { name: 'In', exact: true }).click();
  await sourceScrubber.press('PageUp');
  await page.getByRole('button', { name: 'Out', exact: true }).click();
  await expect(page.locator('.scrub-range')).toBeVisible();
  await page.getByRole('button', { name: 'Overwrite', exact: true }).click();

  const videoClip = page.locator('.clip.video').first();
  await expect(videoClip).toBeVisible();
  await videoClip.click();
  await expect(page.locator('.inspector-group', { hasText: 'Video' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Opacity keyframe here' }).click();
  await expect(page.getByRole('button', { name: 'Remove Opacity keyframe here' })).toBeVisible();

  await page.locator('.inspector-group').filter({ hasText: /^Speed/ }).getByText('Speed', { exact: true }).click();
  await page.getByRole('button', { name: 'Add Playback rate keyframe here' }).click();
  await expect(page.getByText('Speed · ramped')).toBeVisible();

  const effectsGroup = page.locator('.inspector-group').filter({ hasText: /^Effects/ });
  await effectsGroup.locator('summary').click();
  await effectsGroup.locator('select').selectOption('color.basic');
  await page.getByRole('button', { name: 'Add Brightness keyframe here' }).click();
  await expect(page.getByRole('button', { name: 'Remove Brightness keyframe here' })).toBeVisible();
  await effectsGroup.locator('select').selectOption('audio.eq');
  await page.getByRole('button', { name: 'Add Low shelf keyframe here' }).click();
  await expect(page.getByRole('button', { name: 'Remove Low shelf keyframe here' })).toBeVisible();

  await card.click({ button: 'right' });
  await page.getByRole('button', { name: 'Generate editing proxy' }).click();
  await expect(card.locator('.bin-badge-proxy')).toHaveText('Proxy', { timeout: 30_000 });

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText(/This browser can encode|unavailable for these settings/)).toBeVisible();
  const exportButton = page.locator('.modal button.primary', { hasText: 'Export' });
  await expect(exportButton).toBeEnabled();
  // A seekable in-page stand-in exercises the disk-streaming path without opening
  // an operating-system dialog in CI.
  await page.evaluate(() => {
    const state = { bytes: 0, closed: false, aborted: false };
    Object.assign(globalThis, { __e2eExportState: state });
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          write: async (chunk: { position: number; data: Uint8Array }) => {
            state.bytes = Math.max(state.bytes, chunk.position + chunk.data.byteLength);
          },
          close: async () => { state.closed = true; },
          abort: async () => { state.aborted = true; },
        }),
      }),
    });
  });
  await exportButton.click();
  await expect(page.getByText(/Saved .* frames/)).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (globalThis as unknown as { __e2eExportState: { bytes: number } }).__e2eExportState.bytes)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Then verify the download fallback used by browsers without File System Access.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  const download = page.waitForEvent('download');
  await page.locator('.modal button.primary', { hasText: 'Export' }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  await expect(page.getByText(/Exported .* frames/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  expect(pageErrors).toEqual([]);
});
