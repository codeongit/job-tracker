import test from 'node:test';
import assert from 'node:assert/strict';
import * as integration from '../dist/boss-integration.js';
import { markManualFields } from '../dist/model.js';
import { bossApplicationId, bossFactId } from '../dist/source-identity.js';
import { effectiveSourceFacts, effectiveSourceEvents } from '../dist/source-ledger.js';
import {
  correctionBatch,
  correctionFixture,
  CORRECTION_ACCOUNT,
  CORRECTION_STAMP,
} from './fixtures/boss-resume-correction.mjs';

const correct = (...args) => integration.correctBossResumeSemantics(...args);
const unsafe = { code: 'BOSS_RESUME_CORRECTION_UNSAFE' };
const parameters = (fixture) => ({
  applicationIds: fixture.applicationIds,
  workspaceSourceId: fixture.workspaceSourceId,
  stamp: fixture.stamp,
});

test('已核实发送误判整批按事实否决，保留已读并撤回自动沟通中', () => {
  const fixture = correctionFixture(),
    before = structuredClone(fixture.data);
  const result = correct(fixture.data, parameters(fixture));
  assert.deepEqual(fixture.data, before);
  assert.deepEqual(result.sourceEvents, before.sourceEvents);
  assert.deepEqual(result.sourceFacts, before.sourceFacts);
  for (const id of fixture.opportunityIds) {
    const old = before.opportunities.find((row) => row.id === id),
      next = result.opportunities.find((row) => row.id === id);
    assert.equal(next.resumeState, '未知');
    assert.equal(next.readState, old.readState);
    assert.equal(old.stage, '沟通中');
    assert.equal(next.stage, '已触达');
    const binding = result.sourceBindings.find(
      (row) => row.kind === 'opportunity' && row.opportunityId === id,
    );
    const prior = before.sourceBindings.find((row) => row.id === binding.id);
    assert.equal(binding.lastAutoResumeState, '未知');
    assert.equal(binding.lastAutoStage, '已触达');
    for (const field of ['autoFields', 'lastAutoReadState'])
      assert.equal(binding[field], prior[field]);
  }
  for (const id of fixture.applicationIds) {
    const application = result.sourceApplications.find((row) => row.id === id);
    assert.equal(application.status, 'protected');
    assert.equal(application.reason, 'user_rejected_wrong_resume_semantics');
    assert.equal(application.appliedAt, '');
    assert.equal(application.updatedAt, fixture.stamp);
  }
  assert.equal(
    effectiveSourceFacts(result).filter((row) => row.summary === 'resume_request_sent').length,
    0,
  );
  for (const event of effectiveSourceEvents(result).filter(
    (row) => row.summary === 'resume_request_sent',
  )) {
    assert.equal(event.opportunityId, '');
    assert.equal(event.status, 'skipped');
  }
  assert.equal(
    integration.platformObservationLabel(
      result.sourceEvents.find((row) => row.summary === 'resume_request_sent'),
      result.sourceApplications.find((row) => row.id === fixture.applicationIds[0]),
    ),
    '平台卡片（发送误判已人工否决）',
  );
});

