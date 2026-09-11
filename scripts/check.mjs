import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
for(const file of await readdir(new URL('dist/',root))){
  if(file.endsWith('.js')){const r=spawnSync(process.execPath,['--check',new URL('dist/'+file,root).pathname],{stdio:'inherit'});if(r.status)process.exit(r.status);}
}
const html=await readFile(new URL('dist/index.html',root),'utf8');
for(const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g))await readFile(new URL('dist/'+match[1],root));
for(const name of await readdir(new URL('dist/',root))){
  const content=await readFile(new URL('dist/'+name,root),'utf8');
  if(/(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}|securityId=|zhipin\.com\/job_detail\//.test(content))throw new Error(`${name} 含有凭证或真实岗位链接，请移除后再发布。`);
}
process.stdout.write('JavaScript 语法、入口资源与公开目录检查通过。\n');
