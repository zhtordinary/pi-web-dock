import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {TranscriptViewport}=await createJiti(import.meta.url).import('./transcript-viewport.ts');
function harness(){
 const writes=[];let top=0;const rows=[0,1,2,3,4,5,6,7,8,9].map(i=>({dataset:{entryId:`e${i}`},isConnected:true,y:i*100,getBoundingClientRect(){return {top:this.y-top,bottom:this.y-top+100};}}));
 const container={scrollHeight:1000,clientHeight:200,get scrollTop(){return top;},set scrollTop(v){top=v;},getBoundingClientRect:()=>({top:0}),querySelectorAll:()=>rows,scrollTo({top:value}){top=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));writes.push(top);}};
 const changes=[];const viewport=new TranscriptViewport(()=>container,v=>changes.push(v));return {viewport,container,rows,writes,changes};
}
test('prepend preserves the currently visible row including scrolling during the request',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[4],17);h.container.scrollTop+=30;h.viewport.onScroll();const before=h.rows[4].getBoundingClientRect().top;
 h.viewport.commit(()=>{for(const row of h.rows)row.y+=400;h.container.scrollHeight+=400;});assert.equal(h.rows[4].getBoundingClientRect().top,before);assert.ok(h.container.scrollTop>0);
});
test('rapid upward native scrolling never loses the current row during consecutive prepends',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[8]);for(let n=0;n<20;n++){h.container.scrollTop-=20;h.viewport.onScroll();const row=h.rows.find(row=>row.getBoundingClientRect().bottom>0);const before=row.getBoundingClientRect().top;h.viewport.commit(()=>{h.rows.forEach(row=>row.y+=100);h.container.scrollHeight+=100;});assert.equal(row.getBoundingClientRect().top,before);}
});
test('following growth stays at the bottom while upward native scrolling detaches',()=>{
 const h=harness();h.viewport.scrollToBottom();h.viewport.commit(()=>h.container.scrollHeight+=300);assert.equal(h.container.scrollTop,1100);
 h.container.scrollTop=400;h.viewport.onScroll();assert.equal(h.viewport.follow,false);h.viewport.commit(()=>h.container.scrollHeight+=200);assert.equal(h.container.scrollTop,400);
});
test('downward native movement near the tail reattaches without a reading-intent state',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[2]);assert.equal(h.viewport.follow,false);h.container.scrollTop=750;h.viewport.onScroll();assert.equal(h.viewport.follow,true);
});
test('image/markdown reflow uses the same visible-row restoration as data commit',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[4],12);h.rows.forEach(row=>row.y+=150);h.container.scrollHeight+=150;h.viewport.resize();assert.equal(h.rows[4].getBoundingClientRect().top,12);
});
test('programmatic navigation synchronizes previousScrollTop so its own scroll event is not user input',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[4],16,true);h.viewport.onScroll();assert.equal(h.viewport.follow,true);assert.equal(h.rows[4].getBoundingClientRect().top,16);
});
test('programmatic question landing at the physical tail stays detached until native downward movement',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[8],0,false);h.viewport.onScroll();assert.equal(h.viewport.follow,false);
 h.container.scrollHeight+=500;h.viewport.resize();assert.equal(h.container.scrollTop,800);assert.equal(h.viewport.follow,false);
 h.container.scrollTop=1300;h.viewport.onScroll();assert.equal(h.viewport.follow,true);
});
test('a detached viewport is not moved by settle without a layout change',()=>{
 const h=harness();h.viewport.scrollToEntry(h.rows[3]);const before=h.container.scrollTop;h.viewport.commit(()=>{});assert.equal(h.container.scrollTop,before);
});