test('任一所选缺失删除、人工决定、身份矛盾都原子拒绝且不改输入', () => {
  const mutations = [
    (f) => {
      f.data.sourceApplications = f.data.sourceApplications.filter(
        (row) => row.id !== f.applicationIds[1],
      );
    },
    (f) => {
      f.data.sourceApplications.find((row) => row.id === f.applicationIds[1]).deletedAt = f.stamp;
    },
    (f) => {
      f.data.sourceFacts.find(
        (row) =>
          row.id ===
          f.data.sourceApplications.find((item) => item.id === f.applicationIds[1]).factId,
      ).deletedAt = f.stamp;
    },
    (f) => {
      f.data.sourceEvents.find(
        (row) =>
          row.factId ===
          f.data.sourceApplications.find((item) => item.id === f.applicationIds[1]).factId,
      ).deletedAt = f.stamp;
    },
    (f) => {
      const app = f.data.sourceApplications.find((row) => row.id === f.applicationIds[1]);
      app.status = 'protected';
      app.reason = 'user_rejected_wrong_conversation';
    },
    (f) => {
      const app = f.data.sourceApplications.find((row) => row.id === f.applicationIds[1]);
      app.status = 'protected';
      app.reason = 'user_ignored_unresolved_observation';
    },
    (f) => {
      f.data.sourceApplications.find((row) => row.id === f.applicationIds[1]).status = 'no_effect';
    },
    (f) => {
      f.data.opportunities[1].deletedAt = f.stamp;
    },
    (f) => {
      f.data.opportunities[1].resumeState = '对方已接收';
    },
    (f) => {
      markManualFields(f.data, f.opportunityIds[1], ['resumeState']);
    },
    (f) => {
      f.data.sourceBindings.find(
        (row) => row.opportunityId === f.opportunityIds[1],
      ).lastAutoResumeState = '未知';
    },
    (f) => {
      f.data.sourceEvents.at(-1).externalJobId = 'different-job';
      f.data.sourceEvents.at(-1).canonicalUrl =
        'https://www.zhipin.com/job_detail/different-job.html';
    },
    (f) => {
      f.data.sourceEvents.at(-1).opportunityId = f.opportunityIds[1];
    },
    (f) => {
      f.data.opportunities[1].url = 'https://www.zhipin.com/job_detail/different-job.html';
    },
    (f) => {
      f.data.sourceBindings.find((row) => row.kind === 'account').workspaceSourceId =
        '00000000-0000-4000-8000-000000000002';
    },
    (f) => {
      f.data.sourceFacts.find((row) => row.factType === 'resume_request_sent').externalJobId =
        'another-job';
    },
    (f) => {
      f.data.sourceEvents = f.data.sourceEvents.filter(
        (row) =>
          row.factId !==
          f.data.sourceApplications.find((item) => item.id === f.applicationIds[1]).factId,
      );
    },
  ];
  for (const mutate of mutations) {
    const fixture = correctionFixture();
    mutate(fixture);
    const before = structuredClone(fixture.data);
    assert.throws(() => correct(fixture.data, parameters(fixture)), unsafe);
    assert.deepEqual(fixture.data, before);
  }
});

test('其它有效发送、接收和不同请求事实阻止回退；缺事实或应用不能假装不存在', () => {
  for (const summary of [
    'resume_sent_confirmed',
    'resume_attachment_sent',
    'resume_viewed_confirmed',
    'resume_request_sent',
  ]) {
    const fixture = correctionFixture({ jobs: 1 });
    const batch = correctionBatch(0, { summary, messageId: 'independent-resume' });
    fixture.data = integration.applyBossBatch(fixture.data, batch, {
      workspaceSourceId: fixture.workspaceSourceId,
      stamp: CORRECTION_STAMP,
    }).data;
    if (summary === 'resume_viewed_confirmed') {
      fixture.data.opportunities[0].resumeState = '已发送';
      fixture.data.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoResumeState =
        '已发送';
    }
    assert.throws(() => correct(fixture.data, parameters(fixture)), unsafe, summary);
    const gap = structuredClone(fixture);
    gap.data.sourceApplications = gap.data.sourceApplications.filter(
      (row) =>
        row.factId !== bossFactId({ ...batch.events[0], accountNamespace: CORRECTION_ACCOUNT }),
    );
    assert.throws(
      () => correct(gap.data, parameters(gap)),
      unsafe,
      `${summary} missing application`,
    );
    const factGap = structuredClone(fixture);
    factGap.data.sourceFacts = factGap.data.sourceFacts.filter(
      (row) => row.id !== bossFactId({ ...batch.events[0], accountNamespace: CORRECTION_ACCOUNT }),
    );
    assert.throws(
      () => correct(factGap.data, parameters(factGap)),
      unsafe,
      `${summary} missing fact`,
    );
  }
});

