import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,readFileSync,createWriteStream,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=fileURLToPath(new URL('..',import.meta.url));
const questionnaireSource=process.env.READER_QUESTIONNAIRE_SOURCE;
if(questionnaireSource)assert.equal(JSON.parse(readFileSync(join(questionnaireSource,'package.json'),'utf8')).version,'2.13.8');
const root=join(process.env.READER_MCP_QA_OUTPUT_ROOT||tmpdir(),'reader-mcp-acceptance-'+Date.now());mkdirSync(root,{recursive:true});
const home=join(root,'home'),agent=join(home,'.pi','agent'),project=join(home,'project');for(const p of [agent,project])mkdirSync(p,{recursive:true});
const evidence={root,scope:'real Reader HTTP and persistence; deterministic loopback OpenAI-compatible fixture; packaged Reader MCP stdio adapter',adapterVersion:JSON.parse(readFileSync(join(repo,'packages/reader-mcp/package.json'),'utf8')).version,requests:[],modelRequests:[],processes:[]};
const model=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');evidence.modelRequests.push({url:req.url,body});
 res.writeHead(200,{'content-type':'text/event-stream'});
 const send=(delta,finish=null)=>res.write('data: '+JSON.stringify({id:'fixture-'+evidence.modelRequests.length,object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
 send({role:'assistant'});
 const last=body.messages?.at(-1), serialized=JSON.stringify(last);
 if(serialized.includes('[hold]')){send({content:'holding deterministic stream'});res.on('close',()=>{evidence.holdClosed=true});return;}
 if((serialized.includes('[question]') || serialized.includes('[manual-question]')) && last?.role==='user'){const manual=serialized.includes('[manual-question]');send({tool_calls:[{index:0,id:'qa-tool-call-'+evidence.modelRequests.length,type:'function',function:manual&&questionnaireSource?{name:'ask_user_question',arguments:JSON.stringify({questions:[{question:'Review authorization',header:'Review',options:[{label:'Allow one reviewer',description:'One isolated reviewer'},{label:'No new session',description:'Keep existing sessions'}],multiSelect:false}]})}:{name:'qa_question',arguments:JSON.stringify({manual})}}]});send({},'tool_calls');res.end('data: [DONE]\n\n');return;}
 if(serialized.includes('[burst]')){for(let i=0;i<700;i++)send({content:'x'});send({},'stop');res.end('data: [DONE]\n\n');return;}
 send({content:'deterministic local answer'});send({},'stop');res.end('data: [DONE]\n\n');
});model.listen(0,'127.0.0.1');await once(model,'listening');
writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,api:'openai-completions',apiKey:'fixture-not-a-credential',models:[{id:'fixture-model',name:'Offline fixture',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048}]}}}));
writeFileSync(join(agent,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture-model',defaultThinkingLevel:'off',packages:[],compaction:{enabled:false}}));
mkdirSync(join(agent,'extensions'),{recursive:true});
writeFileSync(join(agent,'extensions','qa-question.ts'),`export default function(pi){pi.registerTool({name:'qa_question',label:'Fixture question',description:'Deterministic test question only',parameters:{type:'object',properties:{manual:{type:'boolean'}}},async execute(id,args,signal,onUpdate,ctx){if(args.manual){const selected=await ctx.ui.select('Review authorization',['Allow one reviewer','Manual reply']);const answer=selected==='Manual reply'?await ctx.ui.input('Manual authorization response'):selected;return {content:[{type:'text',text:JSON.stringify({selected,answer})}],details:{selected,answer}}}const confirmed=await ctx.ui.confirm('QA question','Confirm fixture answer?');return {content:[{type:'text',text:JSON.stringify({confirmed})}],details:{confirmed}}}})}`);
if(questionnaireSource){writeFileSync(join(agent,'extensions','original-questionnaire.ts'),`export {default} from ${JSON.stringify(join(questionnaireSource,'index.ts'))};`);evidence.originalQuestionnaire={version:'2.13.8',source:questionnaireSource};}
const guard=join(root,'network-guard.mjs');writeFileSync(guard,`const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('QA_BLOCKED_EXTERNAL:'+url.origin);return original(input,options)};`);
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));const base=`http://127.0.0.1:${port}`;
let child;
async function start(){const log=createWriteStream(join(root,'reader-'+evidence.processes.length+'.log'));child=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:repo,env:{PATH:process.env.PATH,HOME:home,XDG_CACHE_HOME:join(home,'cache'),NODE_OPTIONS:'--import='+guard,NEXT_TELEMETRY_DISABLED:'1',PI_CODING_AGENT_DIR:agent,PI_WEB_PASSWORD:'',PI_WEB_SESSION_ACTIVITY_CONFIG:JSON.stringify({device:{id:'qa-device',name:'QA'},peers:[]}),PI_WEB_CONTROL_RECEIPT_ROOT:join(home,'receipts'),PI_WEB_QUEUE_RECALL_ROOT:join(home,'recalls')},stdio:['ignore','pipe','pipe']});child.stdout.pipe(log);child.stderr.pipe(log);evidence.processes.push({pid:child.pid,start:Date.now()});for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Reader exited '+child.exitCode);if((await fetch(base+'/api/reader/runtime-catalog',{signal:AbortSignal.timeout(3000)}).catch(()=>null))?.ok)return;await delay(100)}throw new Error('startup timeout');}
async function api(path,body){const response=await fetch(base+path,{signal:AbortSignal.timeout(30000),method:body?'POST':'GET',headers:{'content-type':'application/json',origin:base},...(body?{body:JSON.stringify(body)}:{})});const text=await response.text();let data;try{data=JSON.parse(text)}catch{data={raw:text.slice(0,500)}}evidence.requests.push({path,body,status:response.status,data});writeFileSync(join(evidence.root,'evidence.json'),JSON.stringify(evidence,null,2));return {status:response.status,data};}
async function stop(){const stopping=child;if(stopping&&stopping.exitCode===null&&stopping.signalCode===null){const exited=once(stopping,'exit');const timer=setTimeout(()=>stopping.kill('SIGKILL'),10000);stopping.kill('SIGTERM');try{await exited;}finally{clearTimeout(timer);}}}
const control=(type,idempotencyKey,extra={})=>({type,readerMcpControl:true,deviceId:'qa-device',dryRun:false,confirm:true,confirmationReason:'isolated cloud QA',idempotencyKey,...extra});
const until=async(fn,label)=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await delay(100)}throw new Error('Timeout '+label)};
evidence.cases=[];const check=async(name,fn)=>{try{await fn();evidence.cases.push({name,passed:true});console.log('PASS '+name)}catch(error){evidence.cases.push({name,passed:false,error:String(error.stack||error),cause:error.cause?{message:error.cause.message,code:error.cause.code,stack:error.cause.stack}:null});console.log('FAIL '+name+' '+error.message)}writeFileSync(join(evidence.root,'evidence.json'),JSON.stringify(evidence,null,2))};

