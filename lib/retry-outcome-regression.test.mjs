import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {continueRetryIndex,continueRetryMode,lastAssistantClassification} from './continue-logic.ts';
const source=fs.readFileSync(new URL('./rpc-manager.ts',import.meta.url),'utf8');
function method(start,end,context){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);const code=source.slice(a,b).replace(/^  private (async )?/,(_m,async)=>`${async??''}function `);return vm.runInNewContext(stripTypeScriptTypes(`(${code.trim()})`),context);}
test('resolved SDK continue with failed outcome records failure before settled',async()=>{
 const sequence=[];
 const context={continueRetryIndex,continueRetryMode,lastAssistantClassification,readFileSync:fs.readFileSync,console,
 recordSessionRunError:(sid,error,unattended,runId)=>sequence.push(['failed',sid,error,runId]),
 readModelRoutingConfig:async()=>null,getRouteMaxAttempts:()=>3};
 const failure=method('  private retryRunFailure()', '  private armSchedulerTimer(',context);
 const retry=method('  private async retryLastFailedTurn()', '  private normalizeQuestion(',context);
 const user={role:'user',content:'task'},error={role:'assistant',content:[],stopReason:'error',errorMessage:'HTTP 503 fixture'};
 const session={sessionId:'s',agent:{state:{messages:[user,error]},continue:async()=>{session.agent.state.messages.push(error);}},_isAgentRunActive:false,_handlePostAgentRun:async()=>false,_flushPendingBashMessages:()=>{},_emitAgentSettled:async()=>sequence.push(['settled'])};
 const wrapper={inner:session,sessionFile:null,abortRequested:false,currentRunId:'real-run',unattendedEnabled:false,routingCurrentProviderRetries:0,retryRunFailure(){return failure.call(this)},resetModelRoutingCycle(){throw Error('false success')},tryModelRoutingSwitch:async()=>{}};
 await retry.call(wrapper);
 assert.deepEqual(sequence,[['failed','s','HTTP 503 fixture','real-run'],['settled']]);
});