test('重新计算事实及应用身份，账号多目标、跨账号绑定与缺绑定拒绝', () => {
  const mutate = [
    (f) => {
      f.data.sourceApplications.find((row) => row.id === f.applicationIds[0]).factId =
        `boss-fact-${'9'.repeat(64)}`;
    },
    (f) => {
      f.data.sourceFacts.find((row) => row.factType === 'resume_request_sent').messageId =
        'wrong-message';
    },
    (f) => {
      f.data.sourceEvents.at(-1).messageId = 'wrong-message';
    },
    (f) => {
      f.data.sourceBindings = f.data.sourceBindings.filter(
        (row) => row.opportunityId !== f.opportunityIds[0],
      );
    },
    (f) => {
      const binding = f.data.sourceBindings.find(
        (row) => row.opportunityId === f.opportunityIds[0],
      );
      f.data.sourceBindings.push({
        ...binding,
        accountNamespace: `boss-geek:${'b'.repeat(64)}`,
        id: `boss-job-${'b'.repeat(64)}-${binding.externalJobId}`,
      });
    },
    (f) => {
      const binding = f.data.sourceBindings.find(
        (row) => row.opportunityId === f.opportunityIds[0],
      );
      f.data.sourceBindings.push({
        ...binding,
        externalJobId: 'another-job',
        canonicalUrl: 'https://www.zhipin.com/job_detail/another-job.html',
        id: `boss-job-${'a'.repeat(64)}-another-job`,
      });
    },
  ];
  for (const change of mutate) {
    const fixture = correctionFixture();
    change(fixture);
    assert.throws(() => correct(fixture.data, parameters(fixture)), unsafe);
  }
});

test('只撤回所选事实；旧队列及同事实新证明不能复活，真正新消息仍正常应用', () => {
  const fixture = correctionFixture(),
    result = correct(fixture.data, parameters(fixture));
  const options = { workspaceSourceId: fixture.workspaceSourceId, stamp: fixture.stamp };
  for (const old of fixture.batches)
    assert.deepEqual(integration.applyBossBatch(result, old, options).data, result);
  const newMessage = correctionBatch(0, { messageId: 'new-real-system-send' });
  const applied = integration.applyBossBatch(result, newMessage, options).data;
  assert.equal(applied.opportunities[0].resumeState, '已发送');
  assert.equal(applied.opportunities[0].stage, '沟通中');
  assert.equal(applied.opportunities[1].resumeState, '未知');
  assert.equal(applied.opportunities[1].stage, '已触达');
  assert.equal(
    applied.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).reason,
    'user_rejected_wrong_resume_semantics',
  );
  assert.equal(
    applied.sourceApplications.find(
      (row) =>
        row.id ===
        bossApplicationId(
          bossFactId({ ...newMessage.events[0], accountNamespace: CORRECTION_ACCOUNT }),
        ),
    ).status,
    'applied',
  );
});

test('补偿已否决事实的遗漏阶段，不改原否决时间；再次调用无变化', () => {
  const fixture = correctionFixture({ jobs: 1 });
  const incomplete = correct(fixture.data, parameters(fixture));
  const binding = incomplete.sourceBindings.find((row) => row.kind === 'opportunity');
  incomplete.opportunities[0].stage = '沟通中';
  binding.lastAutoStage = '沟通中';
  const before = structuredClone(incomplete);
  const result = correct(incomplete, { ...parameters(fixture), stamp: '2026-10-08T03:00:00.000Z' });
  assert.deepEqual(incomplete, before);
  assert.equal(result.opportunities[0].resumeState, '未知');
  assert.equal(result.opportunities[0].stage, '已触达');
  assert.equal(result.opportunities[0].readState, before.opportunities[0].readState);
  assert.equal(
    result.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage,
    '已触达',
  );
  assert.deepEqual(result.sourceApplications, before.sourceApplications);
  assert.deepEqual(result.sourceEvents, before.sourceEvents);
  assert.deepEqual(result.sourceFacts, before.sourceFacts);
  assert.deepEqual(
    correct(result, { ...parameters(fixture), stamp: '2026-10-08T04:00:00.000Z' }),
    result,
  );
});

