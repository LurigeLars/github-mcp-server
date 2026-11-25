import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createToolUsageStore,createUsageTracker,usageResult,appendUsageTool} from '../public/tool-usage.mjs';
test('counts accepted proxy calls once, never persists request ids or page content',t=>{
  const root=mkdtempSync(join(tmpdir(),'fc-metrics-'));
  const store=createToolUsageStore({root,now:()=>Date.parse('2026-11-25T01:00:00Z')});
  t.after(()=>{store.flush();rmSync(root,{recursive:true,force:true});});
  const allowed=new Set(['firecrawl_scrape','firecrawl_search','tool_usage']);
  for(const name of allowed)store.register(name);
  let now=100;
  const usage=createUsageTracker(store,allowed,{now:()=>now});
  const call=(id,name='firecrawl_scrape')=>({method:'tools/call',id,params:{name,arguments:{url:'PRIVATE_URL'}}});
  usage.start(call('PRIVATE_ID'));now=200;usage.observe({id:'PRIVATE_ID',result:{content:[{text:'PRIVATE_BODY'}]}});
  usage.observe({id:'PRIVATE_ID',result:{}});usage.start(call(2));now=300;usage.observe({id:2,result:{isError:true}});
  usage.start(call(3));usage.finish('ABORTED');usage.start(call(4,'tool_usage'));usage.start(call(5,'private_unknown'));
  const r=store.report();
  assert.equal(r.recorded_calls,3);assert.equal(r.recorded_errors,2);
  assert.deepEqual(r.unobserved_tools,['firecrawl_search']);
  assert.equal(r.tools[0].error_codes.UPSTREAM_ERROR,1);assert.equal(r.tools[0].error_codes.ABORTED,1);
  assert.doesNotMatch(readFileSync(join(root,'2026-11-25.ndjson'),'utf8'),/PRIVATE_|private_unknown/);
  const msg=appendUsageTool({result:{tools:[]}},allowed);assert.equal(msg.result.tools[0].name,'tool_usage');
  const report=usageResult({id:6,params:{arguments:{days:7}}},store,'public_gateway');
  assert.equal(JSON.parse(report.result.content[0].text).source_scope,'public_gateway');
  assert.equal(usageResult({id:7,params:{arguments:{days:31}}},store,'public_gateway').result.isError,true);
});
test('duplicate correlation IDs do not silently attribute one response to two calls',()=>{
  const seen=[];const allowed=new Set(['firecrawl_scrape']);
  const usage=createUsageTracker({record:(...args)=>seen.push(args)},allowed,{now:()=>100});
  const m={method:'tools/call',id:'same',params:{name:'firecrawl_scrape'}};
  usage.start(m);usage.start(m);usage.observe({id:'same',result:{}});usage.finish();
  assert.equal(seen.length,2);assert.ok(seen.every(x=>x[2].code==='CORRELATION_UNKNOWN'));
});

test('catalog names are learned only from correlated tool-list responses',async t=>{
  const {createCatalogObserver,listRequestIds}=await import('../public/tool-usage.mjs');
  const registered=[],allowed=new Set(['tool_usage']);
  const catalog=createCatalogObserver({register:n=>registered.push(n)},allowed);
  const ids=listRequestIds([{id:1,method:'tools/list'},{id:2,method:'tools/call'}]);
  catalog.observe({id:2,result:{tools:[{name:'private_unknown'}]}},ids);
  catalog.observe({id:1,result:{tools:[{name:'list_branches'},{name:'INVALID/PRIVATE'},{name:'tool_usage'}]}},ids);
  assert.deepEqual(registered,['list_branches']);assert.equal(allowed.has('private_unknown'),false);
  assert.equal(catalog.size(),1);
});
