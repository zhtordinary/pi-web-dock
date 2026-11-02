import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);const cache=await jiti.import('./session-view-cache.ts');const {emptyTranscript}=await jiti.import('./transcript-store.ts');
const scope=(sessionId,peer=null,leafId=undefined)=>({sessionId,peer,leafId});
const snapshot=(text='cached')=>({...emptyTranscript(),loaded:true,messages:[{role:'user',content:text}],entryIds:['saved']});
test('snapshot restores complete messages and ordered row metadata without a physical leaf or reading anchor',()=>{
 cache.clearHistoryViewCache();const state=snapshot();state.items.set('saved',{entryId:'saved',orderKey:[0,1,0],role:'user',message:state.messages[0],contentState:'full'});cache.setSessionViewSnapshot(scope('a'),state);
 assert.equal(cache.getSessionViewSnapshot(scope('a')),state);assert.equal('anchor' in cache.getSessionViewSnapshot(scope('a')),false);
});
test('snapshots never cross peer or explicit root/preview scopes',()=>{
 cache.clearHistoryViewCache();cache.setSessionViewSnapshot(scope('a'),snapshot());
 assert.equal(cache.getSessionViewSnapshot(scope('a','remote')),null);assert.equal(cache.getSessionViewSnapshot(scope('a',null,null)),null);assert.equal(cache.getSessionViewSnapshot(scope('a',null,'old')),null);
});
test('LRU has eight sessions and touches the returned snapshot',()=>{
 cache.clearHistoryViewCache();for(let i=0;i<8;i++)cache.setSessionViewSnapshot(scope(String(i)),snapshot());cache.getSessionViewSnapshot(scope('0'));cache.setSessionViewSnapshot(scope('8'),snapshot());
 assert.equal(cache.historyViewCacheStats().sessions,8);assert.ok(cache.getSessionViewSnapshot(scope('0')));assert.equal(cache.getSessionViewSnapshot(scope('1')),null);
});
test('byte cap rejects an oversized snapshot without limiting the active transcript',()=>{
 cache.clearHistoryViewCache();const state=snapshot('x'.repeat(cache.HISTORY_CACHE_MAX_BYTES));cache.setSessionViewSnapshot(scope('a'),state);assert.equal(cache.historyViewCacheStats().sessions,0);assert.equal(state.messages[0].content.length,cache.HISTORY_CACHE_MAX_BYTES);
});
test('inactive snapshots expire in ten minutes and clear drops all retained bytes',()=>{
 cache.clearHistoryViewCache();cache.setSessionViewSnapshot(scope('a'),snapshot());assert.equal(cache.cleanupHistoryViewCache(Date.now()+cache.HISTORY_CACHE_INACTIVE_TTL_MS+1),1);assert.equal(cache.historyViewCacheStats().bytes,0);cache.clearHistoryViewCache();
});
test('a distant historical interval is not restored as the latest opening',()=>{
 cache.clearHistoryViewCache();cache.setSessionViewSnapshot(scope('a'),{...snapshot(),after:'newer'});assert.equal(cache.getSessionViewSnapshot(scope('a')),null);
});
