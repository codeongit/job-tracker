import {emptyData, clone} from './model.js';
const initial=()=>({data:emptyData(),base:emptyData(),config:{owner:'codeongit',repo:'personalNote',path:'简历准备/job-tracker/data.json'},generation:0,lastSync:'',pending:null});
let dbPromise;
function database(){
  return dbPromise??=new Promise((resolve,reject)=>{
    const req=indexedDB.open('job-tracker-v1',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('workspace');
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(new Error('无法打开本地数据库，请检查浏览器是否允许网站存储。'));
  });
}
export async function readState(){
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('workspace','readonly'),req=tx.objectStore('workspace').get('state');
    req.onsuccess=()=>resolve(req.result||initial());req.onerror=()=>reject(req.error);
  });
}
export async function updateState(transform){
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('workspace','readwrite'),store=tx.objectStore('workspace'),req=store.get('state');let next;
    req.onsuccess=()=>{try{next=transform(clone(req.result||initial()));store.put(next,'state');}catch(e){tx.abort();reject(e);}};
    tx.oncomplete=()=>{window.dispatchEvent(new Event('workspace-saved'));resolve(next);};
    tx.onerror=()=>reject(new Error('本地保存失败，请导出备份并检查浏览器存储空间。'));
    tx.onabort=()=>reject(new Error('本次修改未保存。'));
  });
}
export const editData=transform=>updateState(state=>{if(state.pending)throw new Error('请先到“数据与同步”解决冲突，再继续编辑。');state.data=transform(state.data);state.generation++;return state;});
