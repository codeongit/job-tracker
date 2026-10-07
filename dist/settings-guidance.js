import { groupBossObservations } from './boss-observations.js';
import { parseBossJobUrl } from './boss-job-url.js';

export function bossConflictTargets(data, applicationIds) {
  const factIds = new Set(
    (data?.sourceApplications || [])
      .filter((row) => !row.deletedAt && applicationIds.includes(row.id))
      .map((row) => row.factId),
  );
  const identities = new Set(
    (data?.sourceFacts || [])
      .filter(
        (row) => !row.deletedAt && factIds.has(row.id) && row.platform === 'boss' && row.messageId,
      )
      .map((row) => JSON.stringify([row.accountNamespace, row.messageId])),
  );
  const jobIds = new Set(
    (data?.sourceEvents || [])
      .filter(
        (row) =>
          !row.deletedAt &&
          row.platform === 'boss' &&
          identities.has(JSON.stringify([row.accountNamespace, row.messageId])),
      )
      .map((row) => row.externalJobId)
      .filter(Boolean),
  );
  return (data?.opportunities || [])
    .filter(
      (row) =>
        /^boss(?:直聘)?$/i.test((row.platform || '').replace(/\s/g, '')) &&
        (jobIds.has(row.externalId) || jobIds.has(parseBossJobUrl(row.url)?.jobId)),
    )
    .map((row) => ({
      opportunityId: row.id,
      company: row.company,
      role: row.role,
      deleted: Boolean(row.deletedAt),
    }));
}

// These are explanations of existing recovery paths, never platform actions.
export function bossFailureGuidance(code = '', stage = '') {
  if (/LOCAL_|WORKSPACE.*UNAVAILABLE|SERVICE_UNAVAILABLE/.test(code))
    return {
      title: '本机状态暂时无法更新',
      impact: '当前可能显示上次取得的状态，尚不能确认采集和处理结果。',
      next: '在本机终端检查服务，连接恢复后刷新状态。',
      command: 'pnpm service status',
    };
  if (/LOGIN|CAPTCHA|VERIFY|ACCOUNT.*MISMATCH/.test(code))
    return {
      title: '账号采集已暂停',
      impact: '该账号暂停取得新资料，已经录入的岗位保留。',
      next: '核对 BOSS 登录、验证和账号，处理原因后明确恢复跟踪。',
      command: 'pnpm boss resume',
    };
  if (/TASK_PAGE|TARGET_PAGE|MAIN_PAGE/.test(code))
    return {
      title: '采集页面需要恢复',
      impact: '原采集页面失效，尚未取得的资料不会自动补齐。',
      next: '在本机终端核对并恢复采集页面，登录正常后明确恢复跟踪。',
      command: 'pnpm boss recover-page',
    };
  if (/DETAIL_TAB_OWNERSHIP/.test(code))
    return {
      title: '岗位详情采集已暂停',
      impact: '详情页面归属需要核对，其他采集阶段可独立继续。',
      next: '保留页面现场，排除归属问题后明确恢复详情阶段。',
      command: 'pnpm boss resume-details',
    };
  if (/SNAPSHOT|CHECKPOINT|DIAGNOSTIC|DELIVERY|QUEUE|INBOX/.test(code) || stage === 'delivery')
    return {
      title: '本机资料尚未完成录入',
      impact: '已保存材料可能尚未交付到正式岗位，原有记录保留。',
      next: '检查本机保存失败原因，修复后用已保存材料恢复交付；此命令不访问平台。',
      command: 'pnpm boss recover-saved',
    };
  return {
    title: stage === 'detail' ? '部分岗位详情未取得' : '部分采集尚未完成',
    impact:
      stage === 'detail'
        ? '这些岗位的详情资料尚未补齐，其他阶段可独立处理。'
        : '部分来源材料未取得，已有正式记录保留。',
    next: '查看本机诊断定位原因；修复并取得成功结果后，此故障才会结束。',
    command: 'pnpm boss status',
  };
}

export function bossProcessingFeedback(data, status, feedback, now = Date.now()) {
  if (!feedback) return '';
  if (status?.connectionStale || status?.error)
    return `${feedback.label}；状态待更新，尚不能确认剩余问题。`;
  const applications = feedback.applicationIds.map((id) =>
    data?.sourceApplications?.find((row) => row.id === id && !row.deletedAt),
  );
  if (applications.some((row) => !row))
    return `${feedback.label}；部分来源记录已变化，请核对最新清单。`;
  const unresolved = applications.filter((row) => ['waiting', 'review'].includes(row.status));
  if (!unresolved.length) return `${feedback.label}；所选观察已处理，人工状态及决定继续保留。`;
  if (feedback.checking && now - feedback.startedAt < 30000)
    return `${feedback.label}；等待本机重新检查，仅使用已有材料。`;
  const groups = groupBossObservations(
    unresolved.map((row) => ({ applicationId: row.id, status: row.status, reason: row.reason })),
    data,
  );
  const conflicts = unresolved.filter((row) => row.status === 'review').length;
  const waiting = unresolved.filter((row) => row.status === 'waiting').length;
  return `${feedback.label}；当前仍有 ${groups.length} 条消息未完成（${waiting ? `${waiting} 项等待资料或证据` : ''}${waiting && conflicts ? '，' : ''}${conflicts ? `${conflicts} 项归属或资料矛盾` : ''}）。请查看下方具体原因。`;
}
