// test/zooms.test.js — vanilla Node assertions, no framework. Run: node test/zooms.test.js
// Verifies the zoom-expression builder: safe fallback, balanced parens, clip-relative remap.
import assert from 'assert';
import { buildTimelineZoomExpression } from '../lib/zooms.js';

function runZoomTests() {
  console.log('🧪 PepStudio zoom-expression unit tests…');

  // --- TEST 1: no emphasis → no zoom (native passthrough) ---
  const empty = buildTimelineZoomExpression([], 10.0);
  assert.strictEqual(empty.hasZoom, false, 'empty input must not zoom');
  assert.strictEqual(empty.factor, '1', 'native factor must be 1');
  assert.strictEqual(empty.filter, null, 'no filter when nothing to zoom');
  console.log('✅ Test 1: empty input is a safe native passthrough.');

  // --- TEST 2: parenthesis balance on nested conditions (the FFmpeg-rejection risk) ---
  const blocks = [
    { start: 12.5, end: 13.2, text: "LET'S", emphasis: true },
    { start: 14.0, end: 14.8, text: 'GO', emphasis: true },
    { start: 16.2, end: 16.5, text: 'normal', emphasis: false }, // ignored
  ];
  const nested = buildTimelineZoomExpression(blocks, 10.0);
  const count = (s, c) => s.split(c).length - 1;
  assert.strictEqual(count(nested.filter, '('), count(nested.filter, ')'), 'parenthesis mismatch in filter');
  console.log('✅ Test 2: filter parentheses balance perfectly.');

  // --- TEST 3: absolute → clip-relative remap; non-emphasis excluded ---
  assert.ok(nested.factor.includes('between(t,2.5,3.2)'), 'failed clip-relative remap (12.5→2.5)');
  assert.ok(!nested.factor.includes('between(t,6.2'), 'non-emphasis block leaked a zoom window');
  // and the renderable filter is the scale-up-then-crop form, not a doomed time-varying crop
  assert.ok(nested.filter.startsWith('scale=') && nested.filter.includes('eval=frame'), 'must scale per-frame');
  assert.ok(nested.filter.endsWith('crop=1080:1920'), 'must crop back to constant size');
  console.log('✅ Test 3: clip-relative remap, non-emphasis ignored, renderable scale→crop form.');

  console.log('\n🚀 ALL ZOOM TESTS PASSED.');
}

runZoomTests();