const SERVER=join(repo,'packages/reader-mcp/server.mjs');
function startClient(root) {
  const options = arguments[1] ?? {};
  const childEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  if (options.env && typeof options.env === "object") Object.assign(childEnv, options.env);
  if (options.url) {
    delete childEnv.PI_WEB_READER_DATA_ROOT;
    childEnv.PI_WEB_READER_URL = options.url;
    delete childEnv.PI_WEB_READER_DEVICE_NAME;
  } else {
    childEnv.PI_WEB_READER_DATA_ROOT = root;
    delete childEnv.PI_WEB_READER_URL;
    childEnv.PI_WEB_READER_DEVICE_NAME = "fixture-mac-mini";
  }
  const child = spawn(process.execPath, [SERVER], {
    env: {PATH:process.env.PATH,HOME:home,PI_WEB_READER_URL:options.url,NODE_OPTIONS:'--import='+guard},
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = new Set();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectAll(new Error(`non-JSON stdout from MCP: ${line}`));
        continue;
      }
      if (message.method === 'notifications/resources/updated') {
        notifications.push(message); evidence.notifications ??= []; evidence.notifications.push(message);
        for (const listener of notificationWaiters) listener(message);
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    rejectAll(new Error(`MCP exited before response (code=${code}, signal=${signal})`));
  });

  return {
    get notifications() { return notifications; },
    waitNotification(uri, after = notifications.length) {
      const existing = notifications.slice(after).find(message => message.params?.uri === uri);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve,reject) => {
        const listener = message => { if (message.params?.uri !== uri) return; clearTimeout(timer); notificationWaiters.delete(listener); resolve(message); };
        const timer = setTimeout(() => { notificationWaiters.delete(listener); reject(new Error('No resource notification')); },15000);
        notificationWaiters.add(listener);
      });
    },
    get stderr() {
      return stderr;
    },
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request timeout: '+method));},45000);
        pending.set(id, { resolve:value=>{clearTimeout(timer);resolve(value);}, reject:error=>{clearTimeout(timer);reject(error);} });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    },
    async tool(name, args) {
      const result = await this.call("tools/call", { name, arguments: args });
      assert.ok(Array.isArray(result.content));
      const payload = JSON.parse(result.content[0].text);evidence.mcpCalls.push({name,args,payload});writeFileSync(join(evidence.root,'evidence.json'),JSON.stringify(evidence,null,2));
      if (result.isError) return { ...payload, __toolError: true };
      return payload;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      await once(child, "exit");
    },
  };

  function rejectAll(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
}

