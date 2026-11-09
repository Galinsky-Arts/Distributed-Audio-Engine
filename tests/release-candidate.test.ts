import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessReleaseCandidate } from '../src/release-candidate.js';
const sha = 'a'.repeat(40);
const base = {
  sourceSha: sha, artifactSourceSha: sha,
  requiredChecks: ['Engine CI', 'Native audio CI'],
  checks: [
    { name: 'Engine CI', headSha: sha, conclusion: 'success' as const },
    { name: 'Native audio CI', headSha: sha, conclusion: 'success' as const }
  ], reproduciblePackageVerified: true, securityFindingsResolved: true,
  realDeviceQualification: false, productionAuthorization: false
};
test('exact-head reproducible development candidate does not imply production certification', () => {
  const result = assessReleaseCandidate(base);
  assert.equal(result.developmentCandidateVerified, true);
  assert.equal(result.productionReleaseReady, false);
  assert.deepEqual(result.unresolved,
    ['REAL_DEVICE_QUALIFICATION_NOT_VERIFIED', 'PRODUCTION_AUTHORIZATION_MISSING']);
});
test('missing or mismatched required checks and artifact source never become passing evidence', () => {
  const result = assessReleaseCandidate({
    ...base, artifactSourceSha: 'b'.repeat(40),
    checks: [{ name: 'Engine CI', headSha: 'b'.repeat(40), conclusion: 'success' as const }]
  });
  assert.equal(result.developmentCandidateVerified, false);
  assert.equal(result.productionReleaseReady, false);
  assert.ok(result.unresolved.includes('ARTIFACT_SOURCE_MISMATCH'));
  assert.ok(result.unresolved.includes('REQUIRED_CHECK_NOT_VERIFIED:Native audio CI'));
});
test('all actual requirements must match before a production-ready classification', () => {
  assert.equal(assessReleaseCandidate({
    ...base, realDeviceQualification: true, productionAuthorization: true
  }).productionReleaseReady, true);
  assert.throws(() => assessReleaseCandidate({ ...base, requiredChecks: ['Engine CI', 'Engine CI'] }));
  assert.throws(() => assessReleaseCandidate({ ...base, sourceSha: 'latest' }));
});

test('release evidence rejects changing accessors without invoking them', () => {
  let reads = 0;
  const changing = { ...base, get sourceSha() { reads++; return reads === 1 ? sha : 'latest'; } };
  assert.throws(() => assessReleaseCandidate(changing), /CANONICAL_ACCESSOR/);
  assert.equal(reads, 0);
  const report = { ...base.checks[0]!, get conclusion() { reads++; return 'success' as const; } };
  assert.throws(() => assessReleaseCandidate({ ...base, checks: [report] }), /CANONICAL_ACCESSOR/);
  assert.equal(reads, 0);
});
test('malformed or sparse check inventories cannot create verified candidates', () => {
  assert.throws(() => assessReleaseCandidate({ ...base, requiredChecks: Array(1) }), /NON_CANONICAL_ARRAY/);
  assert.throws(() => assessReleaseCandidate({ ...base, checks: Array(1) }), /NON_CANONICAL_ARRAY/);
  for (const checks of [
    [{ name: '', headSha: sha, conclusion: 'success' }],
    [{ name: 'Engine CI', headSha: 'latest', conclusion: 'success' }],
    [{ name: 'Engine CI', headSha: sha, conclusion: 'neutral' }],
    Array.from({ length: 129 }, () => base.checks[0])
  ]) assert.throws(() => assessReleaseCandidate({ ...base, checks } as typeof base), /INVALID_RELEASE_CHECK/);
  assert.throws(() => assessReleaseCandidate({ ...base, sourceSha: 1 } as unknown as typeof base), /INVALID_RELEASE_SOURCE_SHA/);
  assert.throws(() => assessReleaseCandidate({ ...base, artifactSourceSha: 'latest' }), /INVALID_ARTIFACT_SOURCE_SHA/);
  assert.throws(() => assessReleaseCandidate({ ...base, productionAuthorization: 'true' } as unknown as typeof base), /INVALID_RELEASE_EVIDENCE_FLAG/);
});
test('valid pending, missing, failed and duplicate required reports remain unverified', () => {
  for (const conclusion of ['pending', 'missing', 'failure'] as const) {
    const checks = base.checks.map(report => ({ ...report, conclusion }));
    assert.equal(assessReleaseCandidate({ ...base, checks }).developmentCandidateVerified, false);
  }
  assert.equal(assessReleaseCandidate({ ...base, checks: [...base.checks, base.checks[0]!] }).developmentCandidateVerified, false);
  assert.equal(assessReleaseCandidate({ ...base, artifactSourceSha: null }).developmentCandidateVerified, false);
});

