// test/booth.test.js — vanilla Node assertions. Run: node test/booth.test.js
//
// The Confessional Booth's risky surface is NAMING and ARGUMENT CONSTRUCTION: a slug comes
// straight from a text field and ends up in a filename, and a take's number decides whether the
// previous take survives. Both are pure functions in lib/booth.js precisely so they can be proved
// here without a camera, a browser or ffmpeg.
import assert from 'assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeSlug, dateStamp, takeName, nextTake, extForMime, normalizeArgs, listTakes,
} from '../lib/booth.js';

async function run() {
  console.log('🧪 PepStudio Confessional Booth unit tests…');

  // --- slug: a filename component built from untrusted text ---
  assert.strictEqual(sanitizeSlug('Reality Check'), 'reality-check');
  assert.strictEqual(sanitizeSlug('  trailing -- dashes -- '), 'trailing-dashes');
  assert.strictEqual(sanitizeSlug(''), 'confessional', 'empty falls back');
  assert.strictEqual(sanitizeSlug(null), 'confessional');
  // Path traversal, separators and shell metacharacters must not survive in any form.
  for (const hostile of ['../../etc/passwd', '..', '/abs/path', 'a;rm -rf ~', '$(whoami)', '`id`', 'C:\\Windows\\x', '....//....//x']) {
    const out = sanitizeSlug(hostile);
    assert.ok(/^[a-z0-9-]+$/.test(out), `slug must be [a-z0-9-] only, got "${out}" from "${hostile}"`);
    assert.ok(!out.includes('..'), `slug must not contain .. (got "${out}")`);
    assert.strictEqual(path.basename(out), out, 'slug must be a bare name');
  }
  assert.strictEqual(sanitizeSlug('x'.repeat(200)).length, 48, 'slug is length-capped');
  console.log('✅ sanitizeSlug reduces any input to a safe bare filename component.');

  // --- date stamp is LOCAL, not UTC: an 11pm take belongs to that evening's shoot ---
  assert.strictEqual(dateStamp(new Date(2026, 9, 31, 23, 30)), '2026-10-31');
  assert.strictEqual(dateStamp(new Date(2026, 0, 5, 0, 1)), '2026-01-05', 'month/day are zero-padded');
  console.log('✅ dateStamp uses the local calendar date.');

  // --- take names sort naturally and default to mp4 ---
  assert.strictEqual(takeName({ slug: 'confessional', date: '2026-10-31', take: 3 }), 'confessional-2026-10-31-take03.mp4');
  assert.strictEqual(takeName({ slug: 'x', date: '2026-10-31', take: 12, ext: 'webm' }), 'x-2026-10-31-take12.webm');
  console.log('✅ takeName pads the take number and defaults to .mp4.');

  // --- container choice follows the MIME the browser actually produced ---
  assert.strictEqual(extForMime('video/mp4;codecs=avc1.42E01E,mp4a.40.2'), 'mp4');
  assert.strictEqual(extForMime('video/webm;codecs=vp9,opus'), 'webm');
  assert.strictEqual(extForMime('VIDEO/MP4'), 'mp4', 'MIME is case-insensitive');
  assert.strictEqual(extForMime(''), 'webm', 'unknown falls back to webm');
  console.log('✅ extForMime maps the recorder MIME to a container.');

  // --- normalize args: the three properties that make a browser recording editable ---
  const args = normalizeArgs('/in.webm', '/out.mp4', ['-c:v', 'libx264']);
  assert.ok(args.includes('-fps_mode') && args[args.indexOf('-fps_mode') + 1] === 'cfr', 'constant frame rate');
  assert.ok(args.includes('+faststart'), 'moov box up front');
  assert.ok(args.indexOf('-i') < args.indexOf('-c:v'), 'input options precede output options');
  assert.strictEqual(args[args.length - 1], '/out.mp4', 'output is last');
  const noCfr = normalizeArgs('/in.webm', '/out.mp4', ['-c:v', 'libx264'], { cfr: false });
  assert.ok(!noCfr.includes('-fps_mode'), 'old-ffmpeg retry drops -fps_mode');
  console.log('✅ normalizeArgs produces a faststart CFR transcode (and an old-ffmpeg fallback).');

  // --- take numbering reads the DISK, so two booths can never overwrite each other ---
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pep-booth-test-'));
  try {
    assert.strictEqual(await nextTake(dir, 'confessional', '2026-10-31'), 1, 'empty library starts at 1');
    assert.strictEqual(await nextTake(path.join(dir, 'nope'), 'confessional', '2026-10-31'), 1, 'missing dir starts at 1');
    for (const n of ['confessional-2026-10-31-take01.mp4', 'confessional-2026-10-31-take02.mp4']) {
      await fsp.writeFile(path.join(dir, n), 'x');
    }
    assert.strictEqual(await nextTake(dir, 'confessional', '2026-10-31'), 3);
    // A different slug, and a different day, each get their own numbering.
    assert.strictEqual(await nextTake(dir, 'intro', '2026-10-31'), 1);
    assert.strictEqual(await nextTake(dir, 'confessional', '2026-11-01'), 1);
    // A gap must not hand back a number that would overwrite a later take.
    await fsp.writeFile(path.join(dir, 'confessional-2026-10-31-take09.mp4'), 'x');
    assert.strictEqual(await nextTake(dir, 'confessional', '2026-10-31'), 10, 'never reuses below the highest take');
    console.log('✅ nextTake never returns a number that would overwrite an existing take.');

    // --- listing: newest first, media only ---
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'x');
    await fsp.mkdir(path.join(dir, 'subdir'));
    const now = Date.now();
    fs.utimesSync(path.join(dir, 'confessional-2026-10-31-take01.mp4'), now / 1000 - 300, now / 1000 - 300);
    fs.utimesSync(path.join(dir, 'confessional-2026-10-31-take09.mp4'), now / 1000, now / 1000);
    const takes = await listTakes(dir);
    assert.ok(takes.every((t) => /\.(mp4|webm|mkv|mov)$/i.test(t.name)), 'non-media is excluded');
    assert.ok(!takes.some((t) => t.name === 'subdir'), 'directories are excluded');
    assert.strictEqual(takes[0].name, 'confessional-2026-10-31-take09.mp4', 'newest take is first');
    assert.strictEqual((await listTakes(dir, 2)).length, 2, 'limit is honoured');
    assert.deepStrictEqual(await listTakes(path.join(dir, 'nope')), [], 'missing dir lists empty');
    console.log('✅ listTakes returns media files only, newest first.');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  console.log('🎉 Confessional Booth tests passed.');
}

run().catch((e) => { console.error('❌', e); process.exit(1); });