evidence.mcpCalls=[];let client;
try{
 await start();await api('/api/projects',{cwd:project});client=startClient(undefined,{url:base});
 evidence.initialize=await client.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'isolated-real-reader',version:'1'}});await client.notify('notifications/initialized',{});
 evidence.tools=await client.call('tools/list',{});assert.equal(evidence.tools.tools.length,8);
 const common={deviceId:'qa-device',dryRun:false,confirm:true,confirmationReason:'isolated cloud fixture'};
 const command=(action,idempotencyKey,extra={})=>client.tool('reader_session_control',{...common,action,idempotencyKey,...extra});
 await check('MCP fresh restricted create then prompt without HTTP seed',async()=>{
  const made=await command('create_session','mcp-restricted-create',{cwd:project,provider:'fixture',modelId:'fixture-model',thinkingLevel:'off',toolNames:[],strictToolAllowlist:true});assert.equal(made.readerOutcome,'completed',JSON.stringify(made));const sid=made.createdSessionId;
  const sent=await command('prompt','mcp-restricted-prompt',{sessionId:sid,message:'restricted fixture prompt'});assert.equal(sent.transportAccepted,true,JSON.stringify(sent));
  await until(async()=>{const p=await client.tool('reader_read_live_events',{sessionId:sid,device:'qa-device'});return p.found&&!p.isStreaming&&!p.isPromptRunning},'restricted completion');
  const state=await client.tool('reader_session_control',{action:'inspect',deviceId:'qa-device',sessionId:sid});assert.equal(state.outcome,'observed');assert.equal(state.state.strictToolAllowlist,true);evidence.restrictedCreatedSessionId=sid;
 });
 const created=await command('create_session','mcp-create-0001',{cwd:project,provider:'fixture',modelId:'fixture-model',thinkingLevel:'off'});assert.equal(created.readerOutcome,'completed',JSON.stringify(created));const id=created.createdSessionId,route='/api/agent/'+id;
 const seed=await api(route,control('prompt','fixture-setup-seed',{message:'Fixture existing session setup'}));assert.equal(seed.status,200);await until(async()=>{const r=(await api(route+'/live')).data;return !r.isStreaming&&!r.isPromptRunning},'fixture seed settled');
 const inventory=await client.tool('reader_list_sessions',{scope:'active',visibility:'all',limit:500});assert.ok(inventory.sessions.some(s=>s.id===id));const metadata=await client.tool('reader_get_session_metadata',{sessionId:id,device:'qa-device'});assert.equal(metadata.found,true,JSON.stringify(metadata));
 const cmd=(action,key,extra={})=>command(action,key,{sessionId:id,...extra});
 const live=(extra={})=>client.tool('reader_read_live_events',{sessionId:id,device:'qa-device',...extra});
 const inspect=()=>client.tool('reader_session_control',{action:'inspect',deviceId:'qa-device',sessionId:id});
 const settled=()=>until(async()=>{const s=await live();return !s.isPromptRunning&&!s.isStreaming?s:null},'MCP settled');
 const image={data:'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',mimeType:'image/gif'};
 await check('MCP images reach real SDK provider and persisted session',async()=>{
  const sent=await cmd('prompt','mcp-image-0001',{message:'fixture image',images:[image]});assert.equal(sent.transportAccepted,true,JSON.stringify(sent));await settled();assert.ok(evidence.modelRequests.some(r=>JSON.stringify(r.body).includes('data:image/gif;base64,'+image.data)));
  const tail=await client.tool('reader_read_tail',{sessionId:id,device:'qa-device'});evidence.sessionFile=tail.sessionFilePath;assert.ok(evidence.sessionFile);assert.ok(readFileSync(evidence.sessionFile,'utf8').includes(image.data));
 });
 let hold;
 await check('MCP clear queue CAS/replay preserves active run and durable removed receipt',async()=>{
  hold=await cmd('prompt','mcp-hold-0001',{message:'[hold]'});assert.equal(hold.transportAccepted,true);await until(()=>evidence.modelRequests.some(r=>JSON.stringify(r.body.messages?.at(-1)).includes('[hold]')),'hold');
  const queued=await cmd('follow_up','mcp-queue-0001',{message:'queued image',images:[image]});assert.equal(queued.transportAccepted,true);
  const before=await inspect();assert.equal(before.state.queueCounts.total,1,JSON.stringify(before));const boot=(await live()).bootId;
  const stale=await cmd('clear_queue','mcp-clear-stale',{expectedBootId:boot,expectedQueueRevision:'0'.repeat(64)});assert.equal(stale.transportAccepted,false);assert.equal((await inspect()).state.queueCounts.total,1);
  const args={expectedBootId:boot,expectedQueueRevision:before.state.queueRevision};const clear=await cmd('clear_queue','mcp-clear-good',args);assert.equal(clear.transportAccepted,true,JSON.stringify(clear));const after=await inspect();assert.equal(after.state.queueCounts.total,0);assert.equal((await live()).isPromptRunning,true);assert.notEqual(after.state.queueRevision,before.state.queueRevision);
  const replay=await cmd('clear_queue','mcp-clear-good',args);assert.equal(replay.receiptId,clear.receiptId);
  const receipt=await api(route+'/receipt?receiptId='+queued.readerReceipt.receiptId);assert.equal(receipt.data.outcome,'aborted');
 });
 await check('MCP stop observes targetStopped and same-run settled',async()=>{const stopped=await cmd('stop','mcp-stop-0001');assert.equal(stopped.targetStopped,true,JSON.stringify(stopped));const state=await settled();assert.ok(state.events.some(r=>r.event.type==='agent_settled'&&r.event.runId===hold.readerReceipt.runId&&r.event.aborted===true));});
 await check('MCP resource subscription, complete pending snapshot and manual input resume real SDK',async()=>{
  const uri=`reader://ui-requests/qa-device/${id}`;
  await client.call('resources/subscribe',{uri});
  const initial=JSON.parse((await client.call('resources/read',{uri})).contents[0].text);assert.deepEqual(initial.requests,[]);
  const from=client.notifications.length;
  const notice=client.waitNotification(uri,from);
  assert.equal((await cmd('prompt','mcp-manual-question',{message:'[manual-question]'})).transportAccepted,true);
  await notice;
  let snapshot=JSON.parse((await client.call('resources/read',{uri})).contents[0].text);
  assert.equal(snapshot.requests.length,1);assert.equal(snapshot.requests[0].method,'select');
  const req=snapshot.requests[0];assert.deepEqual(req.options,questionnaireSource?['1. Allow one reviewer — One isolated reviewer','2. No new session — Keep existing sessions','3. Type something.']:['Allow one reviewer','Manual reply']);
  const invalid=await cmd('answer_question','mcp-invalid-option',{questionId:req.id,runtimeGeneration:snapshot.runtimeGeneration,answer:'invented'});
  assert.equal(invalid.readerResponse.code,'ui_response_invalid');
  const after=client.notifications.length;const nextNotice=client.waitNotification(uri,after);
  const answered=await cmd('answer_question','mcp-select-manual',{questionId:req.id,runtimeGeneration:snapshot.runtimeGeneration,answer:questionnaireSource?'3. Type something.':'Manual reply'});
  assert.equal(answered.readerResponse.data.status,'accepted');await nextNotice;
  snapshot=await live({mode:'wait_ui_requests',runtimeGeneration:snapshot.runtimeGeneration,revision:snapshot.revision,timeoutMs:10000});
  // Closing the select and opening input are separate legitimate revisions.
  if(!snapshot.requests.length) snapshot=await live({mode:'wait_ui_requests',runtimeGeneration:snapshot.runtimeGeneration,revision:snapshot.revision,timeoutMs:10000});
  assert.equal(snapshot.requests[0].method,'input');assert.equal(snapshot.requests[0].responseSchema.allowFreeText,true);
  const typed='Keep the existing reviewer. Do not create another session.';
  assert.equal((await cmd('answer_question','mcp-manual-input',{questionId:snapshot.requests[0].id,runtimeGeneration:snapshot.runtimeGeneration,answer:typed})).readerResponse.data.status,'accepted');
  await settled();assert.ok(evidence.modelRequests.some(r=>r.body.messages?.some(m=>m.role==='tool'&&m.content.includes(typed))));
  assert.deepEqual(JSON.parse((await client.call('resources/read',{uri})).contents[0].text).requests,[]);
  await client.call('resources/unsubscribe',{uri});
 });
 await check('MCP question request and deterministic answer through real SDK',async()=>{assert.equal((await cmd('prompt','mcp-question-0001',{message:'[question]'})).transportAccepted,true);const request=await until(async()=>{const s=await live({mode:'ui_requests'});return s.requests?.find(r=>r.method==='confirm')},'current confirm question');assert.equal((await cmd('answer_question','mcp-answer-0001',{questionId:request.id,runtimeGeneration:request.runtimeGeneration,confirmed:true})).transportAccepted,true);await settled();assert.ok(evidence.modelRequests.some(r=>r.body.messages?.some(m=>m.role==='tool'&&m.content.includes('true'))));});
 await check('MCP real producer retention gap and explicit resume',async()=>{
  const sid=evidence.restrictedCreatedSessionId;assert.ok(sid);assert.equal((await command('prompt','mcp-burst',{sessionId:sid,message:'[burst]'})).transportAccepted,true);
  await until(()=>evidence.modelRequests.some(r=>JSON.stringify(r.body.messages?.at(-1)).includes('[burst]')),'burst started');
  await until(async()=>{const p=await client.tool('reader_session_control',{action:'inspect',deviceId:'qa-device',sessionId:sid});return p.state&&!p.state.isStreaming&&!p.state.isPromptRunning},'burst complete');
  const gap=await client.tool('reader_read_live_events',{sessionId:sid,device:'qa-device',cursor:0});assert.equal(gap.code,'gap',JSON.stringify(gap));evidence.mcpGap=gap;
  const recovered=await client.tool('reader_read_live_events',{sessionId:sid,device:'qa-device',cursor:gap.recoverFromCursor,maxEvents:1});assert.ok(recovered.events.length===1);assert.equal(recovered.truncated,true);
 });
 let configReceipt;
 const target={area:'tools_settings',scope:'global',deviceId:'qa-device'};
 await check('MCP real config editor CAS and durable idempotency',async()=>{const snapshot=await client.tool('reader_read_control_plane',{...target,managed:true});assert.equal(snapshot.outcome,'observed');const args={...target,...common,operation:'set_codemode',codemode:'always',expectedBootId:snapshot.bootId,expectedRevision:snapshot.revision,idempotencyKey:'mcp-config-0001'};configReceipt=await client.tool('reader_write_control_plane',args);assert.equal(configReceipt.outcome,'completed',JSON.stringify(configReceipt));const replay=await client.tool('reader_write_control_plane',args);assert.equal(replay.readerReceipt.receiptId,configReceipt.readerReceipt.receiptId);const stale=await client.tool('reader_write_control_plane',{...args,idempotencyKey:'mcp-config-stale',codemode:'automatic'});assert.equal(stale.code,'revision_conflict');assert.equal(stale.accepted,false);assert.deepEqual(JSON.parse(readFileSync(join(agent,'settings.json'),'utf8')).defaultTools,['+codemode']);});
 await check('MCP restart durable cursor replay then three stable idle polls',async()=>{const before=await live();const count=evidence.modelRequests.length;await client.close();client=null;await stop();await start();client=startClient(undefined,{url:base});await client.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'restart-client',version:'1'}});await client.notify('notifications/initialized',{});const changed=await live({bootId:before.bootId,cursor:before.nextCursor});assert.equal(changed.code,'boot_changed',JSON.stringify(changed));let recovered=await live({cursor:0});assert.equal(recovered.source,'reader-durable-live-ledger');assert.equal(recovered.runtimeStatus,'not_live');assert.ok(recovered.events.length>0);evidence.recovered=recovered;const diskHashes=()=>Object.fromEntries([evidence.sessionFile,...readdirSync(join(agent,'live-event-ledger')).filter(f=>f.endsWith('.jsonl')).map(f=>join(agent,'live-event-ledger',f))].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));const beforeIdle=diskHashes();evidence.stablePolls=[];let cursor=recovered.nextCursor;for(let i=0;i<4;i++){const p=await live({bootId:recovered.bootId,cursor});assert.equal(p.bootId,recovered.bootId);assert.equal(p.runtimeStatusSemantics.runtimeStartAttempted,false);cursor=p.nextCursor;if(i>0)assert.equal(p.events.length,0);evidence.stablePolls.push({bootId:p.bootId,cursor,events:p.events.length});}assert.deepEqual(diskHashes(),beforeIdle);evidence.idleFileHashes=beforeIdle;assert.equal((await live({cursor:cursor+100})).code,'cursor_ahead');assert.equal((await live({cursor:0,maxEvents:1})).truncated,true);await client.tool('reader_list_sessions',{scope:'active',visibility:'all'});await client.tool('reader_get_session_metadata',{sessionId:id,device:'qa-device'});assert.equal((await inspect()).running,false);assert.equal(evidence.modelRequests.length,count);const receipt=await client.tool('reader_get_control_plane_receipt',{...target,receiptId:configReceipt.readerReceipt.receiptId});assert.equal(receipt.readerReceipt.outcome,'completed',JSON.stringify(receipt));});
 if(evidence.cases.some(c=>!c.passed))process.exitCode=1;console.log(JSON.stringify({root,cases:evidence.cases,modelCalls:evidence.modelRequests.length}));

} catch(error){evidence.error=String(error.stack||error);console.error(error);process.exitCode=1;}finally{if(client)await client.close();await stop();await new Promise(r=>model.close(r));writeFileSync(join(evidence.root,'evidence.json'),JSON.stringify(evidence,null,2));console.log('EVIDENCE '+root)}
