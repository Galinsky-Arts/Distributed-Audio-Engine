import { canonicalJson, invariant } from './validation.js';

/** Advisory release evidence summary, never an authorization to publish or deploy. */
export interface ReleaseCandidateEvidence {
  sourceSha: string;
  artifactSourceSha: string | null;
  checks: readonly { name: string; headSha: string; conclusion: 'success' | 'failure' | 'pending' | 'missing' }[];
  requiredChecks: readonly string[];
  reproduciblePackageVerified: boolean;
  securityFindingsResolved: boolean;
  realDeviceQualification: boolean;
  productionAuthorization: boolean;
}
export interface ReleaseCandidateAssessment {
  developmentCandidateVerified: boolean;
  productionReleaseReady: boolean;
  unresolved: readonly string[];
}
export function assessReleaseCandidate(value: ReleaseCandidateEvidence): ReleaseCandidateAssessment {
  // Use descriptor-checked detached data; never evaluate a changing report twice.
  const evidence = JSON.parse(canonicalJson(value)) as ReleaseCandidateEvidence;
  invariant(evidence && typeof evidence === 'object' &&
    Object.keys(evidence).sort().join(',') ===
      'artifactSourceSha,checks,productionAuthorization,realDeviceQualification,reproduciblePackageVerified,requiredChecks,securityFindingsResolved,sourceSha',
    'INVALID_RELEASE_EVIDENCE_FIELDS');
  const sha = (input: unknown): input is string =>
    typeof input === 'string' && /^[0-9a-f]{40}$/.test(input);
  invariant(sha(evidence.sourceSha), 'INVALID_RELEASE_SOURCE_SHA');
  invariant(evidence.artifactSourceSha === null || sha(evidence.artifactSourceSha), 'INVALID_ARTIFACT_SOURCE_SHA');
  for (const flag of [evidence.reproduciblePackageVerified, evidence.securityFindingsResolved,
    evidence.realDeviceQualification, evidence.productionAuthorization]) {
    invariant(typeof flag === 'boolean', 'INVALID_RELEASE_EVIDENCE_FLAG');
  }
  const checkName = (input: unknown): input is string =>
    typeof input === 'string' && input.length > 0 && input.length <= 128;
  invariant(Array.isArray(evidence.requiredChecks) && evidence.requiredChecks.length > 0 &&
    evidence.requiredChecks.length <= 128 && evidence.requiredChecks.every(checkName) &&
    new Set(evidence.requiredChecks).size === evidence.requiredChecks.length,
    'INVALID_REQUIRED_RELEASE_CHECKS');
  invariant(Array.isArray(evidence.checks) && evidence.checks.length <= 128, 'INVALID_RELEASE_CHECKS');
  for (const report of evidence.checks) {
    invariant(report && typeof report === 'object' &&
      Object.keys(report).sort().join(',') === 'conclusion,headSha,name' &&
      checkName(report.name) && sha(report.headSha) &&
      ['success', 'failure', 'pending', 'missing'].includes(report.conclusion),
      'INVALID_RELEASE_CHECK_REPORT');
  }
  const unresolved: string[] = [];
  if (evidence.artifactSourceSha !== evidence.sourceSha) unresolved.push('ARTIFACT_SOURCE_MISMATCH');
  for (const name of evidence.requiredChecks) {
    const reports = evidence.checks.filter(c => c && c.name === name);
    if (reports.length !== 1 || reports[0]!.headSha !== evidence.sourceSha ||
        reports[0]!.conclusion !== 'success') unresolved.push('REQUIRED_CHECK_NOT_VERIFIED:' + name);
  }
  if (evidence.reproduciblePackageVerified !== true) unresolved.push('REPRODUCIBLE_PACKAGE_NOT_VERIFIED');
  if (evidence.securityFindingsResolved !== true) unresolved.push('SECURITY_FINDINGS_UNRESOLVED');
  const developmentCandidateVerified = unresolved.length === 0;
  if (evidence.realDeviceQualification !== true) unresolved.push('REAL_DEVICE_QUALIFICATION_NOT_VERIFIED');
  if (evidence.productionAuthorization !== true) unresolved.push('PRODUCTION_AUTHORIZATION_MISSING');
  return Object.freeze({
    developmentCandidateVerified,
    productionReleaseReady: unresolved.length === 0,
    unresolved: Object.freeze(unresolved)
  });
}

