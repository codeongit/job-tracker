import {emptyData,validateData,mergeData,serialize,equal} from './model.js';
export class RemoteError extends Error {constructor(message,status){super(message);this.status=status;}}
export function encodeUtf8(text){let binary='';for(const b of new TextEncoder().encode(text))binary+=String.fromCharCode(b);return btoa(binary);}
export function decodeUtf8(encoded){return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded.replace(/\s/g,'')),c=>c.charCodeAt(0)));}
export function validateConfig(config){
  if(!/^[\w.-]+$/.test(config.owner)||!/^[\w.-]+$/.test(config.repo))throw new Error('请填写有效的 GitHub 用户名和仓库名。');
  if(!config.path||config.path.startsWith('/')||config.path.split('/').some(p=>!p||p==='.'||p==='..')||!config.path.endsWith('.json'))throw new Error('数据路径必须是仓库内的 JSON 文件路径。');
  return config;
}
export function githubClient(config,token,fetcher=fetch){
  validateConfig(config);if(!token.trim())throw new Error('请先在设置中填写本次会话使用的 GitHub 令牌。');
  const prefix=`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  let branch;
  async function request(path,options={}){
    let response;
    try{response=await fetcher(prefix+path,{...options,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token.trim()}`,'Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(25000)});}
    catch{throw new RemoteError('无法连接 GitHub；本地修改仍然保留。请联网后重试。',0);}
    if(!response.ok){const messages={401:'令牌无效或已过期。',403:'没有读写权限或请求过于频繁，请检查权限后稍后重试。',404:'仓库、分支或数据文件不存在，或当前令牌无权访问。',409:'云端刚刚有更新，请重新同步。',422:'GitHub 未接受这次更新，请检查文件及写入权限。'};throw new RemoteError(messages[response.status]||`GitHub 请求失败（${response.status}）。`,response.status);}
    return response.json();
  }
  async function verify(){
    const repo=await request('');
    if(repo.private!==true)throw new Error('此仓库不是私有仓库。请使用私有仓库存放求职数据。');
    branch=repo.default_branch;if(!branch)throw new Error('仓库尚未初始化，请先在 GitHub 创建 README。');
    // Verify the branch independently: a contents 404 can then be treated as a missing file.
    await request(`/branches/${encodeURIComponent(branch)}`);return branch;
  }
  const path='/contents/'+config.path.split('/').map(encodeURIComponent).join('/');
  async function read(){
    if(!branch)await verify();
    try{
      const file=await request(path+`?ref=${encodeURIComponent(branch)}`);
      if(file.type!=='file'||file.encoding!=='base64'||file.size>5_000_000||typeof file.sha!=='string')throw new Error('云端数据文件过大或格式不支持，已停止同步。');
      let data;try{data=validateData(JSON.parse(decodeUtf8(file.content)));}catch(e){throw new Error(`云端文件校验失败：${e.message}`);}
      return {data,sha:file.sha,missing:false};
    }catch(e){if(e.status===404)return {data:emptyData(),sha:null,missing:true};throw e;}
  }
  async function write(data,sha){
    if(!branch)await verify();
    const body={message:'Update job tracker data',content:encodeUtf8(serialize(validateData(data))),branch};
    if(sha)body.sha=sha;
    return request(path,{method:'PUT',body:JSON.stringify(body)});
  }
  return {verify,read,write};
}

// Confirmation is for the exact snapshot sent; edits made during the request remain pending.
export function acknowledge(current,captured,uploaded){
  const rebased=mergeData(captured.data,current.data,uploaded);
  return {...current,base:uploaded,data:rebased.data,lastSync:new Date().toISOString(),
    pending:rebased.conflicts.length?{data:rebased.data,conflicts:rebased.conflicts,generation:current.generation}:null};
}
export async function syncWorkspace({client,readState,updateState,allowCreate=false}){
  for(let attempt=0;attempt<3;attempt++){
    const remote=await client.read(), captured=await readState();
    if(captured.pending)throw new Error('请先解决上次同步留下的冲突。');
    if(remote.missing&&!allowCreate)return {needsCreate:true};
    if(remote.missing&&!equal(captured.base,emptyData()))throw new Error('原有云端文件消失了，请检查仓库或恢复文件，系统不会自动重建覆盖。');
    const combined=mergeData(captured.base,captured.data,remote.data);
    if(combined.conflicts.length)return {conflicts:combined.conflicts,data:combined.data,remote:remote.data,generation:captured.generation};
    validateData(combined.data);
    if(!equal(combined.data,remote.data)||remote.missing){
      try{await client.write(combined.data,remote.sha);}
      catch(e){
        if(e.status===409)continue;
        if(e.status===0){
          // A timed-out write may already exist remotely; confirm before retrying it.
          const check=await client.read();if(check.missing||!equal(check.data,combined.data))throw e;
        }else throw e;
      }
    }
    const updated=await updateState(current=>{
      if(!equal(current.config,captured.config))throw new Error('同步目标已改变，请重新同步。');
      return acknowledge(current,captured,combined.data);
    });
    return {state:updated,pending:!!updated.pending,dirty:!equal(updated.data,updated.base)};
  }
  throw new Error('云端连续发生变化，本地修改已保留，请稍后重新同步。');
}
