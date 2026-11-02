import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
test('build entry shares one identity across config processes and verifies paths with spaces and Unicode',t=>{
 const root=mkdtempSync(join(tmpdir(),'reader build 中文 '));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'scripts'));mkdirSync(join(root,'node_modules/next/dist/bin'),{recursive:true});
 for(const name of ['build-reader.mjs','verify-reader-build-identity.mjs'])copyFileSync(new URL(`../scripts/${name}`,import.meta.url),join(root,'scripts',name));
 writeFileSync(join(root,'node_modules/next/dist/bin/next.js'),`
 const fs=require('node:fs'),cp=require('node:child_process');
 const id=process.env.PI_WEB_READER_BUILD_ID;
 const child=cp.execFileSync(process.execPath,['-e','process.stdout.write(process.env.PI_WEB_READER_BUILD_ID)'],{encoding:'utf8'});
 if(child!==id)throw new Error('worker identity changed');
 fs.mkdirSync('.next/server/app/api/reader/events',{recursive:true});fs.mkdirSync('.next/static/chunks/app',{recursive:true});
 fs.writeFileSync('.next/BUILD_ID',id);fs.writeFileSync('.next/server/app/api/reader/events/route.js','const x={buildId:'+JSON.stringify(id)+'}');fs.writeFileSync('.next/static/chunks/app/page-test.js','const id='+JSON.stringify(child));
 `);
 const output=execFileSync(process.execPath,['scripts/build-reader.mjs'],{cwd:root,encoding:'utf8'});
 const receipt=JSON.parse(output.trim());assert.equal(receipt.server,'matched');assert.equal(receipt.browser,'matched');
 writeFileSync(join(root,'.next/server/app/api/reader/events/route.js'),'const x={buildId:"00000000-0000-0000-0000-000000000000"}');
 assert.throws(()=>execFileSync(process.execPath,['scripts/verify-reader-build-identity.mjs'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}),/server runtime identity differs/);
});
