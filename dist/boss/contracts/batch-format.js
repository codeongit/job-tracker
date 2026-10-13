export const BOSS_BATCH_FORMAT = 'job-tracker-boss-batch';
export const BOSS_RECEIPT_FORMAT = 'job-tracker-boss-receipt';
export const BOSS_CONTROL_FORMAT = 'job-tracker-boss-control';
export const BOSS_RUN_FORMAT = 'job-tracker-boss-run';
export const BOSS_INCIDENT_FORMAT = 'job-tracker-boss-incident';
export const BOSS_INTEGRATION_VERSION = 8;
export const BOSS_CONTROL_MAX_ATTEMPTS = 128;
export const BOSS_SUPPORTED_QUEUE_VERSIONS = Object.freeze([
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  BOSS_INTEGRATION_VERSION,
]);

export const isBossQueueVersion = (version) => BOSS_SUPPORTED_QUEUE_VERSIONS.includes(version);
