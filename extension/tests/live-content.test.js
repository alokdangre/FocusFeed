"use strict";
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const path=require("node:path");
class Element {
  constructor(tag="div"){this.tagName=tag;this.children=[];this.dataset={};this.textContent="";this.isConnected=true;this.listeners={};}
  appendChild(child){child.parent=this;this.children.push(child);return child;}
  attachShadow(){return this.appendChild(new Element("shadow"));}
  addEventListener(type,fn){this.listeners[type]=fn;}
  querySelector(){return this.children.find(x=>x.className==="focusfeed-live-label") || null;}
  remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  removeAttribute(name){delete this.dataset[name.replace(/^data-/,"").replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];}
  getBoundingClientRect(){return {top:50,bottom:200};}
  closest(){return null;}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  const documentElement=new Element("html");
  const document={documentElement,createElement:tag=>new Element(tag),getElementById:id=>documentElement.children.find(x=>x.id===id),querySelector:()=>null};
  const listeners={}; const sent=[]; const network=[]; let onConnect;
  const window={location:{pathname:"/"},addEventListener:(type,fn)=>{(listeners[type] ||= []).push(fn);},postMessage:m=>network.push(m)};
  const chrome={runtime:{getURL:p=>"chrome-extension://test/"+p,onConnect:{addListener:fn=>onConnect=fn}}};
  const ctx=vm.createContext({window,document,chrome,innerHeight:800,setTimeout,clearTimeout,console});
  for(const file of ["workflow-core.js","live/engine.js","live/content.js"])vm.runInContext(fs.readFileSync(path.join(__dirname,"..",file),"utf8"),ctx);
  let receive,disconnect;
  // tabs.connect() already targets this content script. Chrome does not promise
  // the connecting extension page URL in Port.sender at this receiving end.
  const port={name:"focusfeed-live",sender:{},postMessage:m=>sent.push(m),
    onMessage:{addListener:fn=>receive=fn},onDisconnect:{addListener:fn=>disconnect=fn}};
  const cards=Array.from({length:14},(_,i)=>({card:new Element(),video:{videoId:"v"+i,title:"Video "+i,channel:"Lessons"}}));
  let adapter;
  const scan=()=>cards.forEach(x=>adapter.observe(x.card,x.video));
  let allow=false;
  adapter=ctx.FocusFeedLiveContent.create({scan,rule:()=>allow?{route:"rule",action:"show"}:null});
  onConnect(port);assert.equal(sent[0].type,"HELLO");
  receive({type:"HELLO_REQUEST"});
  assert.equal(sent.filter(message=>message.type==="HELLO").length,2,"an explicit handshake request must get a reply");
  receive({type:"START",runId:"r1"});await sleep(100);
  function findByText(node,text){if(node.textContent===text)return node;for(const child of node.children||[]){const found=findByText(child,text);if(found)return found;}return null;}
  const loadMoreControl=findByText(documentElement,"Load 12 more");
  assert.ok(loadMoreControl,"YouTube must render the primary Load more control");
  loadMoreControl.listeners.click({isTrusted:true});
  assert.equal(sent.at(-1).type,"LOAD_MORE");
  assert.equal(sent.filter(m=>m.type==="CANDIDATES")[0].candidates.length,12);
  assert.equal(cards[12].card.dataset.focusfeedDeferred,"true");
  const fp=ctx.FocusFeedLiveEngine.fingerprint(cards[0].video);
  receive({type:"RESULT",runId:"r1",record:{video:cards[0].video,fingerprint:fp,action:"hide",route:"model",status:"resolved",reason:"Unrelated"}});
  assert.equal(cards[0].card.dataset.focusfeedAiHidden,undefined,"preview cannot hide");
  receive({type:"MODE",runId:"r1",applyHides:true});
  assert.equal(cards[0].card.dataset.focusfeedAiHidden,"true");
  assert.equal(cards[12].card.dataset.focusfeedDeferred,"true","a hide must not refill admission");
  adapter.observe(cards[0].card,{title:"Loading a new card"});
  assert.equal(cards[0].card.dataset.focusfeedAiHidden,undefined,"a recycled card with unknown identity must stay visible");
  allow=true;scan();assert.equal(cards[0].card.dataset.focusfeedAiHidden,undefined,"current explicit allow overrides semantic result");allow=false;
  receive({type:"RESTORE",runId:"r1",videoId:"v0"});assert.equal(cards[0].card.dataset.focusfeedAiHidden,undefined);
  cards[1].video.title="New meaning";
  receive({type:"RESULT",runId:"r1",record:{video:{videoId:"v1"},fingerprint:ctx.FocusFeedLiveEngine.fingerprint({videoId:"v1",title:"Video 1",channel:"Lessons"}),action:"hide",route:"model",status:"resolved",reason:"Old title"}});
  assert.equal(cards[1].card.dataset.focusfeedAiHidden,undefined,"late old-metadata result cannot hide a current card");
  receive({type:"MORE",runId:"r1",allowance:24});await sleep(230);
  assert.equal(cards[12].card.dataset.focusfeedDeferred,undefined);
  assert.equal(network.filter(m=>m.type==="FOCUSFEED_PAGE_GATE_MORE").length,1);
  receive({type:"RESULT",runId:"old",record:{video:{videoId:"v2"},fingerprint:ctx.FocusFeedLiveEngine.fingerprint(cards[2].video),action:"hide"}});
  assert.equal(cards[2].card.dataset.focusfeedAiHidden,undefined);
  disconnect();
  assert.equal(documentElement.dataset.focusfeedSession,undefined);
  assert.equal(cards.some(x=>x.card.dataset.focusfeedAiHidden||x.card.dataset.focusfeedDeferred),false);
  assert.equal(network.at(-1).enabled,false);
  console.log("live card adapter passed: finite admission, preview, hiding, allow precedence, restore, stale metadata, load more, disconnect");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
