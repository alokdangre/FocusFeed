"use strict";
// Exercise the real MAIN-world wrapper with fake fetch/XHR, without a browser.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function main() {
  const listeners = {};
  const fetches = [];
  const xhrSends = [];
  const window = {
    location: { href: "https://www.youtube.com/", pathname: "/" },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    postMessage() {},
    fetch: async (...args) => { fetches.push(args); return new Response(JSON.stringify({ok:true}), {status:200}); },
  };
  class XHR {
    constructor() { this.listeners={}; }
    open(method,url) { this.url=url; }
    send(body) { xhrSends.push({url:this.url,body}); }
    abort() {}
    addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
    dispatchEvent(event) { (this.listeners[event.type] || []).forEach(fn=>fn(event)); }
  }
  const context=vm.createContext({window,XMLHttpRequest:XHR,history:{pushState(){}},Request,Response,URL,AbortController,DOMException,
    ProgressEvent:class {constructor(type){this.type=type;}},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,console:{log(){}}});
  for(const file of ["page-gate.js","interceptor.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname,"..",file),"utf8"),context);
  const message = data => listeners.message.forEach(fn=>fn({source:window,data}));
  const body=JSON.stringify({continuation:"next"});
  message({type:"FOCUSFEED_PAGE_GATE_CONFIG",enabled:true});
  const pending=window.fetch("/youtubei/v1/browse",{method:"POST",body});
  await tick(); assert.equal(fetches.length,0);
  await window.fetch("/youtubei/v1/browse",{method:"POST",body:JSON.stringify({browseId:"FEwhat_to_watch"})});
  await window.fetch("/youtubei/v1/next",{method:"POST",body});
  assert.equal(fetches.length,2,"initial Home and watch traffic remain functional");
  message({type:"FOCUSFEED_PAGE_GATE_MORE"}); await pending;
  assert.equal(fetches.length,3);
  const request=new Request("https://www.youtube.com/youtubei/v1/browse",{method:"POST",body});
  const byRequest=window.fetch(request); await tick(); assert.equal(fetches.length,3);
  message({type:"FOCUSFEED_PAGE_GATE_MORE"}); await byRequest; assert.equal(fetches.length,4);
  const xhr=new XHR(); xhr.open("POST","/youtubei/v1/browse"); xhr.send(body);
  await tick(); assert.equal(xhrSends.length,0);
  message({type:"FOCUSFEED_PAGE_GATE_MORE"}); await tick(); assert.equal(xhrSends.length,1);
  const aborted=new XHR(); aborted.open("POST","/youtubei/v1/browse"); aborted.send(body); aborted.abort();
  await tick(); message({type:"FOCUSFEED_PAGE_GATE_MORE"}); await tick(); assert.equal(xhrSends.length,1);
  // Consume the one unused credit, then verify navigation cancels held work.
  await window.fetch("/youtubei/v1/browse",{method:"POST",body});
  const oldPage=window.fetch("/youtubei/v1/browse",{method:"POST",body}); await tick();
  listeners["yt-navigate-start"].forEach(fn=>fn()); await assert.rejects(oldPage,{name:"AbortError"});
  window.location={href:"https://www.youtube.com/watch?v=one",pathname:"/watch"};
  message({type:"FOCUSFEED_PAGE_GATE_CONFIG",enabled:true});
  await window.fetch("/youtubei/v1/browse",{method:"POST",body});
  assert.equal(fetches.length,6,"watch-page browse calls must not wait on Home gate");
  console.log("pagination transport passed: actual fetch, Request, XHR, abort, navigation, non-Home isolation");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
