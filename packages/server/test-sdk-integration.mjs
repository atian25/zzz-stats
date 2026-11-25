#!/usr/bin/env node
/** 隔离验证 execute 的 SDK→SSE→内存报表适配，不启动现有服务、不写 output。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { collectData as sdkCollectData } from '@atian25/zzz-stats-sdk';
import { buildReport } from '@atian25/zzz-stats-skill/report';
const source = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
const CFG = JSON.parse(readFileSync(new URL('../../skills/zzz-stats/config/report.json', import.meta.url), 'utf8'));
const fixture = name => JSON.parse(readFileSync(new URL(`../../fixtures/baseline/${name}`, import.meta.url), 'utf8'));
let pass=0, fail=0;
const test = async(name,fn)=>{try{await fn();pass++;console.log(`✓ ${name}`)}catch(e){fail++;console.error(`✗ ${name}`,e)}};
const response = data => ({ok:true,json:async()=>data,text:async()=>JSON.stringify(data),headers:{getSetCookie:()=>['cookie_token_v2=fake']}});
const fetch = async raw => {
 const u=new URL(raw);
 if(u.pathname.endsWith('createQRLogin'))return response({retcode:0,data:{url:'https://example.test/qr',ticket:'fake'}});
 if(u.pathname.endsWith('queryQRLoginStatus'))return response({retcode:0,data:{status:'Confirmed',user_info:{aid:'10'}}});
 if(u.pathname.endsWith('getUserGameRolesByCookie'))return response({retcode:0,data:{list:[{game_uid:'10000001',nickname:'绳匠A',region:'prod_gf_cn'}]}});
 const endpoint=u.pathname.split('/').pop();const id=u.searchParams.get('gacha_type');
 return response(fixture(endpoint==='index'?'index.json':`${endpoint}_${id}.json`));
};
const events=[];let forwarded;
const context=vm.createContext({Buffer,Date,Map,console:{log(){},error(){}},CFG,buildReport,
 collectData: async options=>{forwarded=options;return sdkCollectData({...options,dependencies:{fetch,sleep:async()=>{},encodeQr:async()=> 'data:image/png;base64,FAKE'}})},
 emit:(_run,type,data)=>events.push({type,data}),redact:s=>String(s),finishRun:run=>{run.finished=true},
});
vm.runInContext(source.slice(source.indexOf('async function execute(run)'),source.indexOf('// ---------------------------------------------------------------- 静态资源')),context);
const run={id:'fake',startedAt:Date.now(),ac:new AbortController()};
await context.execute(run);
if (run.error) console.error('execute error:', run.error);
await test('真实 SDK 通过 server execute 完成内存报表',()=>{assert.ok(run.html);assert.equal(run.finished,true);assert.equal(run.error,undefined)});
await test('server QR TTL 来自 SDK progress',()=>{const qr=events.find(e=>e.type==='qr');assert.equal(qr.data.ttlMs,120000);assert.equal(qr.data.dataUrl,'data:image/png;base64,FAKE');assert.ok(!/ttlMs:\s*120000/.test(source))});
await test('meta 注入后账号字段正确',()=>{assert.equal(run.uid,'10000001');assert.equal(run.nickname,'绳匠A');assert.ok(run.html.includes('10000001'));assert.ok(run.html.includes('绳匠A'))});
await test('频道事件不会重复显示开始取数',()=>assert.equal(events.filter(e=>e.type==='stage'&&e.data.label==='开始取数').length,1));
await test('输出占位符命中数为零',()=>{const matches=run.html.match(/\/\*__[^\n]*|\{\{[A-Z_]+\}\}/g)||[];console.log(`占位符命中数：${matches.length}；HTML ${Buffer.byteLength(run.html)} bytes`);assert.equal(matches.length,0)});
await test('传入 run 独立取消 signal',()=>assert.equal(forwarded.signal,run.ac.signal));
console.log(`结果：通过 ${pass} / 失败 ${fail}`);process.exitCode=fail?1:0;
