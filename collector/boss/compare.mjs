import { isCanonicalBossJobUrl } from '../../dist/boss-job-url.js';
const SCOPE = 'loaded-chat-list';
const STRING_FIELDS = ['contact', 'company', 'title', 'preview', 'timeLabel'];
const CONFIDENCES = new Set(['dom', 'name_company']);
const RECEIPT_LABELS = new Map([
  ['read', '已读'],
  ['delivered', '送达'],
  ['unread', '未读'],
]);
const JOB_SOURCES = new Set(['chat_list', 'selected_chat_card']);

function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireTimestamp(value, name) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${name} must be an ISO timestamp with a timezone`);
  }
}

function copyReceipt(record, name) {
  // Persisted version-1 records from before receipt support have no such field.
  if (!Object.hasOwn(record, 'outgoingReceipt')) {
    return { status: 'unknown', label: null, source: null };
  }
  const receipt = record.outgoingReceipt;
  requireObject(receipt, `${name}.outgoingReceipt`);
  if (receipt.status === 'unknown') {
    if (receipt.label !== null || receipt.source !== null) {
      throw new TypeError(`${name}.outgoingReceipt unknown status requires null label and source`);
    }
  } else if (
    !RECEIPT_LABELS.has(receipt.status) ||
    (receipt.label !== RECEIPT_LABELS.get(receipt.status) &&
      receipt.label !== `[${RECEIPT_LABELS.get(receipt.status)}]`) ||
    receipt.source !== 'list_receipt_label'
  ) {
    throw new TypeError(`${name}.outgoingReceipt requires a matching explicit list receipt label`);
  }
  return { status: receipt.status, label: receipt.label, source: receipt.source };
}

function hasKnownJob(job) {
  return job.name !== null || job.detailUrl !== null;
}

function copyJob(record, name) {
  if (!Object.hasOwn(record, 'job')) return { name: null, detailUrl: null, source: null };
  const job = record.job;
  requireObject(job, `${name}.job`);
  if (
    job.name !== null &&
    (typeof job.name !== 'string' || !job.name.trim() || job.name.length > 300)
  ) {
    throw new TypeError(
      `${name}.job.name must be null or a nonempty string of at most 300 characters`,
    );
  }
  if (job.detailUrl !== null) {
    if (
      typeof job.detailUrl !== 'string' ||
      !isCanonicalBossJobUrl(job.detailUrl) ||
      new URL(job.detailUrl).href !== job.detailUrl
    ) {
      throw new TypeError(
        `${name}.job.detailUrl must be a canonical HTTPS BOSS job-detail URL without query or fragment`,
      );
    }
  }
  if (hasKnownJob(job) ? !JOB_SOURCES.has(job.source) : job.source !== null) {
    throw new TypeError(
      `${name}.job.source must identify the observed job field, or be null when both fields are unknown`,
    );
  }
  const result = { name: job.name, detailUrl: job.detailUrl, source: job.source };
  if (Object.hasOwn(job, 'detailUrlConfirmation')) {
    if (!job.detailUrl || !['pending_user', 'confirmed_user'].includes(job.detailUrlConfirmation)) {
      throw new TypeError(
        `${name}.job.detailUrlConfirmation requires a URL and a supported review status`,
      );
    }
    result.detailUrlConfirmation = job.detailUrlConfirmation;
  }
  return result;
}

function copyRecord(record, name) {
  requireObject(record, name);
  if (typeof record.key !== 'string' || !record.key.trim()) {
    throw new TypeError(`${name}.key must be a nonempty string`);
  }
  if (!CONFIDENCES.has(record.identityConfidence)) {
    throw new TypeError(`${name}.identityConfidence is invalid`);
  }
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== 'string') {
      throw new TypeError(`${name}.${field} must be a string`);
    }
  }
  if (record.unread !== null && (!Number.isSafeInteger(record.unread) || record.unread < 0)) {
    throw new TypeError(`${name}.unread must be null or a nonnegative integer`);
  }
  return {
    key: record.key,
    identityConfidence: record.identityConfidence,
    ...Object.fromEntries(STRING_FIELDS.map((field) => [field, record[field]])),
    unread: record.unread,
    outgoingReceipt: copyReceipt(record, name),
    job: copyJob(record, name),
  };
}

function validateSnapshot(snapshot) {
  requireObject(snapshot, 'snapshot');
  requireTimestamp(snapshot.capturedAt, 'snapshot.capturedAt');
  if (snapshot.scope !== SCOPE) throw new TypeError('snapshot.scope is invalid');
  if (!Array.isArray(snapshot.records)) throw new TypeError('snapshot.records must be an array');
  requireObject(snapshot.coverage, 'snapshot.coverage');
  const { loadedRows, truncated } = snapshot.coverage;
  if (!Number.isSafeInteger(loadedRows) || loadedRows < snapshot.records.length) {
    throw new TypeError('snapshot.coverage.loadedRows must be an integer at least records.length');
  }
  if (typeof truncated !== 'boolean')
    throw new TypeError('snapshot.coverage.truncated must be a boolean');
  return snapshot.records.map((record, index) => copyRecord(record, `snapshot.records[${index}]`));
}

function validateState(previousState) {
  if (previousState === null) return new Map();
  requireObject(previousState, 'previousState');
  if (previousState.version !== 1 || previousState.scope !== SCOPE) {
    throw new TypeError('previousState has an unsupported version or scope');
  }
  requireTimestamp(previousState.baselineCapturedAt, 'previousState.baselineCapturedAt');
  requireTimestamp(previousState.lastCapturedAt, 'previousState.lastCapturedAt');
  if (Date.parse(previousState.baselineCapturedAt) > Date.parse(previousState.lastCapturedAt)) {
    throw new TypeError('previousState baseline is later than its last capture');
  }
  if (!Array.isArray(previousState.records))
    throw new TypeError('previousState.records must be an array');
  const records = new Map();
  for (const [index, value] of previousState.records.entries()) {
    const name = `previousState.records[${index}]`;
    const record = copyRecord(value, name);
    requireTimestamp(value.firstObservedAt, `${name}.firstObservedAt`);
    requireTimestamp(value.lastObservedAt, `${name}.lastObservedAt`);
    if (
      Date.parse(value.firstObservedAt) < Date.parse(previousState.baselineCapturedAt) ||
      Date.parse(value.firstObservedAt) > Date.parse(value.lastObservedAt) ||
      Date.parse(value.lastObservedAt) > Date.parse(previousState.lastCapturedAt)
    ) {
      throw new TypeError(`${name} has inconsistent observation timestamps`);
    }
    if (records.has(record.key))
      throw new TypeError(`previousState contains duplicate key: ${record.key}`);
    records.set(record.key, {
      ...record,
      firstObservedAt: value.firstObservedAt,
      lastObservedAt: value.lastObservedAt,
    });
  }
  return records;
}

/**
 * Compare only the loaded chat-list observations. Neither list presence nor a
 * changed preview proves a new conversation, new message, rejection or deletion.
 * Missing rows remain in state. Unknown unread counts do not overwrite the last
 * known count. In contrast, an unavailable outgoing receipt becomes unknown:
 * it must not inherit a receipt that may belong to an earlier message preview.
 * Receipts describe the list's latest summary, not a proven message identity.
 * Job fields likewise describe only the current observation: unknown fields do
 * not inherit an older card's values, and contact titles are never job names.
 * Inputs are never mutated; malformed or older input throws before
 * a state/report is returned, so callers must not persist a failed comparison.
 */
export function compareSnapshots(previousState, snapshot) {
  const inputRecords = validateSnapshot(snapshot);
  const observed = validateState(previousState);
  const baseline = previousState === null;
  if (!baseline && Date.parse(snapshot.capturedAt) < Date.parse(previousState.lastCapturedAt)) {
    throw new TypeError('snapshot is older than the last accepted capture');
  }

  const grouped = new Map();
  for (const record of inputRecords) {
    const group = grouped.get(record.key) ?? [];
    group.push(record);
    grouped.set(record.key, group);
  }
  const ambiguities = [...grouped]
    .filter(([, records]) => records.length > 1)
    .map(([key, records]) => ({ key, count: records.length }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const changes = [];
  const counts = {
    receivedRecords: inputRecords.length,
    comparedRecords: 0,
    baselineRecords: 0,
    firstObserved: 0,
    previewChanged: 0,
    unreadChanged: 0,
    receiptObserved: 0,
    receiptChanged: 0,
    receiptUnavailable: 0,
    jobObserved: 0,
    jobChanged: 0,
    jobUnavailable: 0,
    timeLabelChanged: 0,
    ambiguousKeys: ambiguities.length,
    skippedAmbiguousRecords: ambiguities.reduce((total, item) => total + item.count, 0),
    notObservedThisCapture: [...observed.keys()].filter((key) => !grouped.has(key)).length,
    historicalRecords: 0,
    changes: 0,
  };

  for (const [key, records] of grouped) {
    if (records.length !== 1) continue;
    const current = records[0];
    const previous = observed.get(key);
    if (current.outgoingReceipt.status === 'unknown') counts.receiptUnavailable += 1;
    if (!hasKnownJob(current.job)) counts.jobUnavailable += 1;
    const identity = {
      key,
      identityConfidence: current.identityConfidence,
      contact: current.contact,
      company: current.company,
      title: current.title,
    };
    if (baseline) {
      counts.baselineRecords += 1;
    } else if (!previous) {
      counts.firstObserved += 1;
      changes.push({
        type: 'first_observed',
        ...identity,
        before: null,
        after: {
          ...current,
          outgoingReceipt: { ...current.outgoingReceipt },
          job: { ...current.job },
        },
      });
    } else {
      counts.comparedRecords += 1;
      if (previous.preview !== current.preview) {
        counts.previewChanged += 1;
        changes.push({
          type: 'preview_changed',
          ...identity,
          before: previous.preview,
          after: current.preview,
        });
      }
      if (
        previous.unread !== null &&
        current.unread !== null &&
        previous.unread !== current.unread
      ) {
        counts.unreadChanged += 1;
        changes.push({
          type: 'unread_changed',
          ...identity,
          before: previous.unread,
          after: current.unread,
        });
      }
      if (
        current.outgoingReceipt.status !== 'unknown' &&
        previous.outgoingReceipt.status !== current.outgoingReceipt.status
      ) {
        const firstObservation = previous.outgoingReceipt.status === 'unknown';
        counts[firstObservation ? 'receiptObserved' : 'receiptChanged'] += 1;
        changes.push({
          type: firstObservation ? 'receipt_observed' : 'receipt_changed',
          ...identity,
          before: { ...previous.outgoingReceipt },
          after: { ...current.outgoingReceipt },
          previewChanged: previous.preview !== current.preview,
        });
      }
      if (hasKnownJob(current.job)) {
        const changedFields = ['name', 'detailUrl'].filter(
          (field) =>
            previous.job[field] !== null &&
            current.job[field] !== null &&
            previous.job[field] !== current.job[field],
        );
        if (!hasKnownJob(previous.job)) {
          counts.jobObserved += 1;
          changes.push({
            type: 'job_observed',
            ...identity,
            before: { ...previous.job },
            after: { ...current.job },
          });
        } else if (changedFields.length) {
          counts.jobChanged += 1;
          changes.push({
            type: 'job_changed',
            ...identity,
            before: { ...previous.job },
            after: { ...current.job },
            changedFields,
          });
        }
      }
      if (previous.timeLabel !== current.timeLabel) counts.timeLabelChanged += 1;
    }
    observed.set(key, {
      ...current,
      unread: current.unread === null ? (previous?.unread ?? null) : current.unread,
      firstObservedAt: previous?.firstObservedAt ?? snapshot.capturedAt,
      lastObservedAt: snapshot.capturedAt,
    });
  }

  counts.historicalRecords = observed.size;
  counts.changes = changes.length;
  const warnings = [
    'Only the loaded chat-list rows were observed; absence is not evidence of deletion.',
  ];
  if (snapshot.coverage.truncated)
    warnings.push('The captured list is truncated; this is not a complete inbox comparison.');
  if (ambiguities.length)
    warnings.push(
      'All rows with duplicate keys were skipped; previous observations for those keys were retained.',
    );
  if (inputRecords.some((record) => record.identityConfidence === 'name_company')) {
    warnings.push(
      'Some identities use contact/company names; distinct conversations can share those names.',
    );
  }
  if (changes.length)
    warnings.push(
      'First observation, preview changes and unread-count changes do not prove a new message or a new conversation.',
    );
  if (counts.receiptObserved || counts.receiptChanged) {
    warnings.push(
      'Receipts describe the latest list summary. An observed receipt does not establish when it became read; changed receipts do not establish that both observations refer to the same message.',
    );
  }
  if (counts.jobObserved || counts.jobChanged) {
    warnings.push(
      'Job fields describe observed list/card content. Newly available details do not prove a newly assigned job; unavailable fields are not evidence of a job change.',
    );
  }
  const state = {
    version: 1,
    scope: SCOPE,
    baselineCapturedAt: previousState?.baselineCapturedAt ?? snapshot.capturedAt,
    lastCapturedAt: snapshot.capturedAt,
    records: [...observed.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
  const report = {
    mode: baseline ? 'baseline' : 'comparison',
    capturedAt: snapshot.capturedAt,
    previousCapturedAt: previousState?.lastCapturedAt ?? null,
    scope: SCOPE,
    counts,
    changes,
    ambiguities,
    coverage: { loadedRows: snapshot.coverage.loadedRows, truncated: snapshot.coverage.truncated },
    warnings,
  };
  return { state, report };
}
