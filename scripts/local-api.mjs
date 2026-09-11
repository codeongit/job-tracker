import {timingSafeEqual} from 'node:crypto';
import {BridgeError} from './ssh-store.mjs';
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(body));};
export async function handleLocalApi(req,res,{port,secret,bridge,target}){
  const path=req.url.split('?')[0];
  if(!['/__local/session','/__local/git'].includes(path))return false;
  const origin=`http://${req.headers.host}`;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)||
    (req.headers.origin&&req.headers.origin!==origin)||
    (req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))){json(res,403,{message:'只允许本机工作台访问此接口。'});return true;}
  if(path==='/__local/session'){
    if(req.method!=='GET'){json(res,405,{message:'请求方式不支持。'});return true;}
    json(res,200,{enabled:!!bridge,session:bridge?secret:undefined,target:bridge?target:undefined});return true;
  }
  const supplied=req.headers['x-job-tracker-session'];
  if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(secret))){json(res,403,{message:'本机会话已失效，请刷新工作台。'});return true;}
  if(!bridge){json(res,404,{message:'此本机服务尚未配置 SSH 同步。'});return true;}
  try{
    if(req.method==='GET'){json(res,200,await bridge.read());return true;}
    if(req.method!=='PUT'){json(res,405,{message:'请求方式不支持。'});return true;}
    if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{message:'写入只接受工作台发出的同源 JSON 请求。'});return true;}
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>5_000_000)throw new BridgeError('数据超过 5 MB。',413);chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BridgeError('请求 JSON 无效。',400);}
    if(!body||Object.keys(body).some(k=>!['data','sha'].includes(k))||!(body.sha===null||typeof body.sha==='string'&&/^[a-f0-9]{40,64}$/.test(body.sha)))throw new BridgeError('请求参数无效。',400);
    json(res,200,await bridge.write(body.data,body.sha));
  }catch(error){json(res,error instanceof BridgeError?error.status:400,{message:error instanceof BridgeError?error.message:'数据校验或本地操作失败，已停止同步。'});}
  return true;
}
