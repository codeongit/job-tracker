import { applyBossBatch, bindBossAccount } from '../../dist/boss-integration.js';
import { bossBatchDigestInput, bossEventDigestInput } from '../../dist/boss-batch.js';
import { emptyData, validateData } from '../../dist/model.js';
import { stableHash } from '../../scripts/boss-conversion.mjs';

export const CORRECTION_ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
export const CORRECTION_SOURCE = '00000000-0000-4000-8000-000000000001';
export const CORRECTION_STAMP = '2026-10-08T01:00:00.000Z';
export const CORRECTED_STAMP = '2026-10-08T02:00:00.000Z';

export function correctionBatch(
  index,
  { summary = 'resume_request_sent', ordinary = false, messageId, ...overrides } = {},
) {
  const suffix = String(index + 1),
    jobId = `synthetic-job-${suffix}`;
  const conversationKey = stableHash(['synthetic-conversation', suffix]);
  const resolvedMessageId = messageId ?? (ordinary ? `ordinary-${suffix}` : `resume-${suffix}`);
  const event = {
    eventId: '',
    ...(!ordinary
      ? {
          eventType: 'resume_observed',
          attribution: {
            version: 1,
            source: 'history',
            accountNamespace: CORRECTION_ACCOUNT,
            conversationKey,
            messageId: resolvedMessageId,
            requestedBossId: `boss-${suffix}`,
            responseFriendId: `friend-${suffix}`,
            responseFriendSource: 'source-1',
            responseBossId: `boss-${suffix}`,
            selfId: 'self-1',
            senderId: `boss-${suffix}`,
            recipientId: 'self-1',
            messageJobId: jobId,
          },
          resumeEvidence:
            summary === 'resume_request_sent'
              ? { version: 1, messageType: 5, field: 'body.text', text: '附件简历请求已发送' }
              : null,
        }
      : {}),
    jobDetails: null,
    conversationKey,
    friendId: `friend-${suffix}`,
    friendSource: 'source-1',
    uniqueId: `friend-${suffix}-source-1`,
    externalJobId: jobId,
    canonicalUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
    jobName: `合成岗位${suffix}`,
    company: `合成公司${suffix}`,
    contact: `合成联系人${suffix}`,
    summary: ordinary ? '合成普通消息' : summary,
    timeLabel: '',
    messageId: resolvedMessageId,
    messageDirection: ordinary ? 'unknown' : 'inbound',
    receiptStatus: ordinary ? 'unknown' : 'not_applicable',
    receiptSource: '',
    observedAt: CORRECTION_STAMP,
    evidenceDate: '',
    nameSource: 'loaded_jobName',
    linkConfirmation: 'unverified',
    intent: ordinary ? 'create_or_link' : 'observe_only',
    appliedAtForNew: '',
    sourceSequence: index * 2 + 1,
    ...overrides,
  };
  const batch = {
    format: 'job-tracker-boss-batch',
    version: 5,
    batchId: '',
    platform: 'boss',
    accountNamespace: CORRECTION_ACCOUNT,
    sourceSequence: event.sourceSequence,
    policy: {
      id: ordinary ? 'boss-manual-check-v1' : 'boss-resume-observation-v3',
      mode: ordinary ? 'incremental' : 'resume',
      timezone: 'Asia/Shanghai',
      appliedAtForNew: '',
      autoCreateComplete: ordinary,
    },
    source: {
      snapshotName: 'synthetic.json',
      snapshotSha256: 'c'.repeat(64),
      capturedAt: CORRECTION_STAMP,
    },
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
    events: [event],
  };
  event.eventId = `boss-event-${stableHash(bossEventDigestInput(batch, event))}`;
  batch.batchId = `boss-batch-${stableHash(bossBatchDigestInput(batch))}`;
  return batch;
}

export function correctionFixture({ jobs = 2, aliases = true, cards = true } = {}) {
  let data = bindBossAccount(emptyData(), CORRECTION_ACCOUNT, CORRECTION_SOURCE, CORRECTION_STAMP);
  const batches = [],
    options = { workspaceSourceId: CORRECTION_SOURCE, stamp: CORRECTION_STAMP };
  for (let index = 0; index < jobs; index++) {
    const ordinary = correctionBatch(index, { ordinary: true });
    const resume = correctionBatch(index);
    data = applyBossBatch(applyBossBatch(data, ordinary, options).data, resume, options).data;
    data.sourceApplications.at(-1).ruleVersion = 'boss-application-v11';
    batches.push(resume);
    if (cards)
      data = applyBossBatch(
        data,
        correctionBatch(index, { summary: 'resume_card_other', messageId: `card-${index + 1}` }),
        options,
      ).data;
  }
  if (aliases && jobs) {
    const original = data.sourceEvents.find((event) => event.summary === 'resume_request_sent');
    data.sourceEvents.push({
      ...original,
      id: `boss-event-${stableHash(['synthetic-review-alias', original.id])}`,
      status: 'review',
      opportunityId: '',
      externalJobId: '',
      canonicalUrl: '',
      jobName: '',
      company: '',
      nameSource: '',
    });
  }
  const applicationIds = data.sourceApplications
    .filter((application) =>
      data.sourceFacts.some(
        (fact) => fact.id === application.factId && fact.factType === 'resume_request_sent',
      ),
    )
    .map((application) => application.id);
  return {
    data: validateData(data),
    applicationIds,
    opportunityIds: data.opportunities.map((opportunity) => opportunity.id),
    batches,
    workspaceSourceId: CORRECTION_SOURCE,
    stamp: CORRECTED_STAMP,
  };
}
