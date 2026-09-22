import { live, serialize } from './model.js';
import { esc } from './ui.js';
import { APP_VERSION } from './version.js';
import { utf8Bytes } from './limits.js';

export function bossIntegrationView(status) {
  let view = bossIntegrationViewBody(status);
  if (status?.serverManaged)
    view = view.replace(
      '工作台只消费本机私有队列；不会回复、投递、切换聊天或触发云端同步。正常录入由固定脚本和事务规则完成。',
      '本机服务采集并录入，关闭此页面后仍继续。此页面显示正式结果；GitHub 仍由手动同步。',
    );
  if (status?.applicationCounts) {
    const counts = status.applicationCounts;
    view = view.replace(
      '<div class="integration-stats">',
      `<div class="integration-stats"><span><strong>${Number(counts.waiting || 0)}</strong> 等待自动补齐</span><span><strong>${Number(counts.review || 0)}</strong> 需要人工判断</span><span><strong>${Number(counts.protected || 0)}</strong> 人工字段已保护</span>`,
    );
  }
  const detail = status?.tracking?.detailEnrichment;
  if (detail) {
    const nextRetry = detail.nextRetryAt
        ? new Date(detail.nextRetryAt).toLocaleString('zh-CN')
        : '无',
      warning =
        detail.status === 'blocked'
          ? '<div class="warning section-gap">详情补齐已暂停；列表、历史消息和正式录入仍会继续。处理现场后执行 <code>pnpm boss resume-details</code>。</div>'
          : '';
    view = view.replace(
      '<div class="source-bindings section-gap">',
      `<div class="section-gap"><strong>岗位详情补齐</strong><div class="integration-stats"><span><strong>${Number(detail.pending || 0)}</strong> 待处理</span><span><strong>${Number(detail.deferred || 0)}</strong> 退避中</span><span><strong>${Number(detail.isolated || 0)}</strong> 技术隔离</span></div><small>下次重试：${esc(nextRetry)}${detail.lastError ? ` · 最近错误：${esc(detail.lastError)}` : ''}</small></div>${warning}<div class="source-bindings section-gap">`,
    );
  }
  return view;
}

function bossIntegrationViewBody(status) {
  if (!status?.available)
    return `<section class="panel"><div class="panel-header"><h2>BOSS 只读接入</h2><span class="badge">未启用</span></div><div class="panel-body"><p>本机接入尚未启用。队列和采集器配置只保存在私有目录，不会进入网页发布文件。</p></div></section>`;
  const accounts = status.accounts || [],
    restoreReview = status.restoreReview || [],
    server = status.server || {};
  return `<section class="panel"><div class="panel-header"><h2>BOSS 只读接入</h2><span class="badge ${status.error || status.blocked || restoreReview.length ? 'warn' : 'blue'}">${status.running ? '处理中' : status.blocked || status.error || restoreReview.length ? '需要处理' : '已连接'}</span></div><div class="panel-body"><p>工作台只消费本机私有队列；不会回复、投递、切换聊天或触发云端同步。正常录入由固定脚本和事务规则完成。</p><div class="integration-stats"><span><strong>${Number(status.pending || 0)}</strong> 待录入批次</span><span><strong>${Number(server.receiptCount || server.processed || 0)}</strong> 本机回执</span><span><strong>${Number(server.incidentCount || 0)}</strong> 故障材料</span></div>${status.blocked ? `<div class="warning section-gap">${esc(status.blocked)}</div>` : ''}${status.error ? `<div class="error section-gap">${esc(status.error)}</div>` : ''}${restoreReview.length ? `<div class="warning section-gap"><strong>检测到已回执但本工作区缺少来源事件</strong><p>可能恢复了较早备份。磁盘回执不作为已录入证明；请逐批核对后重放。</p>${restoreReview.map((gap) => `<div class="button-row"><span>批次 ${esc(gap.batchId.slice(-8))} · 缺少 ${Number(gap.missing)} 条</span><button class="secondary" data-boss-replay="${esc(gap.batchId)}">核对并重放</button></div>`).join('')}</div>` : ''}<div class="source-bindings section-gap">${accounts.length ? accounts.map((account) => `<div class="source-binding"><div><strong>${esc(account.label)}</strong><small>${account.pending} 个待录入批次${account.bound ? ' · 已绑定当前工作区' : account.ownedElsewhere ? ' · 已绑定其他工作区' : account.restoreRequired ? ' · 需确认恢复' : ' · 尚未绑定'}</small></div>${account.restoreRequired ? `<button class="secondary" data-boss-restore="${esc(account.accountNamespace)}">核对并恢复绑定</button>` : !account.bound && !account.ownedElsewhere ? `<button class="primary" data-boss-bind="${esc(account.accountNamespace)}">绑定并处理</button>` : account.ownedElsewhere ? '<span class="badge warn">需在原工作区处理</span>' : '<span class="badge blue">已绑定</span>'}</div>`).join('') : '<p class="note-summary">队列中暂时没有批次。</p>'}</div><small>当前浏览器来源：${esc((status.sourceId || '').slice(0, 8))}。绑定属于正式数据；跨浏览器恢复后会重新核对来源事件。</small></div></section>`;
}