test('初次与补偿纠正保留人工阶段、后续进展及漂移的自动来源', () => {
  const mutations = [
    (data, id) => markManualFields(data, id, ['stage']),
    ...['面试中', 'Offer', '已结束'].map((stage) => (data) => {
      data.opportunities[0].stage = stage;
      data.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage = stage;
    }),
    (data) => {
      data.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage = '已触达';
    },
  ];
  for (const mutate of mutations) {
    const fixture = correctionFixture({ jobs: 1 });
    mutate(fixture.data, fixture.opportunityIds[0]);
    const stage = fixture.data.opportunities[0].stage;
    const binding = fixture.data.sourceBindings.find((row) => row.kind === 'opportunity');
    const result = correct(fixture.data, parameters(fixture));
    assert.equal(result.opportunities[0].resumeState, '未知');
    assert.equal(result.opportunities[0].stage, stage);
    assert.equal(
      result.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage,
      binding.lastAutoStage,
    );
    assert.deepEqual(
      correct(result, { ...parameters(fixture), stamp: '2026-10-08T03:00:00.000Z' }),
      result,
    );
  }
});

test('已有人工跟进活动保留阶段；已删除活动不妨碍纠正自动阶段', () => {
  for (const deletedAt of ['', CORRECTION_STAMP]) {
    const fixture = correctionFixture({ jobs: 1 });
    fixture.data.activities.push({
      id: 'synthetic-manual-progress',
      opportunityId: fixture.opportunityIds[0],
      text: '合成独立跟进',
      deletedAt,
    });
    const result = correct(fixture.data, parameters(fixture));
    assert.equal(result.opportunities[0].resumeState, '未知');
    assert.equal(result.opportunities[0].stage, deletedAt ? '已触达' : '沟通中');
    assert.deepEqual(result.activities, fixture.data.activities);
  }
});

test('补偿调用仍拒绝人工简历、last-auto漂移及新增真实发送，整批不部分修改', () => {
  const mutations = [
    (data, fixture) => markManualFields(data, fixture.opportunityIds[0], ['resumeState']),
    (data) => {
      data.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoResumeState = '已发送';
    },
    (data) => {
      data.opportunities[0].resumeState = '已发送';
    },
    (data, fixture) =>
      integration.applyBossBatch(
        data,
        correctionBatch(0, { summary: 'resume_sent_confirmed', messageId: 'new-independent-send' }),
        {
          workspaceSourceId: fixture.workspaceSourceId,
          stamp: fixture.stamp,
        },
      ).data,
  ];
  for (const mutate of mutations) {
    const fixture = correctionFixture();
    let data = correct(fixture.data, parameters(fixture));
    for (const opportunity of data.opportunities) opportunity.stage = '沟通中';
    for (const binding of data.sourceBindings.filter((row) => row.kind === 'opportunity'))
      binding.lastAutoStage = '沟通中';
    data = mutate(data, fixture) ?? data;
    const before = structuredClone(data);
    assert.throws(() => correct(data, parameters(fixture)), unsafe);
    assert.deepEqual(data, before);
  }
});

