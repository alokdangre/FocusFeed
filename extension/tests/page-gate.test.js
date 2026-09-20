"use strict";
const assert=require("node:assert/strict");
require("../page-gate.js");
const G=global.FocusFeedPageGate;
async function tick(){await Promise.resolve();await Promise.resolve();}
async function main(){
  const body=JSON.stringify({continuation:"abc"});
  assert.equal(G.isHomeContinuation("/youtubei/v1/browse",body,"https://www.youtube.com/"),true);
  for(const [url,payload,page] of [
    ["/youtubei/v1/next",body,"https://www.youtube.com/"],
    ["/youtubei/v1/browse",body,"https://www.youtube.com/watch?v=123"],
    ["/youtubei/v1/browse",body,"https://www.youtube.com/results?search_query=test"],
    ["/youtubei/v1/browse",JSON.stringify({browseId:"FEwhat_to_watch"}),"https://www.youtube.com/"],
    ["https://example.com/youtubei/v1/browse",body,"https://www.youtube.com/"],
    ["/youtubei/v1/browse","bad json","https://www.youtube.com/"]
  ]) assert.equal(G.isHomeContinuation(url,payload,page),false);
  const gate=G.create(); await gate.wait(); gate.configure(true);
  let sent=0; const first=gate.wait().then(()=>sent++); const second=gate.wait().then(()=>sent++);
  await tick(); assert.equal(sent,0); assert.equal(gate.state().waiting,2);
  gate.allowOne(); await first; assert.equal(sent,1); assert.equal(gate.state().waiting,1);
  gate.configure(false); await second; assert.equal(sent,2);
  gate.configure(true); gate.allowOne(); gate.allowOne(); gate.allowOne();
  await gate.wait(); assert.equal(gate.state().credits,0,"repeated clicks may bank only one network page");
  const abort=new AbortController(); const pending=gate.wait(abort.signal); abort.abort();
  await assert.rejects(pending,{name:"AbortError"}); assert.equal(gate.state().waiting,0);
  const navigation=gate.wait(); gate.configure(false,true); await assert.rejects(navigation,{name:"AbortError"});
  gate.configure(true); const limited=Array.from({length:4},()=>gate.wait());
  await assert.rejects(gate.wait(),{name:"AbortError"}); assert.equal(gate.state().waiting,4);
  gate.configure(false); await Promise.all(limited);
  console.log("Home pagination gate passed: scoped continuations, explicit release, abort, navigation, bounded waiting");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
