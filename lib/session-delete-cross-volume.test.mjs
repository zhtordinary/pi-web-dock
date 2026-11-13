import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=fs.readFileSync(new URL('./session-archive.ts',import.meta.url),'utf8');
function crossVolumeFixture(localDevice,candidates,required,files=fs){
 for(const base of new Set(candidates)){
  try {
   const info=files.statSync(base);
   if(!info.isDirectory()||info.dev===localDevice)continue;
   return files.mkdtempSync(join(base,'reader-delete-volume-'));
  }catch(error){if(!['ENOENT','ENOTDIR','EACCES','EPERM','EROFS'].includes(error.code))throw error;}
 }
 if(required)assert.fail('CI requires a writable temporary filesystem distinct from the checkout');
 return undefined;
}
test('Linux CI fails rather than silently skipping when no second filesystem is available',()=>{
 const sameDevice={statSync:()=>({isDirectory:()=>true,dev:7}),mkdtempSync:()=>assert.fail('same-device root must not be used')};
 assert.throws(()=>crossVolumeFixture(7,['/same'],true,sameDevice),/CI requires/);
 assert.equal(crossVolumeFixture(7,['/same'],false,sameDevice),undefined);
});
for(const failure of ['none','partial-delete','restore','backup','stage-cleanup']) test(`real cross-filesystem delete: ${failure}`,t=>{
 const local=fs.mkdtempSync(join(process.cwd(),'.delete-volume-'));
 let remote;
 t.diagnostic(`cross-volume fixture local=${local}`);
 try {
  remote=crossVolumeFixture(fs.statSync(local).dev,[tmpdir(),...(process.platform==='linux'?['/dev/shm']:[])],process.platform==='linux'&&Boolean(process.env.CI));
  if(!remote){t.skip('requires a writable temporary filesystem distinct from the checkout');return;}
  t.diagnostic(`cross-volume fixture remote=${remote}`);
  const parent=join(remote,'session.jsonl'),child=join(remote,'session','nested','child.jsonl'),sibling=join(remote,'sibling.jsonl');
  fs.mkdirSync(dirname(child),{recursive:true});fs.writeFileSync(parent,'complete parent\n');fs.writeFileSync(child,'complete child\n');fs.writeFileSync(sibling,'original sibling\n');
  let fault=false;const renames=[];
  const fakeFs={...fs,
   renameSync(from,to){renames.push([fs.statSync(dirname(from)).dev,fs.statSync(dirname(to)).dev]);return fs.renameSync(from,to);},
   cpSync(from,to,options){if(failure==='backup'&&to.endsWith('/backup/children')){fault=true;throw Error('injected backup failure');}if(failure==='restore'&&to.endsWith('/restore'))throw Error('injected restore failure');return fs.cpSync(from,to,options);},
   rmSync(path,options){if(failure==='stage-cleanup'&&/\.reader-delete-[^/]+$/.test(path)){fault=true;throw Error('injected stage cleanup failure');}if(['partial-delete','restore'].includes(failure)&&path.endsWith('/detached')){fault=true;fs.rmSync(join(path,'session.jsonl'));throw Error('injected partial removal');}return fs.rmSync(path,options);},
  };
  const mod={exports:{}};
  new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
   name=>name==='fs'?fakeFs:name==='@earendil-works/pi-coding-agent'?{getAgentDir:()=>local}:name.startsWith('./')?{}:require(name),mod,mod.exports);
  const changes=[{path:sibling,originalContent:'original sibling\n',nextContent:'reparented sibling\n'}];
  if(failure==='none'||failure==='stage-cleanup'){
   const result=mod.exports.deletePiSessionTree(parent,changes);assert.equal(result.deleted,true);
   if(failure==='stage-cleanup'){assert.equal(fault,true);assert.ok(result.cleanupPending.startsWith(remote));assert.equal(fs.existsSync(result.cleanupPending),true);}
   else assert.equal(fs.readdirSync(remote).some(x=>x.startsWith('.reader-delete-')),false);
   assert.equal(fs.existsSync(parent),false);assert.equal(fs.existsSync(dirname(dirname(child))),false);
   assert.equal(fs.readFileSync(sibling,'utf8'),'reparented sibling\n');
  }else if(failure==='backup'){
   assert.throws(()=>mod.exports.deletePiSessionTree(parent,changes),/backup failed/);assert.equal(fault,true);
   assert.equal(fs.readFileSync(parent,'utf8'),'complete parent\n');assert.equal(fs.readFileSync(child,'utf8'),'complete child\n');
   assert.equal(fs.readFileSync(sibling,'utf8'),'original sibling\n');assert.equal(renames.length,0);
  }else{
   assert.throws(()=>mod.exports.deletePiSessionTree(parent,changes),failure==='restore'?/restore failed/:/originals restored/);
   assert.equal(fault,true,'must reach and inject the actual destructive phase');
   const recoveries=fs.readdirSync(join(local,'session-repair-backups','permanent-delete'));
   const backup=join(local,'session-repair-backups','permanent-delete',recoveries[0],'backup');
   assert.equal(fs.readFileSync(join(backup,'session.jsonl'),'utf8'),'complete parent\n');
   assert.equal(fs.readFileSync(join(backup,'children','nested','child.jsonl'),'utf8'),'complete child\n');
   assert.equal(fs.readFileSync(sibling,'utf8'),'original sibling\n');
   if(failure==='partial-delete'){assert.equal(fs.readFileSync(parent,'utf8'),'complete parent\n');assert.equal(fs.readFileSync(child,'utf8'),'complete child\n');}
  }
  if(failure!=='backup')assert.ok(renames.length>0);
  for(const [from,to] of renames)assert.equal(from,to,'all moves must be same-volume');
 }finally{
  fs.rmSync(local,{recursive:true,force:true});
  if(remote)fs.rmSync(remote,{recursive:true,force:true});
  t.diagnostic(`cross-volume fixtures removed local=${!fs.existsSync(local)} remote=${!remote||!fs.existsSync(remote)}`);
 }
});