test('恢复已未知但仍自动沟通中的备份也补偿阶段；人工及高阶进展保留', () => {
  const fixture = correctionFixture({ jobs: 1 });
  const corrected = correct(fixture.data, parameters(fixture));
  const incomplete = structuredClone(corrected);
  incomplete.opportunities[0].stage = '沟通中';
  incomplete.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage = '沟通中';
  const restored = integration.preserveBossResumeCorrections(corrected, incomplete);
  assert.equal(restored.opportunities[0].resumeState, '未知');
  assert.equal(restored.opportunities[0].stage, '已触达');
  assert.equal(restored.opportunities[0].readState, incomplete.opportunities[0].readState);
  for (const mutate of [
    (data) => markManualFields(data, fixture.opportunityIds[0], ['stage']),
    (data) => markManualFields(data, fixture.opportunityIds[0], ['resumeState']),
    (data) => {
      data.opportunities[0].stage = '面试中';
    },
    (data) => {
      data.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage = '已触达';
    },
    (data) => {
      data.activities.push({
        id: 'synthetic-manual-progress',
        opportunityId: fixture.opportunityIds[0],
        text: '合成独立跟进',
      });
    },
  ]) {
    const candidate = structuredClone(incomplete);
    mutate(candidate);
    const result = integration.preserveBossResumeCorrections(corrected, candidate);
    assert.equal(result.opportunities[0].stage, candidate.opportunities[0].stage);
  }
});

test('旧版仅纠正简历的决定未撤回阶段，恢复不能自行扩大决定', () => {
  const fixture = correctionFixture({ jobs: 1 });
  const oldDecision = correct(fixture.data, parameters(fixture));
  oldDecision.opportunities[0].stage = '沟通中';
  oldDecision.sourceBindings.find((row) => row.kind === 'opportunity').lastAutoStage = '沟通中';
  const restored = integration.preserveBossResumeCorrections(oldDecision, fixture.data);
  assert.equal(restored.opportunities[0].resumeState, '未知');
  assert.equal(restored.opportunities[0].stage, '沟通中');
});

test('同岗位多个明确否决事实一次撤回，独立普通消息和人工联动字段完整保留', () => {
  const fixture = correctionFixture({ jobs: 1 });
  const another = correctionBatch(0, { messageId: 'another-reviewed-false-card' });
  fixture.data = integration.applyBossBatch(fixture.data, another, {
    workspaceSourceId: fixture.workspaceSourceId,
    stamp: CORRECTION_STAMP,
  }).data;
  const application = fixture.data.sourceApplications.at(-1);
  application.status = 'applied';
  application.appliedAt = CORRECTION_STAMP;
  fixture.applicationIds.push(application.id);
  markManualFields(fixture.data, fixture.opportunityIds[0], ['readState', 'stage']);
  fixture.data.opportunities[0].readState = '未读';
  fixture.data.opportunities[0].stage = '面试中';
  const result = correct(fixture.data, parameters(fixture));
  assert.equal(result.opportunities[0].resumeState, '未知');
  assert.equal(result.opportunities[0].readState, '未读');
  assert.equal(result.opportunities[0].stage, '面试中');
  assert.equal(
    result.sourceApplications.filter((row) => row.reason === 'user_rejected_wrong_resume_semantics')
      .length,
    2,
  );
  assert.deepEqual(result.sourceEvents, fixture.data.sourceEvents);
  const restored = integration.preserveBossResumeCorrections(result, fixture.data);
  assert.equal(restored.opportunities[0].resumeState, '未知');
});

test('固定列表拒绝空、重复、超过100、无效身份和时间，不部分纠正', () => {
  const fixture = correctionFixture();
  for (const applicationIds of [
    [],
    [...fixture.applicationIds, fixture.applicationIds[0]],
    Array(101).fill(fixture.applicationIds[0]),
    ['unknown'],
    null,
  ])
    assert.throws(() => correct(fixture.data, { ...parameters(fixture), applicationIds }), unsafe);
  assert.throws(
    () => correct(fixture.data, { ...parameters(fixture), stamp: 'yesterday' }),
    unsafe,
  );
  assert.throws(
    () => correct(fixture.data, { ...parameters(fixture), workspaceSourceId: '' }),
    unsafe,
  );
});

