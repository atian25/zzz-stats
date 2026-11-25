#!/usr/bin/env node
/** 纯 SDK 契约回归：公开面只走根入口；网络、驱动、时钟均为 fake，不读消费者。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { login, collect, collectData, SdkError } from '../index.mjs';
import { createQrClock, waitForLogin } from '../qr-wait.mjs';
import { createNodeTransport } from '../transport-node.mjs';
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`✓ ${name}`); } catch(e) { fail++; console.error(`✗ ${name}`, e); } }
const rejects = (fn, code) => assert.rejects(fn, e => e instanceof SdkError && e.code === code);
const response = data => ({ ok:true, status:200, json:async()=>data, text:async()=>JSON.stringify(data), headers:{getSetCookie:()=>['cookie_token_v2=fake']} });
const empty = {retcode:0,data:{type_stats:[],list:[],cur_ver:'2.0'}};
const nodeSession = () => ({ channel:'node', gameUid:'10000001', region:'prod_gf_cn', cookieHeader:'a=1', close:async()=>{} });
const channel = {id:'2',enum:'GACHA_TYPE_CHARACTER_UP',label:'独家频段'};
function network(statuses=['Created','Scanned','Confirmed']) {
 let n=0; return async url => {
 if(url.includes('createQRLogin')) return response({retcode:0,data:{url:'https://example.test/qr',ticket:'fake'}});
 if(url.includes('queryQRLoginStatus')) return response({retcode:0,data:{status:statuses[Math.min(n++,statuses.length-1)],user_info:{aid:'10'}}});
 if(url.includes('getUserGameRolesByCookie')) return response({retcode:0,data:{list:[{region:'prod_gf_cn',game_uid:'10000001',nickname:'Test'}]}});
 return response(empty);
 }; }
const deps = {fetch:network(),sleep:async()=>{},encodeQr:async()=> 'data:image/png;base64,FAKE'};
function browser({loggedIn=false,frame=true,onOpen,qr=true,onEval}={}) {
 let checks=0; const calls=[];
 return {kind:'fake',calls,closeCount:0,
 async open(){calls.push('open');await onOpen?.();}, async close(){this.closeCount++;},
 async waitFor(){calls.push('waitFor');return {mounted:true,loggedOut:!loggedIn,hasUid:loggedIn};},
 async loginFrame(){return frame?{}:null;},
 async evaluate(e){calls.push('evaluate');if(onEval) return onEval(e);
 if(e.startsWith('fetch(')) return JSON.stringify(empty);
 if(e.includes('t.match(')) return '10000001';
 if(e.includes("split('\\n')")) return 'Test';
 if(e.includes("'logged-in' : null")) return ++checks>=2?'logged-in':null;
 return 'clicked';},
 async evaluateInFrame(_f,e){
 if(e.includes('hasPhone:')) return {hasPhone:true,hasCode:true,areaCode:'+86'};
 if(e.includes('const setter')) return 'ok';
 if(e.includes('hasQr:')) return {hasQr:qr,hash:'#/login/qr'};
 if(e.includes('return imgs[0]')) return qr?{src:'data:image/png;base64,FAKE',w:200,h:200}:null;
 return 'clicked';}
 }; }
await test('根入口恰好五名',async()=>assert.deepEqual(Object.keys(await import('../index.mjs')).sort(),['SdkError','collect','collectData','encodeQrDataUrl','login']));
for(const [name,options] of [
 ['Node SMS',{channel:'node',login:{method:'sms'}}],['Node 缺 onQr',{}],
 ['Node 刷新',{login:{onQr:()=>{},maxRefresh:1}}],['Node 刷新间隔',{login:{onQr:()=>{},minRefreshGapMs:10}}],
 ['Node 输入',{login:{onQr:()=>{},input:{requestPhone:()=>''}}}],['旧 transport',{transport:'node'}],['旧 cfg',{cfg:{}}],
]) await test(`${name} 在 I/O 前拒绝`,async()=>{let calls=0;await rejects(()=>login({...options,dependencies:{fetch:async()=>{calls++;}}}),'INVALID_ARGUMENT');assert.equal(calls,0);});
await test('Node 国际服不降级',()=>rejects(()=>login({region:'prod_gf_us',login:{onQr:()=>{}}}),'UNSUPPORTED_REGION'));
await test('网络失败保持原因且不降级',()=>assert.rejects(()=>collectData({login:{onQr:()=>{}},dependencies:{fetch:async()=>{throw Error('FAKE_NETWORK_DOWN')}}}),e=>e.code==='NETWORK_ERROR'&&e.cause.message==='FAKE_NETWORK_DOWN'));
await test('Node QR payload、扫码确认事件、只读身份及幂等 close',async()=>{
 const events=[],qrs=[]; const s=await login({login:{onQr:q=>qrs.push(q)},onProgress:e=>events.push(e),dependencies:{...deps,fetch:network()}});
 assert.deepEqual(Object.keys(qrs[0]),['dataUrl']); assert.equal(s.accountId,'10');
 for(const key of ['channel','gameUid','region']) assert.throws(()=>{s[key]='bad'},TypeError);
 assert.deepEqual(events.filter(e=>e.status!=='started').map(e=>e.status),['qr-issued','scanned','confirmed']);assert.equal(events[1].ttlMs,120000);
 await s.close();await s.close();assert.equal(s.cookieHeader,'');await rejects(()=>collect({session:s}),'INVALID_ARGUMENT');
});
await test('完整 Node 取数返回 13 键、独立 meta 与稳定顺序',async()=>{
 const r=await collectData({login:{onQr:()=>{}},dependencies:{...deps,fetch:network()}});
 assert.equal(r.files.size,13);assert.equal(r.files.has('meta.json'),false);assert.equal(r.meta.uid,r.gameUid);
 assert.deepEqual([...r.files.keys()],['index.json',...['2','102','3','103','1','5'].flatMap(id=>[`cur_pool_stat_${id}.json`,`hist_pool_stat_${id}.json`])]);
});
await test('自建 Node session 与频道子集可复用',async()=>{const s=nodeSession();for(let i=0;i<2;i++){const r=await collect({session:s,channels:[channel],dependencies:{fetch:async()=>response(empty),sleep:async()=>{}}});assert.equal(r.files.size,3)}});
await test('自建 browser session 被拒绝',()=>rejects(()=>collect({session:{...nodeSession(),channel:'browser'}}),'INVALID_ARGUMENT'));
await test('collect 缺 session 被拒绝',()=>rejects(()=>collect({}),'INVALID_ARGUMENT'));
await test('cur 原宽泛容错保留',async()=>{const r=await collect({session:nodeSession(),channels:[channel],dependencies:{fetch:async u=>{if(u.includes('cur_pool_stat'))throw Error('cur failed');return response(empty)},sleep:async()=>{}}});assert.deepEqual(r.files.get('cur_pool_stat_2.json'),{retcode:0,data:{list:[]}})});
await test('hist 分片、降序及四元组去重',async()=>{
 const vers=Array.from({length:12},(_,i)=>`1.${i}`),queries=[];const pool={gacha_type:2,version:'1.0',start_ts:1,end_ts:2};
 const r=await collect({session:nodeSession(),channels:[channel],dependencies:{sleep:async()=>{},fetch:async u=>{
 const url=new URL(u);if(url.pathname.endsWith('/index'))return response({retcode:0,data:{type_stats:[{gacha_type:channel.enum,has_data_vers:vers}]}});
 if(url.pathname.endsWith('/hist_pool_stat')){queries.push(url.searchParams.get('vers'));return response({retcode:0,data:{list:[pool]}})}return response(empty);
 }}});assert.equal(queries.length,2);assert.equal(queries[0].split(',').length,10);assert.equal(queries[0].split(',')[0],'1.11');assert.equal(r.files.get('hist_pool_stat_2.json').data.list.length,1);
});
for(const [name,loggedIn] of [['已有 browser 登录态',true],['browser QR 实际流程',false]]) await test(`${name} 省略 onQr`,async()=>{const d=browser({loggedIn});const s=await login({channel:'browser',browser:{driver:d},dependencies:{sleep:async()=>{}}});assert.equal(s.gameUid,'10000001');await s.close();await s.close();assert.equal(d.closeCount,0)});
await test('browser QR 回调 await 且仅 dataUrl',async()=>{let delivered=false;const d=browser();await login({channel:'browser',browser:{driver:d},login:{onQr:async q=>{assert.deepEqual(Object.keys(q),['dataUrl']);await Promise.resolve();delivered=true}},dependencies:{sleep:async()=>{}}});assert.ok(delivered)});
await test('browser SMS 号码回调、发送一次、确认事件',async()=>{let phone=0,code=0;const statuses=[];const d=browser();await login({channel:'browser',browser:{driver:d},login:{method:'sms',input:{requestPhone:async()=>{phone++;return '13800000000'},requestCode:async()=>{code++;return '123456'}}},dependencies:{sleep:async()=>{}},onProgress:e=>statuses.push(e.status)});assert.equal(phone,1);assert.equal(code,1);assert.ok(statuses.includes('confirmed'))});
await test('人工确认不是登录成功，回调后继续检测并超时',async()=>{let time=0,manual=0,checks=0;const d=browser({frame:false,onEval:e=>{if(e.includes("'logged-in' : null")){checks++;return null}return 'clicked'}});await rejects(()=>login({channel:'browser',browser:{driver:d},login:{maxWaitMs:30,pollMs:10,input:{requestManualAction:async c=>{assert.equal(c.reason,'login-frame-unavailable');manual++}}},dependencies:{now:()=>time,sleep:async ms=>{time+=ms}}}),'LOGIN_TIMEOUT');assert.equal(manual,1);assert.equal(checks,3)});
await test('人工操作后真实登录才返回 session',async()=>{let checks=0;const d=browser({frame:false,onEval:e=>e.includes("'logged-in' : null")?(++checks>=2?'logged-in':null):e.includes('t.match(')?'10000001':'Test'});const s=await login({channel:'browser',browser:{driver:d},login:{input:{requestManualAction:()=>{}}},dependencies:{sleep:async()=>{}}});assert.equal(checks,2);assert.equal(s.gameUid,'10000001')});
await test('缺人工操作回调明确 INPUT_REQUIRED',()=>rejects(()=>login({channel:'browser',browser:{driver:browser({frame:false})},dependencies:{sleep:async()=>{}}}),'INPUT_REQUIRED'));
await test('人工操作回调失败包装 CALLBACK_FAILED',()=>rejects(()=>login({channel:'browser',browser:{driver:browser({frame:false})},login:{input:{requestManualAction:()=>{throw Error('secret')}}},dependencies:{sleep:async()=>{}}}),'CALLBACK_FAILED'));
await test('短信缺输入明确 INPUT_REQUIRED',()=>rejects(()=>login({channel:'browser',browser:{driver:browser()},login:{method:'sms'},dependencies:{sleep:async()=>{}}}),'INPUT_REQUIRED'));
await test('短信页面结构错误分类',async()=>{const d=browser();d.evaluateInFrame=async()=>({});await rejects(()=>login({channel:'browser',browser:{driver:d},login:{method:'sms',input:{requestPhone:()=> '13800000000',requestCode:()=> '123456'}},dependencies:{sleep:async()=>{}}}),'BROWSER_PAGE_CHANGED')});
await test('短信保留 60000ms 登录检测窗口',async()=>{let t=0;const d=browser({onEval:()=>null});await rejects(()=>login({channel:'browser',browser:{driver:d},login:{method:'sms',input:{requestPhone:()=> '13800000000',requestCode:()=> '123456'}},dependencies:{now:()=>t,sleep:async ms=>{t+=ms}}}),'LOGIN_TIMEOUT');assert.equal(t,60000)});
await test('browser 永不结束 open 可取消且不再调用后续动作',async()=>{const ac=new AbortController();let release,entered;const ready=new Promise(r=>entered=r);const d=browser({onOpen:()=>{entered();return new Promise(r=>release=r)}});const p=login({channel:'browser',browser:{driver:d},signal:ac.signal});await ready;ac.abort();await rejects(()=>p,'ABORTED');release();await Promise.resolve();assert.deepEqual(d.calls,['open']);assert.equal(d.closeCount,0)});
await test('browser QR 取消恰好退订一次',async()=>{const ac=new AbortController();let unsub=0;const d=browser({onEval:()=>null});await rejects(()=>login({channel:'browser',browser:{driver:d},signal:ac.signal,login:{input:{subscribeRefresh:()=>()=>{unsub++},takeRefreshRequest:()=>{ac.abort();return {refresh:false}}}},dependencies:{sleep:async()=>{}}}),'ABORTED');assert.equal(unsub,1)});
await test('browser QR 回调失败不订阅',async()=>{let sub=0;await rejects(()=>login({channel:'browser',browser:{driver:browser()},login:{onQr:()=>{throw Error('secret')},input:{subscribeRefresh:()=>{sub++;return ()=>{}}}},dependencies:{sleep:async()=>{}}}),'CALLBACK_FAILED');assert.equal(sub,0)});
await test('取消未配合的 response.json 等待',async()=>{const ac=new AbortController();let ready;const started=new Promise(r=>ready=r);const p=login({signal:ac.signal,login:{onQr:()=>{}},dependencies:{fetch:async()=>({json:()=>{ready();return new Promise(()=>{})}})}});await started;ac.abort();await rejects(()=>p,'ABORTED')});
await test('browser 页内 JSON 错误分类',async()=>{const d=browser({loggedIn:true,onEval:e=>e.startsWith('fetch(')?'not json':e.includes('t.match(')?'10000001':'Test'});const s=await login({channel:'browser',browser:{driver:d}});await rejects(()=>collect({session:s}),'INVALID_RESPONSE')});
await test('borrowed browser 完整流程不关闭外部资源',async()=>{const d=browser({loggedIn:true});const r=await collectData({channel:'browser',browser:{driver:d},dependencies:{sleep:async()=>{}}});assert.equal(r.files.size,13);assert.equal(d.closeCount,0)});
for(const [name,reply,code] of [['HTTP',{ok:false,status:503},'HTTP_ERROR'],['非 JSON',{ok:true,text:async()=> 'bad'},'INVALID_RESPONSE'],['凭据失效',response({retcode:-100}),'AUTH_EXPIRED'],['未知业务码',response({retcode:-1}),'UPSTREAM_ERROR']])await test(`transport ${name}`,()=>rejects(()=>createNodeTransport({uid:'1',cookie:'a=1',fetchImpl:async()=>reply}).fetchJson('/index'),code));
await test('真实 QR 等待循环：到期、刷新、限流、重置、确认',async()=>{let t=0,requests=0,refreshes=0,images=0;const statuses=[];const clock=createQrClock({ttlMs:5,now:()=>t});const r=await waitForLogin({clock,now:()=>t,pollMs:10,maxWaitMs:60,minGapMs:20,maxRefresh:1,sleep:async ms=>{t+=ms},isLoggedIn:async()=>t>=30?'logged-in':null,takeRefreshRequest:()=>({refresh:++requests>1}),refreshQr:async()=>{refreshes++;return 'clicked'},grabQr:async()=>({src:'fake'}),emitQr:async()=>{images++},progress:async s=>statuses.push(s)});assert.ok(r.ok);assert.equal(refreshes,1);assert.equal(images,1);assert.ok(statuses.includes('expired'));assert.ok(statuses.includes('refresh-denied'))});
await test('无过期按钮不重置旧码时钟',async()=>{let t=0,images=0;const clock=createQrClock({ttlMs:1,now:()=>t});await waitForLogin({clock,now:()=>t,maxWaitMs:20,pollMs:10,sleep:async ms=>{t+=ms},isLoggedIn:()=>null,takeRefreshRequest:()=>({refresh:true}),refreshQr:()=> 'no-expired-node',grabQr:()=>({src:'old'}),emitQr:()=>{images++}});assert.equal(images,0);assert.equal(clock.issuedAt,0)});
await test('旧完整编排与宿主参数无源码残留',async()=>{
 const sources=['collect.mjs','login-browser.mjs','qr-wait.mjs','transport-node.mjs'].map(f=>readFileSync(new URL(`../${f}`,import.meta.url),'utf8')).join('\n');
 assert.equal((sources.match(/export async function collectData/g)||[]).length,0);
 assert.ok(!/collectWithBrowser|nowIso|saveQrFile|qrUrlFor|persistQr|purge|waitMode|REFRESH_SIGNAL_FILE|isRefreshKey|createRefreshInput|refreshChannelHint|expiredRefreshHint|按回车|页面快照/.test(sources));
});
function ownedChromium({ goto, launch } = {}) {
 const state = { closes:0, pages:0 };
 const page = { goto:async()=>{await goto?.();}, evaluate:async e => e.includes('t.match(')?'10000001':e.includes("split('\\n')")?'Test':{ mounted:true, hasUid:true }, frames:()=>[] };
 const ctx = { browser:()=>null, pages:()=>[], newPage:async()=>{state.pages++;return page;}, close:async()=>{state.closes++;} };
 return { state, ctx, chromium:{launchPersistentContext:async()=>{await launch?.();return ctx;}} };
}
await test('自建 driver 登录取消释放拥有的 context',async()=>{
 const ac=new AbortController();let ready;const entered=new Promise(r=>ready=r);
 const f=ownedChromium({goto:()=>{ready();return new Promise(()=>{})}});
 const p=login({channel:'browser',browser:{driver:{kind:'playwright',chromium:f.chromium,profile:'/tmp/fake-profile'}},signal:ac.signal});
 await entered;ac.abort();await rejects(()=>p,'ABORTED');assert.equal(f.state.closes,1);
});
await test('取消后迟到的 browser 启动结果释放且不创建页面',async()=>{
 const ac=new AbortController();let ready,release;const entered=new Promise(r=>ready=r);const ended=new Promise(r=>release=r);
 const f=ownedChromium({launch:()=>{ready();return ended}});
 const p=login({channel:'browser',browser:{driver:{kind:'playwright',chromium:f.chromium,profile:'/tmp/fake-profile'}},signal:ac.signal});
 await entered;ac.abort();await rejects(()=>p,'ABORTED');release();
 await new Promise(r=>setImmediate(r));assert.equal(f.state.closes,1);assert.equal(f.state.pages,0);
});
await test('创建的 session close 恰好关闭资源一次',async()=>{
 const f=ownedChromium();const s=await login({channel:'browser',browser:{driver:{kind:'playwright',chromium:f.chromium,profile:'/tmp/fake-profile'}}});
 await s.close();await s.close();assert.equal(f.state.closes,1);
});
await test('Node 未知状态不是超时或凭据失效',()=>rejects(()=>login({login:{onQr:()=>{}},dependencies:{...deps,fetch:network(['unknown'])}}),'INVALID_RESPONSE'));
await test('Node 申请 QR HTTP 错误分类',()=>rejects(()=>login({login:{onQr:()=>{}},dependencies:{fetch:async()=>({ok:false,status:503})}}),'HTTP_ERROR'));
await test('Node QR 到期事件只发一次、保留 180000ms 默认等待',async()=>{
 let t=0;const statuses=[];await rejects(()=>login({login:{onQr:()=>{}},onProgress:e=>statuses.push(e.status),dependencies:{...deps,fetch:network(['Created']),now:()=>t,sleep:async ms=>{t+=ms}}}),'LOGIN_TIMEOUT');
 assert.equal(t,180000);assert.equal(statuses.filter(s=>s==='expired').length,1);
});
await test('browser 保留 600000ms 默认等待',async()=>{
 let t=0;const d=browser({onEval:()=>null});await rejects(()=>login({channel:'browser',browser:{driver:d},dependencies:{now:()=>t,sleep:async ms=>{t+=ms}}}),'LOGIN_TIMEOUT');
 // 扫码模式准备会 sleep 1200，等待循环仍是完整 600000。
 assert.equal(t,601200);
});
await test('刷新回调失败退订一次',async()=>{
 let unsub=0;await rejects(()=>login({channel:'browser',browser:{driver:browser({onEval:()=>null})},login:{input:{subscribeRefresh:()=>()=>{unsub++},takeRefreshRequest:()=>{throw Error('secret')}}},dependencies:{sleep:async()=>{}}}),'CALLBACK_FAILED');assert.equal(unsub,1);
});
console.log(`结果：通过 ${pass} / 失败 ${fail}`);process.exitCode=fail?1:0;
