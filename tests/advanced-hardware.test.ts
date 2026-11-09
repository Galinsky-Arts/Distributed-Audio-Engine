import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdvancedHardwarePositionAdapter } from '../src/advanced-hardware.js';
const valid = {
  origin: 'trusted-native-coordinate' as const, hardware: 'uwb' as const,
  objectId: 'speaker', trackerId: 'tracker', sequence: 1, atMs: 100,
  x: 1, y: 2, z: 3, uncertaintyMeters: 0.2, confidence: 0.95
};
const policy = { maxAgeMs: 100, maxUncertaintyMeters: 1, minConfidence: 0.9 };
test('trusted calibrated coordinate can update only its bound physical output', () => {
  const adapter = new AdvancedHardwarePositionAdapter(policy, ['uwb']);
  adapter.placements.bindTracked('speaker', 'tracker');
  adapter.observe(valid, 110);
  assert.deepEqual(adapter.placements.positionAt('speaker', 110), {
    position: { x: 1, y: 2, z: 3 }, state: 'tracked'
  });
  assert.throws(() => adapter.observe({ ...valid, objectId: 'other', sequence: 2 }, 110), /TRACKER_NOT_BOUND/);
  assert.throws(() => adapter.observe({ ...valid, sequence: 1 }, 110), /TRACKING_REPLAY_OR_ROLLBACK/);
  assert.equal(adapter.placements.positionAt('speaker', 301), null);
});
test('BLE presence, unsupported hardware, stale and low-confidence data cannot invent coordinates', () => {
  const adapter = new AdvancedHardwarePositionAdapter(policy, ['uwb']);
  adapter.placements.bindTracked('speaker', 'tracker');
  assert.throws(() => adapter.observe({ ...valid, origin: 'ble-presence' }, 110), /HARDWARE_COORDINATE_UNVERIFIED/);
  assert.throws(() => adapter.observe({ ...valid, hardware: 'ble' }, 110), /HARDWARE_COORDINATE_UNVERIFIED/);
  assert.throws(() => adapter.observe({ ...valid, atMs: 1 }, 110), /TRACKING_INCONCLUSIVE/);
  assert.throws(() => adapter.observe({ ...valid, confidence: 0.2 }, 110), /TRACKING_INCONCLUSIVE/);
  assert.equal(adapter.placements.positionAt('speaker', 110), null);
});

test('configuration accessors cannot widen the retained confidence policy', () => {
  let reads = 0;
  const changing = { ...policy, get minConfidence() { return ++reads === 1 ? 0.9 : 0; } };
  assert.throws(() => new AdvancedHardwarePositionAdapter(changing, ['uwb']), /CANONICAL_ACCESSOR/);
  assert.equal(reads, 0);
  const mutable = { ...policy };
  const hardware: ('uwb' | 'calibrated-vision')[] = ['uwb'];
  const adapter = new AdvancedHardwarePositionAdapter(mutable, hardware);
  mutable.minConfidence = 0;
  hardware.push('calibrated-vision');
  adapter.placements.bindTracked('speaker', 'tracker');
  assert.throws(() => adapter.observe({ ...valid, confidence: 0.2 }, 110), /TRACKING_INCONCLUSIVE/);
  assert.throws(() => adapter.observe({ ...valid, hardware: 'calibrated-vision' }, 110), /HARDWARE_COORDINATE_UNVERIFIED/);
});
test('reports reject accessor and nonplain fields without consuming tracking state', () => {
  const adapter = new AdvancedHardwarePositionAdapter(policy, ['uwb']);
  adapter.placements.bindTracked('speaker', 'tracker');
  let reads = 0;
  const changing = { ...valid, get sequence() { reads++; return reads; } };
  assert.throws(() => adapter.observe(changing, 110), /CANONICAL_ACCESSOR/);
  assert.equal(reads, 0);
  assert.throws(() => adapter.observe(Object.assign(Object.create({ origin: 'trusted-native-coordinate' }), valid), 110), /NON_PLAIN_OBJECT/);
  assert.throws(() => adapter.observe({ ...valid, [Symbol('extra')]: true }, 110), /CANONICAL_SYMBOL/);
  const hidden = Object.defineProperty({ ...valid }, 'extra', { value: true });
  assert.throws(() => adapter.observe(hidden, 110), /NON_ENUMERABLE_CANONICAL_FIELD/);
  adapter.observe(valid, 110);
  assert.equal(adapter.placements.positionAt('speaker', 110)?.position.x, 1);
});
test('invalid capability configurations and inconclusive coordinates cannot update placement', () => {
  for (const capabilities of [[], ['uwb', 'uwb'], ['ble']] as unknown as ('uwb' | 'calibrated-vision')[][]) {
    assert.throws(() => new AdvancedHardwarePositionAdapter(policy, capabilities), /INVALID_HARDWARE_CAPABILITIES/);
  }
  const adapter = new AdvancedHardwarePositionAdapter(policy, ['calibrated-vision']);
  adapter.placements.bindTracked('speaker', 'tracker');
  const vision = { ...valid, hardware: 'calibrated-vision' as const };
  for (const bad of [{ ...vision, atMs: 111 }, { ...vision, uncertaintyMeters: 2 },
    { ...vision, x: Infinity }, { ...vision, origin: 'unverified-estimate' as const }]) {
    assert.throws(() => adapter.observe(bad, 110));
    assert.equal(adapter.placements.positionAt('speaker', 110), null);
  }
  adapter.observe(vision, 110);
  assert.equal(adapter.placements.positionAt('speaker', 110)?.state, 'tracked');
});