test('恢复旧备份保留人工语义否决及已读，自动沟通中不复活，缺口与删除不被补造', () => {
  const fixture = correctionFixture(),
    corrected = correct(fixture.data, parameters(fixture));
  const restored = integration.preserveBossResumeCorrections(corrected, fixture.data);
  assert.deepEqual(restored.sourceEvents, fixture.data.sourceEvents);
  assert.deepEqual(restored.sourceFacts, fixture.data.sourceFacts);
  for (const id of fixture.opportunityIds) {
    const opportunity = restored.opportunities.find((row) => row.id === id),
      old = fixture.data.opportunities.find((row) => row.id === id);
    assert.equal(opportunity.resumeState, '未知');
    assert.equal(opportunity.readState, old.readState);
    assert.equal(opportunity.stage, '已触达');
  }
  for (const id of fixture.applicationIds)
    assert.deepEqual(
      restored.sourceApplications.find((row) => row.id === id),
      corrected.sourceApplications.find((row) => row.id === id),
    );
  assert.deepEqual(integration.preserveBossResumeCorrections(corrected, restored), restored);
  const gap = structuredClone(fixture.data);
  const factId = gap.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).factId;
  gap.sourceFacts = gap.sourceFacts.filter((row) => row.id !== factId);
  const preservedGap = integration.preserveBossResumeCorrections(corrected, gap);
  assert.deepEqual(preservedGap.sourceFacts, gap.sourceFacts);
  assert.equal(
    preservedGap.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).status,
    'applied',
  );
  const deleted = structuredClone(fixture.data);
  deleted.sourceFacts.find((row) => row.id === factId).deletedAt = fixture.stamp;
  assert.deepEqual(
    integration.preserveBossResumeCorrections(corrected, deleted).sourceFacts,
    deleted.sourceFacts,
  );
  const partialAlias = structuredClone(fixture.data);
  partialAlias.sourceEvents.at(-1).deletedAt = fixture.stamp;
  const partialRestored = integration.preserveBossResumeCorrections(corrected, partialAlias);
  assert.deepEqual(partialRestored.sourceEvents, partialAlias.sourceEvents);
  assert.equal(
    partialRestored.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).status,
    'protected',
  );
  assert.equal(partialRestored.opportunities[0].resumeState, '未知');
});

test('恢复时已有人工字段或独立真实发送可保留当前状态，旧误判事实仍持续否决', () => {
  const fixture = correctionFixture(),
    corrected = correct(fixture.data, parameters(fixture));
  const manual = structuredClone(fixture.data);
  markManualFields(manual, fixture.opportunityIds[0], ['resumeState', 'readState', 'stage']);
  const preserved = integration.preserveBossResumeCorrections(corrected, manual);
  assert.equal(preserved.opportunities[0].resumeState, '已发送');
  assert.equal(
    preserved.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).reason,
    'user_rejected_wrong_resume_semantics',
  );
  const actual = integration.applyBossBatch(
    fixture.data,
    correctionBatch(0, { summary: 'resume_sent_confirmed', messageId: 'true-send' }),
    { workspaceSourceId: fixture.workspaceSourceId, stamp: fixture.stamp },
  ).data;
  const supported = integration.preserveBossResumeCorrections(corrected, actual);
  assert.equal(supported.opportunities[0].resumeState, '已发送');
  assert.equal(
    supported.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).status,
    'protected',
  );
});

test('恢复候选的非空目标或岗位身份冲突不能借人工否决覆盖，拒绝且不改候选', () => {
  const fixture = correctionFixture(),
    corrected = correct(fixture.data, parameters(fixture));
  for (const mutate of [
    (data) => {
      data.sourceApplications.find((row) => row.id === fixture.applicationIds[0]).opportunityId =
        fixture.opportunityIds[1];
    },
    (data) => {
      data.sourceEvents.at(-1).externalJobId = 'another-job';
      data.sourceEvents.at(-1).canonicalUrl = 'https://www.zhipin.com/job_detail/another-job.html';
    },
    (data) => {
      data.opportunities[0].externalId = 'another-job';
    },
  ]) {
    const candidate = structuredClone(fixture.data);
    mutate(candidate);
    const before = structuredClone(candidate);
    assert.throws(() => integration.preserveBossResumeCorrections(corrected, candidate), unsafe);
    assert.deepEqual(candidate, before);
  }
});
