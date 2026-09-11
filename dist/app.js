import {STAGES,GROUPS,emptyData,clone,uid,today,live,equal,validateData,parseMarkdown,applyImport,markdownExport,serialize,removeOpportunity,resolveConflicts} from './model.js';
import {readState,updateState,editData} from './storage.js';
import {githubClient,syncWorkspace,validateConfig} from './github.js';
import {discoverLocalSsh,localSshClient} from './local-ssh.js';
import {bindCommittedTextInput,trackComposition} from './text-input.js';
const $=s=>document.querySelector(s), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}};
let state,view='today',selected='',query='',filter='',page=0,token='',syncing=false,importFile=null,parsedImport=null,noticeTimer,localSsh=null;
const useSsh=()=>!!localSsh&&equal(state?.config,localSsh.target);
let deferredRender=false;
const composition=trackComposition(document,()=>{if(deferredRender){deferredRender=false;render(true);}});
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('job-tracker-updates'):null;
const options=(values,value)=>values.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v)}</option>`).join('');
const pendingTasks=id=>live(state.data.tasks).filter(t=>t.status==='待办'&&(!id||t.opportunityId===id)).sort((a,b)=>(a.dueAt||'9999').localeCompare(b.dueAt||'9999'));
function notify(message){clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=false;noticeTimer=setTimeout(()=>$('#notice').hidden=true,7000);}
function report(error){notify(error.message||'操作失败，请重试。');}
async function reload(preserveDrafts=false){state=await readState();render(preserveDrafts);}
async function change(transform){state=await editData(transform);channel?.postMessage('changed');render();}
function statusRender(){
  const dirty=!equal(state.data,state.base);
  $('#sync-state').textContent=syncing?'正在同步…':state.pending?'有冲突待处理':dirty?'本机已保存 · 待同步':state.lastSync?'已同步':'仅本机保存';
  $('#sync-button').disabled=syncing;$('#sync-button').textContent=syncing?'同步中…':useSsh()?'SSH 同步':'立即同步';
  $('#local-status').textContent=`${live(state.data.opportunities).length} 个岗位 · 本地已保存`;
  $('#last-sync').textContent=state.lastSync?`上次同步 ${new Date(state.lastSync).toLocaleString('zh-CN')}`:'尚未同步到 GitHub';
}
function header(){
  const labels={today:['下一步','今日行动','把需要处理的事安排好。'],list:['机会','岗位列表','每个岗位一条记录，保留完整沟通历史。'],board:['进展','进度看板','招聘阶段与消息状态分开记录。'],settings:['个人数据','数据与同步','数据先存本机，再同步到你的 GitHub 私有仓库。']};
  const [a,b,c]=labels[view];$('#eyebrow').textContent=a;$('#page-title').textContent=b;$('#page-caption').textContent=c;
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-current',b.dataset.view===view?'page':'false'));
}
function emptyView(){return `<section class="panel empty"><div class="empty-symbol">＋</div><h2>从已有记录开始</h2><p>导入个人记录，核对日期和字段，接着就能安排下一步。</p><div class="empty-actions">${['127.0.0.1','localhost'].includes(location.hostname)?'<button class="primary" data-action="local-import">导入现有个人记录</button>':''}<button class="secondary" data-action="choose-file">选择 Markdown / JSON</button><button class="secondary" data-action="new">手动新增岗位</button></div></section>`;}
function jobRow(o,board=false){
  const next=pendingTasks(o.id)[0];
  return `<button class="job-row" data-job="${esc(o.id)}" aria-pressed="${selected===o.id}"><div class="row-top"><span class="company">${esc(o.company)}</span><span class="badges">${o.priority==='重点'?'<span class="badge warn">重点</span>':''}<span class="badge ${o.stage==='沟通中'?'blue':''}">${esc(o.stage)}</span></span></div><div class="job-role">${esc(o.role)}</div>${next?`<div class="next-task">${esc(next.text)}</div>`:''}<div class="row-bottom"><span>${esc(o.platform||'渠道未填')} · ${esc(o.readState||'未知')}</span><span>${next?`${esc(next.dueAt||'日期待定')}`:`${esc(o.appliedAt||'日期未填')}`}</span></div></button>`;
}
function detail(){
  const o=live(state.data.opportunities).find(x=>x.id===selected);
  if(!o)return '<aside class="panel empty"><h2>查看岗位详情</h2><p>选择一个岗位，查看沟通记录或安排下一步。</p></aside>';
  const activities=live(state.data.activities).filter(a=>a.opportunityId===o.id).sort((a,b)=>(b.date||'0000').localeCompare(a.date||'0000')||(b.createdAt||'').localeCompare(a.createdAt||''));
  const tasks=pendingTasks(o.id),url=safeUrl(o.url);
  return `<aside class="panel detail-panel"><div class="detail-head"><h2>${esc(o.company)}</h2><p class="job-role">${esc(o.role)}</p><div class="badges"><span class="badge blue">${esc(o.stage)}</span><span class="badge">消息：${esc(o.readState||'未知')}</span><span class="badge">简历：${esc(o.resumeState||'未知')}</span></div><div class="detail-actions">${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="text-button">打开岗位 ↗</a>`:'<span></span>'}<button class="text-button" data-action="edit" data-id="${esc(o.id)}">编辑岗位</button></div></div><div class="detail-body">${o.stage==='已结束'?`<div class="warning">已结束：${esc(o.endReason||'原因未填')}</div>`:''}<dl class="detail-facts"><dt>首次联系</dt><dd>${esc(o.appliedAt||'未填')}</dd><dt>联系人</dt><dd>${esc(o.contact||'未填')}</dd>${o.location?`<dt>地点</dt><dd>${esc(o.location)}</dd>`:''}${o.salary?`<dt>薪资</dt><dd>${esc(o.salary)}</dd>`:''}</dl><h3>下一步行动</h3>${tasks.length?tasks.map(t=>`<div class="task-line"><div class="task-text">${esc(t.text)}<small>${esc(t.dueAt||'日期待定')}${t.dueAt&&t.dueAt<today()?' · 已逾期':''}</small></div><button class="text-button" data-complete="${esc(t.id)}">完成</button><button class="text-button" data-cancel-task="${esc(t.id)}">取消</button></div>`).join(''):'<p class="note-summary">尚未安排下一步。</p>'}<form id="task-form" class="form-stack section-gap"><label>新增行动<input name="text" required maxlength="500" placeholder="例如：询问面试安排"></label><label>计划日期<input type="date" name="dueAt"></label><button class="secondary" type="submit">安排下一步</button></form><section class="section-gap"><h3>补记沟通</h3><form id="activity-form" class="form-stack"><label>发生了什么<textarea name="text" required maxlength="10000" placeholder="例如：已发送简历，对方说下周安排面试"></textarea></label><div class="form-grid"><label>日期<input type="date" name="date" value="${today()}" required></label><label>类型<select name="type">${options(['沟通记录','对方回复','发送简历','跟进','面试','复盘'],'沟通记录')}</select></label></div><button class="primary" type="submit">保存沟通记录</button></form></section><section class="section-gap"><h3>沟通时间线 <small class="muted">${activities.length}</small></h3>${activities.length?`<ol class="timeline">${activities.slice(0,15).map(a=>`<li><time>${esc(a.date||'日期未记录')} · ${esc(a.type||'记录')}</time>${esc(a.text)}</li>`).join('')}</ol>${activities.length>15?`<details class="section-gap"><summary>查看其余 ${activities.length-15} 条</summary><ol class="timeline section-gap">${activities.slice(15).map(a=>`<li><time>${esc(a.date||'日期未记录')}</time>${esc(a.text)}</li>`).join('')}</ol></details>`:''}`:'<p class="note-summary">还没有沟通记录。</p>'}</section>${o.notes?`<section class="section-gap"><h3>备注</h3><p class="long-copy">${esc(o.notes)}</p></section>`:''}${o.description?`<details class="section-gap"><summary>岗位描述</summary><p class="long-copy">${esc(o.description)}</p></details>`:''}${o.rawStatus?`<div class="raw-note">导入时的原始状态：${esc(o.rawStatus)}</div>`:''}</div></aside>`;
}
function todayView(){
  const active=live(state.data.opportunities).filter(o=>o.stage!=='已结束');
  const parentIds=new Set(active.map(o=>o.id));
  const tasks=pendingTasks().filter(t=>parentIds.has(t.opportunityId));
  const due=tasks.filter(t=>t.dueAt&&t.dueAt<=today()),upcoming=tasks.filter(t=>t.dueAt>today()),undated=tasks.filter(t=>!t.dueAt);
  const suggestion=active.filter(o=>!tasks.some(t=>t.opportunityId===o.id)&&(o.resumeState==='被索要'||o.rawStatus?.includes('带人经验')));
  const group=(title,rows)=>rows.length?`<section class="panel"><div class="panel-header"><h2>${title}</h2><span class="count">${rows.length} 项</span></div>${rows.map(t=>{const o=active.find(o=>o.id===t.opportunityId);return `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(t.text)}</div><div class="action-meta">${esc(o.role)} · ${esc(t.dueAt||'未设日期')}${t.dueAt&&t.dueAt<today()?' · 已逾期':''}</div></div><button class="secondary" data-complete="${esc(t.id)}">完成</button></div>`;}).join('')}</section>`:'';
  return `<div class="stats-strip"><span><strong>${active.length}</strong>进行中</span><span><strong>${due.length}</strong>到期行动</span><span><strong>${active.filter(o=>!tasks.some(t=>t.opportunityId===o.id)).length}</strong>未设下一步</span></div><div class="split"><div class="form-stack">${group('今天及逾期',due)}${suggestion.length?`<section class="panel"><div class="panel-header"><h2>建议核实</h2><span class="count">根据已有记录</span></div>${suggestion.map(o=>`<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${o.resumeState==='被索要'?'核实简历是否已发送':'核实是否已答复带人经验'}</div><div class="action-meta">原记录：${esc(o.rawStatus||o.resumeState)}</div></div></div>`).join('')}</section>`:''}${group('接下来',upcoming)}${group('日期待定',undated)}${!tasks.length&&!suggestion.length?'<section class="panel empty"><h2>还没有待办行动</h2><p>从岗位列表选择一个机会，设置下次跟进日期。</p><button class="secondary" data-view="list">查看岗位</button></section>':''}</div>${detail()}</div>`;
}
function listPanelContent(){
  const all=live(state.data.opportunities).filter(o=>(!filter||o.stage===filter)&&`${o.company} ${o.role} ${o.contact||''}`.toLowerCase().includes(query.toLowerCase()));
  page=Math.max(0,Math.min(page,Math.ceil(all.length/10)-1));
  return `<div class="panel-header"><h2>岗位机会</h2><span class="count">${all.length} 个</span></div>${all.slice(page*10,page*10+10).map(o=>jobRow(o)).join('')||'<div class="empty"><p>没有匹配的岗位。</p></div>'}<div class="pager"><button class="text-button" data-page="-1" ${page===0?'disabled':''}>上一页</button><span>${all.length?`${page+1} / ${Math.ceil(all.length/10)}`:'0'}</span><button class="text-button" data-page="1" ${(page+1)*10>=all.length?'disabled':''}>下一页</button></div>`;
}
function updateListResults(){
  const panel=$('#job-list-panel');if(panel)panel.innerHTML=listPanelContent();
}
function listView(){return `<div class="filters"><input id="search" aria-label="搜索公司、岗位或联系人" placeholder="搜索公司、岗位、联系人" value="${esc(query)}"><select id="stage-filter" aria-label="筛选招聘阶段"><option value="">全部阶段</option>${options(STAGES,filter)}</select></div><div class="split"><section class="panel" id="job-list-panel">${listPanelContent()}</section>${detail()}</div>`;}
function boardView(){return `<div class="board">${STAGES.map(stage=>{const jobs=live(state.data.opportunities).filter(o=>o.stage===stage);return `<section class="lane"><h2>${stage}<span>${jobs.length}</span></h2>${jobs.map(o=>jobRow(o,true)).join('')||'<p class="lane-empty">暂无记录</p>'}</section>`;}).join('')}</div>`;}
function settingsView(){const c=state.config,ssh=useSsh();return `<div class="settings">${ssh?`<section class="panel"><div class="panel-header"><h2>本机 SSH 同步</h2><span class="badge blue">无需令牌</span></div><div class="panel-body"><p>使用这台电脑已有的 SSH key，同步到 ${esc(c.owner)}/${esc(c.repo)}。</p><p>数据文件：${esc(c.path)}</p><button class="primary" data-action="sync" ${syncing?'disabled':''}>${syncing?'同步中…':'立即通过 SSH 同步'}</button><p class="section-gap">私钥始终留在本机。手机或公开网页可使用下面的令牌方式连接同一份数据。</p>${state.pending?'<button class="secondary" data-action="resolve-pending">处理同步冲突</button>':''}</div></section><details><summary>其他仓库或令牌方式</summary>`:''}<section class="panel"><div class="panel-header"><h2>GitHub 私有同步</h2></div><div class="panel-body"><p>每台设备先保存在本地，点击“立即同步”合并云端记录。专用令牌只在当前页面会话中使用，关闭或刷新页面后需要重新填写。</p><form id="settings-form" class="form-stack"><div class="form-grid"><label>GitHub 用户名<input name="owner" value="${esc(c.owner)}" required></label><label>私有仓库名<input name="repo" value="${esc(c.repo)}" required></label><label class="span-2">数据文件路径<input name="path" value="${esc(c.path)}" required></label><label class="span-2">本次会话的访问令牌<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Fine-grained personal access token" value="${esc(token)}"></label></div><div><button class="primary" type="submit" ${syncing?'disabled':''}>保存连接设置</button> <button class="secondary" data-action="sync" type="button" ${syncing?'disabled':''}>立即同步</button></div><small>令牌选择此数据仓库，Contents 权限设置为 Read and write。只接受私有仓库，不会上传到公开仓库。</small></form><div class="button-row"><a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">创建专用令牌 ↗</a><button class="text-button" data-action="forget-token">清除当前令牌</button></div>${state.pending?'<div class="button-row warning">存在尚未处理的冲突。<button class="text-button" data-action="resolve-pending">处理冲突</button></div>':''}</div></section>${ssh?'</details>':''}<section class="panel"><div class="panel-header"><h2>导入、备份与导出</h2></div><div class="panel-body"><p>JSON 备份包含岗位、任务和完整历史，可用于恢复。Markdown 适合放回 Obsidian 阅读。</p><div class="button-row"><button class="secondary" data-action="choose-file">导入 Markdown / JSON</button><button class="secondary" data-action="export-json">导出 JSON 备份</button><button class="secondary" data-action="export-md">导出 Markdown</button></div><p class="section-gap">已导入 ${live(state.data.imports).length} 个批次。原文内容保留在私有数据中。</p><small>清理浏览器网站数据会删除尚未同步的本地记录，请先同步或导出备份。</small></div></section></div>`;}
function render(preserveDrafts=false){
  if(!state)return;
  if(composition.active){deferredRender=true;return;}
  deferredRender=false;
  const active=document.activeElement;
  const focus=preserveDrafts&&active?.matches('input,textarea,select')?{id:active.id,form:active.form?.id,name:active.name,start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}:null;
  const drafts=preserveDrafts?['activity-form','task-form','settings-form'].flatMap(id=>{
    const form=document.getElementById(id);return form?[{id,values:Object.fromEntries(new FormData(form))}]:[];
  }):[];
  header();statusRender();
  $('#app-content').innerHTML=view==='settings'?settingsView():!live(state.data.opportunities).length?emptyView():view==='today'?todayView():view==='list'?listView():boardView();
  bindForms();
  for(const draft of drafts){const form=document.getElementById(draft.id);if(form)for(const [name,value] of Object.entries(draft.values)){const field=form.elements.namedItem(name);if(field)field.value=value;}}
  if(focus){
    const field=focus.id?document.getElementById(focus.id):document.getElementById(focus.form)?.elements.namedItem(focus.name);
    field?.focus?.({preventScroll:true});
    if(Number.isInteger(focus.start)&&typeof field?.setSelectionRange==='function')field.setSelectionRange(focus.start,focus.end,focus.direction||'none');
  }
}
function bindForms(){
  const search=$('#search');
  if(search)bindCommittedTextInput(search,value=>{query=value;page=0;updateListResults();});
  $('#stage-filter')?.addEventListener('change',e=>{filter=e.target.value;page=0;updateListResults();});
  $('#task-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),id=selected;try{await change(data=>{data.tasks.push({id:uid(),opportunityId:id,text:String(f.get('text')).trim(),dueAt:String(f.get('dueAt')),status:'待办',createdAt:new Date().toISOString()});return validateData(data);});notify('下一步已安排，本机已保存。');}catch(e){report(e);}});
  $('#activity-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target),id=selected;try{await change(data=>{data.activities.push({id:uid(),opportunityId:id,text:String(f.get('text')).trim(),date:String(f.get('date')),type:String(f.get('type')),createdAt:new Date().toISOString()});if(f.get('type')==='发送简历'){const o=data.opportunities.find(o=>o.id===id);o.resumeState='已发送';o.updatedAt=new Date().toISOString();}return validateData(data);});notify('沟通记录已保存。');}catch(e){report(e);}});
  $('#settings-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{
    const config=validateConfig({owner:String(f.get('owner')).trim(),repo:String(f.get('repo')).trim(),path:String(f.get('path')).trim()});
    const different=!equal(config,state.config);if(different&&!confirm('切换同步目标后，本机记录会保留，并与新仓库的数据合并。继续切换？'))return;
    token=String(f.get('token')).trim();state=await updateState(s=>({...s,config,base:different?emptyData():s.base,lastSync:different?'':s.lastSync,pending:different?null:s.pending}));render();notify('连接设置已保存。令牌仅在当前页面使用。');
  }catch(e){report(e);}});
}
function openEditor(id=''){
  const original=state.data.opportunities.find(o=>o.id===id)||{};
  const o={company:'',role:'',platform:'BOSS',source:'',contact:'',url:'',appliedAt:today(),stage:'已触达',readState:'未知',resumeState:'未知',endReason:'',priority:'普通',location:'',salary:'',notes:'',description:'',...original};
  $('#editor-content').innerHTML=`<form id="editor-form"><div class="dialog-header"><div><h2>${id?'编辑岗位':'新增岗位'}</h2><p>公司和岗位必填，其余可以稍后补充。</p></div><button type="button" class="close" data-close="editor-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><div id="editor-error" class="error form-error" role="alert"></div><div class="form-grid">${[['company','公司'],['role','岗位']].map(([k,label])=>`<label>${label}<input name="${k}" value="${esc(o[k])}" required maxlength="300"></label>`).join('')}<label>招聘阶段<select name="stage">${options(STAGES,o.stage)}</select></label><label>关注程度<select name="priority">${options(['普通','重点','暂缓'],o.priority)}</select></label><label>消息状态<select name="readState">${options(['未知','未读','已读'],o.readState)}</select></label><label>简历状态<select name="resumeState">${options(['未知','被索要','已发送','对方已接收'],o.resumeState)}</select></label><label>首次联系<input type="date" name="appliedAt" value="${esc(o.appliedAt)}"></label><label>结束原因<select name="endReason"><option value="">未结束 / 未填写</option>${options(['不匹配/拒绝','职位关闭','主动放弃','已入职','其他'],o.endReason)}</select></label>${[['platform','平台'],['source','来源类型（如猎头、内推）'],['contact','联系人'],['location','地点'],['salary','薪资原文'],['url','岗位链接']].map(([k,label])=>`<label>${label}<input name="${k}" ${k==='url'?'type="url"':''} value="${esc(o[k])}"></label>`).join('')}<label class="span-2">备注<textarea name="notes">${esc(o.notes)}</textarea></label><label class="span-2">岗位描述<textarea name="description">${esc(o.description)}</textarea></label></div></div><div class="dialog-footer">${id?`<button class="text-button danger" type="button" data-delete="${esc(id)}">删除岗位</button>`:''}<button class="secondary" type="button" data-close="editor-dialog">取消</button><button class="primary" type="submit">保存岗位</button></div></form>`;
  $('#editor-dialog').showModal();
  $('#editor-form').addEventListener('submit',async e=>{e.preventDefault();const input=Object.fromEntries(new FormData(e.target));for(const k in input)input[k]=input[k].trim();
    if(input.stage==='已结束'&&!input.endReason){$('#editor-error').textContent='请选择结束原因。';return;}
    if(input.stage!=='已结束')input.endReason='';
    const stamp=new Date().toISOString(),jobId=id||uid();
    try{await change(data=>{const current=data.opportunities.find(x=>x.id===jobId);
      if(id&&!equal(current,original))throw new Error('这个岗位刚在其他页面发生了修改，请重新打开后编辑。');
      if(current){if(current.stage!==input.stage)data.activities.push({id:uid(),opportunityId:jobId,date:today(),type:'阶段变化',text:`阶段从「${current.stage}」调整为「${input.stage}」`,createdAt:stamp});Object.assign(current,input,{updatedAt:stamp});}
      else data.opportunities.push({id:jobId,...input,createdAt:stamp,updatedAt:stamp});
      if(input.stage==='已结束')for(const task of data.tasks){if(task.opportunityId===jobId&&!task.deletedAt&&task.status==='待办')task.status='取消';}
      return validateData(data);});selected=jobId;view='list';render();$('#editor-dialog').close();notify(input.stage==='已结束'?'岗位已结束，未完成行动已取消。':'岗位已保存。');}catch(e){$('#editor-error').textContent=e.message;}
  });
}
function download(name,text,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function importPreview(file){
  if(file.text.length>5_000_000)throw new Error('文件超过 5 MB，请先拆分或移除大附件。');
  importFile=file;
  if(file.name.endsWith('.json')){
    const incoming=validateData(JSON.parse(file.text));
    const overlaps=incoming.opportunities.filter(o=>state.data.opportunities.some(x=>x.id===o.id)).length;
    $('#import-content').innerHTML=`<div class="dialog-header"><h2>恢复 JSON 备份</h2><button class="close" data-close="import-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><p>备份包含 ${live(incoming.opportunities).length} 个岗位，${live(incoming.activities).length} 条记录。</p><p class="muted section-gap">${overlaps} 个岗位已在本机存在。恢复会新增缺少的记录，并以备份中的同 ID 记录为准，本机独有记录保留。</p><div class="warning section-gap">建议先导出当前备份；恢复后仍需手动同步到云端。</div></div><div class="dialog-footer"><button class="secondary" data-action="export-json">先导出当前备份</button><button class="primary" id="restore-button">合并恢复备份</button></div>`;
    $('#import-dialog').showModal();$('#restore-button').onclick=async()=>{try{await change(data=>{for(const g of GROUPS){const map=new Map(data[g].map(r=>[r.id,r]));for(const r of incoming[g])map.set(r.id,r);data[g]=[...map.values()];}for(const o of data.opportunities.filter(o=>o.deletedAt))removeOpportunity(data,o.id);return validateData(data);});$('#import-dialog').close();notify('备份已恢复到本机。');}catch(e){report(e);}};return;
  }
  await renderImport('2026');$('#import-dialog').showModal();
}
async function renderImport(year){
  parsedImport=await parseMarkdown(importFile.text,year,importFile.name);
  $('#import-content').innerHTML=`<div class="dialog-header"><div><h2>核对导入记录</h2><p>${esc(importFile.name)} · 识别到 ${parsedImport.rows.length} 条</p></div><button class="close" data-close="import-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><label>原文日期所属年份<input id="import-year" type="number" min="1900" max="2100" value="${esc(year)}"></label><p class="note-summary section-gap">重复岗位默认跳过，不覆盖已经补记的状态。字段有疑点时，核实后再勾选导入。</p><div class="import-list">${parsedImport.rows.map(row=>{const o=row.opportunity,exists=state.data.opportunities.some(x=>x.id===o.id);return `<div class="import-row"><input type="checkbox" class="import-check" value="${esc(o.id)}" aria-label="导入 ${esc(o.company)}" ${exists?'disabled':row.issue?'':'checked'}><div class="import-info"><div class="company">${esc(o.company)} · ${esc(o.role)}</div><small>${esc(o.appliedAt)} · ${esc(o.rawStatus)}${exists?' · 已存在，将跳过':''}</small>${row.issue?`<label class="swap-check"><input type="checkbox" class="swap-check-input" value="${esc(o.id)}">确认公司和岗位填反，交换后导入</label>`:''}</div></div>`;}).join('')}</div></div><div class="dialog-footer"><button class="secondary" data-close="import-dialog">取消</button><button class="primary" id="confirm-import">导入选中记录</button></div>`;
  $('#import-year').addEventListener('change',e=>renderImport(e.target.value).catch(report));
  document.querySelectorAll('.swap-check-input').forEach(c=>c.addEventListener('change',()=>{c.closest('.import-row').querySelector('.import-check').checked=c.checked;}));
  $('#confirm-import').onclick=async()=>{try{const chosen=[...document.querySelectorAll('.import-check:checked')].map(c=>c.value),swaps=[...document.querySelectorAll('.swap-check-input:checked')].map(c=>c.value);if(!chosen.length)throw new Error('请至少选择一条未导入的记录。');let result;
    await change(data=>{result=applyImport(data,parsedImport,chosen,swaps);return result.data;});selected=live(state.data.opportunities)[0]?.id||'';view='list';render();$('#import-dialog').close();notify(`已新增 ${result.added} 个岗位，跳过 ${result.skipped} 个重复岗位。`);
  }catch(e){report(e);}};
}
async function showConflicts(pending){
  const label=row=>row?row.deletedAt?'此记录已删除':row.company?`${row.company} · ${row.role}\n阶段：${row.stage}\n简历：${row.resumeState||'未知'}\n备注：${row.notes||'无'}\n\n${JSON.stringify(row,null,2)}`:JSON.stringify(row,null,2):'此版本没有这条记录';
  $('#conflict-content').innerHTML=`<form id="conflict-form"><div class="dialog-header"><div><h2>选择要保留的版本</h2><p>本机与云端修改了同一条记录，尚未覆盖任何一方。</p></div><button class="close" type="button" data-close="conflict-dialog" aria-label="稍后处理">×</button></div><div class="dialog-body">${pending.conflicts.map((c,i)=>`<section class="conflict-item"><h3>冲突 ${i+1}${c.relational?' · 岗位删除与关联记录冲突':''}</h3><div class="conflict-options">${['local','remote'].map(side=>`<label><input type="radio" name="${esc(c.key)}" value="${side}" required>${side==='local'?'保留本机':'保留云端'}<pre>${esc(label(c[side]))}</pre></label>`).join('')}</div></section>`).join('')}</div><div class="dialog-footer"><button class="secondary" type="button" data-close="conflict-dialog">稍后处理</button><button class="primary" type="submit">保存选择</button></div></form>`;
  $('#conflict-dialog').showModal();$('#conflict-form').onsubmit=async e=>{e.preventDefault();try{const choices=Object.fromEntries(new FormData(e.target));
    state=await updateState(s=>{if(s.generation!==pending.generation)throw new Error('本机记录已变化，请关闭后再次同步，重新核对冲突。');s.data=resolveConflicts(pending.data,pending.conflicts,choices);if(pending.remote)s.base=pending.remote;s.pending=null;s.generation++;return s;});channel?.postMessage('changed');$('#conflict-dialog').close();render();notify('冲突选择已保存，请再次同步提交。');
  }catch(e){report(e);}};
}
async function synchronize(allowCreate=false){
  if(syncing)return;
  if(state.pending){if(state.pending.generation===state.generation){await showConflicts(state.pending);return;}state=await updateState(s=>({...s,pending:null}));}
  if(!useSsh()&&!token){view='settings';render();notify('请在此页面配置本次会话的 GitHub 令牌。');return;}
  syncing=true;statusRender();
  try{
    const run=async()=>syncWorkspace({client:useSsh()?localSshClient(localSsh.session):githubClient(state.config,token),readState,updateState,allowCreate});
    const result=navigator.locks?await navigator.locks.request('job-tracker-sync',{ifAvailable:true},lock=>{if(!lock)throw new Error('另一个页面正在同步，请稍后再试。');return run();}):await run();
    if(result.needsCreate){syncing=false;statusRender();if(confirm(`私有仓库 ${state.config.owner}/${state.config.repo} 中没有 ${state.config.path}。创建此数据文件并上传本机记录？`))await synchronize(true);return;}
    if(result.conflicts){state=await updateState(s=>{if(s.generation!==result.generation)throw new Error('本机记录刚发生修改，请重新同步。');s.pending=result;return s;});await showConflicts(result);}
    else{state=result.state;if(result.pending)await showConflicts(state.pending);else notify(result.dirty?'本次上传完成，新修改仍待同步。':'已与 GitHub 同步。');}
    channel?.postMessage('changed');
  }catch(e){report(e);}finally{syncing=false;await reload(true);}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.close){document.getElementById(b.dataset.close).close();return;}
    if(b.dataset.view){view=b.dataset.view;render();return;}
    if(b.dataset.job){selected=b.dataset.job;if(view==='board'||view==='today')view='list';filter='';query='';page=Math.floor(live(state.data.opportunities).findIndex(o=>o.id===selected)/10);render();return;}
    if(b.dataset.page){page+=Number(b.dataset.page);render();return;}
    if(b.dataset.complete||b.dataset.cancelTask){const id=b.dataset.complete||b.dataset.cancelTask;await change(data=>{const task=data.tasks.find(t=>t.id===id);if(task){task.status=b.dataset.complete?'完成':'取消';task.completedAt=new Date().toISOString();}return data;});notify(b.dataset.complete?'行动已完成。':'行动已取消。');return;}
    if(b.dataset.delete){if(!confirm('删除这个岗位及其关联记录？删除标记也会在下次同步时上传。'))return;await change(data=>{removeOpportunity(data,b.dataset.delete);return data;});$('#editor-dialog').close();selected='';render();notify('岗位已删除。');return;}
    const action=b.dataset.action;
    if(action==='new'||b.id==='new-button')openEditor();
    else if(action==='edit')openEditor(b.dataset.id);
    else if(action==='choose-file'||b.id==='import-button')$('#file-input').click();
    else if(action==='local-import'){
      const res=await fetch('./__local/source');if(!res.ok)throw new Error('未连接本地源文档，请使用“选择 Markdown”导入。');await importPreview({name:'个人记录.md',text:await res.text()});
    }
    else if(action==='export-json')download(`求职备份-${today()}.json`,serialize(state.data),'application/json;charset=utf-8');
    else if(action==='export-md')download(`求职记录-${today()}.md`,markdownExport(state.data),'text/markdown;charset=utf-8');
    else if(action==='sync'||b.id==='sync-button')await synchronize();
    else if(action==='forget-token'){token='';render();notify('当前页面的令牌已清除。');}
    else if(action==='resolve-pending')await synchronize();
  }catch(e){report(e);}
});
$('#file-input').addEventListener('change',async e=>{const file=e.target.files[0];if(file){try{await importPreview({name:file.name,text:await file.text()});}catch(e){report(e);}}e.target.value='';});
channel?.addEventListener('message',async()=>{state=await readState();statusRender();if(!document.querySelector('dialog[open]')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))render();});
window.addEventListener('offline',()=>notify('当前离线，记录继续保存在本机。'));
window.addEventListener('online',()=>notify('网络已恢复，可以点击“立即同步”。'));
$('#date-label').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
try{state=await readState();localSsh=await discoverLocalSsh();validateData(state.data);selected=live(state.data.opportunities)[0]?.id||'';render();}
catch(e){$('#app-content').innerHTML=`<section class="panel empty"><h2>本地记录暂时无法打开</h2><p>${esc(e.message)}</p></section>`;}
// Optional browser agent interface: opens the same visible form, without saving or syncing data.
if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  Promise.resolve(document.modelContext.registerTool({name:'start_job_entry',title:'打开新增岗位',description:'打开求职工作台的新增岗位表单；不会保存数据或发起云端同步。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||Object.keys(input).length)throw new Error('此操作不接受参数。');if(!state)throw new Error('本地数据尚未就绪。');openEditor();return {opened:true};}},{signal:lifecycle.signal})).catch(()=>{});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
