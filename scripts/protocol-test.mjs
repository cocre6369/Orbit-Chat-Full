/* Orbit protocol validator checks. No dependencies:
 *   node scripts/protocol-test.mjs
 * Covers every envelope type the room can receive, with the accept/reject cases that matter for the
 * screen-share type added in 3.1.0. Exit code 0 = all good. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// minimal globals the modules expect
globalThis.self = globalThis;
const brandSrc = fs.readFileSync(path.join(ROOT, 'shared/brand.js'), 'utf8');
new Function('self', brandSrc)(globalThis);
await import(path.join(ROOT, 'offscreen/protocol.js'));
const { validateEnvelope, MESSAGE_TYPES } = await import(path.join(ROOT, 'offscreen/protocol.js'));

const base = (type, payload) => ({ v: 1, type, id: 'm1', roomId: 'r1', senderId: 'u1', ts: Date.now(), payload });
const ctx = { roomId: 'r1', maxImageBytes: 6 * 1024 * 1024, maxAssetBytes: 50 * 1024 * 1024 };
const cases = [];
const ok = (name, env, ctx) => cases.push([name, env, ctx, null]);
const bad = (name, env) => cases.push([name, env, null, true]);

ok('chat', base('chat', { text: 'hello', kind: 'chat', seq: 0 }));
ok('typing', base('typing', { on: true }));
ok('screen start', base('screen', { kind: 'start', streamId: 's1', quality: 'med', fps: 10 }));
ok('screen stop', base('screen', { kind: 'stop', streamId: 's1', viewers: 2, reason: 'user' }));
ok('screen keyframe', base('screen', { kind: 'keyframe', streamId: 's1' }));
bad('screen bad kind', base('screen', { kind: 'nope', streamId: 's1' }));
bad('screen bad quality', base('screen', { kind: 'start', streamId: 's1', quality: 'ultra' }));
bad('screen bad fps', base('screen', { kind: 'start', streamId: 's1', quality: 'med', fps: 9999 }));
bad('screen no streamId', base('screen', { kind: 'start', quality: 'med' }));
bad('screen bad viewers', base('screen', { kind: 'stop', streamId: 's1', viewers: -3 }));
bad('unknown type', base('screen-share', { kind: 'start' }));
bad('bad version', { ...base('typing', { on: true }), v: 99 });
bad('bad sender', { ...base('typing', { on: true }), senderId: '' });
ok('presence', base('presence', { name: 'A', presence: 'online', avatar: { type: 'generated', variant: 1 } }));

let pass = 0, fail = 0;
for (const [name, env, _unused, expectErr] of cases) {
  // validateEnvelope returns a reason string, or null when the envelope is acceptable.
  let reason = 'threw';
  try { reason = validateEnvelope(env, ctx); } catch (e) { reason = 'threw: ' + e.message; }
  const wanted = !expectErr;
  const got = reason === null;
  if (wanted === got) { pass++; console.log(`PASS ${name}${wanted ? '' : ' (rejected: ' + reason + ')'}`); }
  else { fail++; console.log(`FAIL ${name} → ${reason === null ? 'accepted, expected rejection' : reason}`); }
}
console.log(`\n${pass}/${pass + fail} protocol cases pass`);
console.log('types:', MESSAGE_TYPES.length, MESSAGE_TYPES.includes('screen') ? '(includes screen)' : '(SCREEN MISSING)');
process.exit(fail ? 1 : 0);