export function settingsView({ state, ssh, token, syncing, diagnostic, backupStatus, bossStatus }) {
  const c = state.config;
  return `<div class="settings">${bossIntegrationView(bossStatus)}${ssh ? `<section class="panel"><div class="panel-header"><h2>本机 SSH 同步</h2><span class="badge blue">无需令牌</span></div><div class="panel-body"><p>使用这台电脑已有的 SSH key，同步到 ${esc(c.owner)}/${esc(c.repo)}。</p><p>数据文件：${esc(c.path)}</p><button class="primary" data-action="sync" ${syncing ? 'disabled' : ''}>${syncing ? '同步中…' : '立即通过 SSH 同步'}</button><p class="section-gap">私钥始终留在本机。手机或公开网页可使用下面的令牌方式连接同一份数据。</p>${state.pending ? '<button class="secondary" data-action="resolve-pending">处理同步冲突</button>' : ''}</div></section><details><summary>其他仓库或令牌方式</summary>` : ''}<section class="panel"><div class="panel-header"><h2>GitHub 私有同步</h2></div><div class="panel-body"><p>每台设备先保存在本地，点击“立即同步”合并云端记录。专用令牌只在当前页面会话中使用，关闭或刷新页面后需要重新填写。</p><form id="settings-form" class="form-stack"><div class="form-grid"><label>GitHub 用户名<input name="owner" value="${esc(c.owner)}" required></label><label>私有仓库名<input name="repo" value="${esc(c.repo)}" required></label><label class="span-2">数据文件路径<input name="path" value="${esc(c.path)}" required></label><label class="span-2">本次会话的访问令牌<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Fine-grained personal access token" value="${esc(token)}"></label></div><div><button class="primary" type="submit" ${syncing ? 'disabled' : ''}>保存连接设置</button> <button class="secondary" data-action="sync" type="button" ${syncing ? 'disabled' : ''}>立即同步</button></div><small>令牌选择此数据仓库，Contents 权限设置为 Read and write。只接受私有仓库，不会上传到公开仓库。</small></form><div class="button-row"><a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">创建专用令牌 ↗</a><button class="text-button" data-action="forget-token">清除当前令牌</button></div>${state.pending ? '<div class="button-row warning">存在尚未处理的冲突。<button class="text-button" data-action="resolve-pending">处理冲突</button></div>' : ''}</div></section>${ssh ? '</details>' : ''}<section class="panel"><div class="panel-header"><h2>导入、备份与导出</h2></div><div class="panel-body"><p>完整 JSON 备份包含记录、同步基线、未解决冲突及本机草稿。Markdown 适合放回 Obsidian 阅读。</p><div class="button-row"><button class="secondary" data-action="choose-file">导入 Markdown / JSON</button><button class="secondary" data-action="export-json">导出完整备份</button><button class="secondary" data-action="snapshots">本机快照</button><button class="secondary" data-action="export-md">导出 Markdown</button></div><p class="section-gap">已导入 ${live(state.data.imports).length} 个批次。原文内容保留在私有数据中。</p><small>本机自动保留最近 20 个操作快照；清理网站数据会同时清除快照。请下载完整备份并单独保存。</small></div></section>${['localhost', '127.0.0.1'].includes(location.hostname) ? `<section class="panel"><div class="panel-header"><h2>浏览器之外的自动备份</h2></div><div class="panel-body"><p>工作台打开时，保存记录或草稿后会自动写入本机私有目录 .local/backups/；每个来源保留最近30个有备份日期的首份及最新一份。</p><p id="disk-backup-status" role="status">${esc(backupStatus?.message || '正在检查…')}</p><div class="button-row"><button class="secondary" data-action="backup-now">立即备份</button><button class="secondary" data-action="disk-backups">查看独立备份</button></div><small>关闭页面前最后几秒的输入可能尚未写入磁盘，下次打开会补备份。磁盘备份仍在这台电脑上。</small></div></section>` : ''}<section class="panel"><div class="panel-header"><h2>版本与连接检查</h2><span class="badge">v${APP_VERSION}</span></div><div class="panel-body"><p>最近同步：${esc(state.lastSync ? new Date(state.lastSync).toLocaleString('zh-CN') : '尚未同步')}</p><p>数据文件：${(utf8Bytes(serialize(state.data)) / 1000).toFixed(1)} KB / 5 MB</p><button class="secondary" data-action="diagnose" ${syncing ? 'disabled' : ''}>检查连接</button><p id="diagnostic-result" class="section-gap" role="status">${esc(diagnostic || '检查只读取连接和云端文件，不上传记录。')}</p></div></section></div>`;
}
