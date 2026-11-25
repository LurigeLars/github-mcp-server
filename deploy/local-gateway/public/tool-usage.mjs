/**
 * Local, bounded tool metadata only. No request arguments, response text, URLs,
 * session/client identities, symbols, or free-form errors are persisted.
 */
import {appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';

const RETAIN_DAYS=30;
const DAY_MS=86400000;
const DAY_LIMIT=2*1024*1024;
const BUCKETS=[10,25,50,100,200,300,500,750,1000,1500,2000,3000,5000,10000,20000,30000,60000,120000,300000,600000];
const CODES=new Set(['UNCLASSIFIED_ERROR','UPSTREAM_ERROR','RPC_ERROR','HTTP_ERROR','NO_RESPONSE','ABORTED','CORRELATION_UNKNOWN','RATE_LIMIT','TIMEOUT']);
const validTool=name=>typeof name==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(name);
const dayAt=ms=>new Date(ms).toISOString().slice(0,10);
function safeError(...values){
  for(const value of values){
    if(typeof value!=='string')continue;
    const code=value.slice(0,80).split(':',1)[0];
    if(CODES.has(code))return code;
  }
  return 'UNCLASSIFIED_ERROR';
}

function validEvent(e){
  return e&&validTool(e.tool)&&Number.isInteger(e.ms)&&e.ms>=0&&e.ms<=86400000&&
    typeof e.ok==='boolean'&&(e.ok?e.code===undefined:CODES.has(e.code));
}
function accumulator(tool){
  return {tool,calls:0,errors:0,sum_ms:0,max_ms:0,buckets:Array(BUCKETS.length+1).fill(0),
    error_codes:Object.create(null)};
}
function addEvent(a,e){
  a.calls++;a.errors+=Number(!e.ok);a.sum_ms+=e.ms;a.max_ms=Math.max(a.max_ms,e.ms);
  const bucket=BUCKETS.findIndex(b=>e.ms<=b);a.buckets[bucket<0?BUCKETS.length:bucket]++;
  if(!e.ok)a.error_codes[e.code]=(a.error_codes[e.code]||0)+1;

}
function percentile(a,p){
  let n=0;const rank=Math.ceil(a.calls*p);
  for(let i=0;i<a.buckets.length;i++){n+=a.buckets[i];if(n>=rank)return Math.min(a.max_ms,BUCKETS[i]??a.max_ms);}
  return null;
}
function summarize(a){
  return {tool:a.tool,calls:a.calls,errors:a.errors,error_rate:Math.round(a.errors/a.calls*10000)/10000,
    mean_ms:Math.round(a.sum_ms/a.calls),p50_upper_ms:percentile(a,.5),p95_upper_ms:percentile(a,.95),
    max_ms:a.max_ms,error_codes:a.error_codes};
}

/** One append-only file per UTC day, bounded and periodically flushed.
 * Concurrent local processes may append to the same day; malformed/oversize
 * files are explicitly flagged rather than treated as complete evidence.
 */
export function createToolUsageStore({root,now=Date.now,dayLimit=DAY_LIMIT,flushMs=5000,enabled=true}={}){
  let queue=[],timer=null,lastPrune=null,recordingErrors=0;
  const registered=new Set();
  const limited=new Set();
  const directory=root||resolve(process.env.LOCALAPPDATA||process.env.HOME||'.','github-local-mcp','tool-usage');
  function prune(day){
    if(lastPrune===day)return;
    const first=dayAt(now()-(RETAIN_DAYS-1)*DAY_MS);
    mkdirSync(directory,{recursive:true,mode:0o700});
    for(const file of readdirSync(directory)){
      const m=/^(\d{4}-\d{2}-\d{2})\.(?:ndjson|limited)$/.exec(file);
      if(m&&m[1]<first)unlinkSync(join(directory,file));
    }
    for(const d of limited)if(d<first)limited.delete(d);
    lastPrune=day;
  }
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}
    if(!enabled)return;
    const batch=queue;queue=[];
    try{
      prune(dayAt(now()));
      const days=new Map();
      for(const {day,line} of batch){
        const lines=days.get(day)||[];lines.push(line);days.set(day,lines);
      }
      for(const [day,lines] of days){
        try{
          if(day<dayAt(now()-(RETAIN_DAYS-1)*DAY_MS))continue;
          const file=join(directory,day+'.ndjson'),mark=join(directory,day+'.limited');
          if(limited.has(day))continue;
          const payload=lines.join('');
          const fd=openSync(file,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW||0),0o600);
          try{
            const stat=fstatSync(fd);
            if(!stat.isFile()||stat.nlink!==1)throw new Error('Unsafe metrics file');
            if(stat.size+Buffer.byteLength(payload)>dayLimit){
              limited.add(day);
              try{writeFileSync(mark,'capacity reached\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
              continue;
            }
            appendFileSync(fd,payload,{encoding:'utf8'});
          }finally{closeSync(fd);}
        }catch{recordingErrors+=lines.length;limited.add(day);}
      }
    }catch{recordingErrors+=Math.max(1,batch.length);for(const {day} of batch)limited.add(day);}
  }
  function record(tool,ms,meta={}){
    if(!enabled||tool==='tool_usage'||!validTool(tool)||!Number.isFinite(ms)||ms<0)return;
    const event={tool,ms:Math.min(86400000,Math.round(ms)),ok:meta.ok!==false};
    if(!event.ok)event.code=safeError(meta.code);
    queue.push({day:dayAt(now()),line:JSON.stringify(event)+'\n'});
    if(queue.length>=128)flush();
    else if(!timer){timer=setTimeout(flush,flushMs);timer.unref();}
  }
  function report({days=7,limit=50,tool}={}){
    if(!Number.isInteger(days)||days<1||days>RETAIN_DAYS||!Number.isInteger(limit)||limit<1||limit>100||
      (tool!==undefined&&!validTool(tool)))throw new Error('Invalid usage report bounds');
    flush();
    const totals=new Map(),sampleDays=[],limitedDays=[];
    let invalidRecords=0;
    const today=dayAt(now()),first=dayAt(now()-(days-1)*DAY_MS);
    for(let i=days-1;i>=0;i--){
      const day=dayAt(now()-i*DAY_MS),file=join(directory,day+'.ndjson');
      let incomplete=limited.has(day)||existsSync(join(directory,day+'.limited'));
      try{
        let fd;
        try{fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));}
        catch(e){if(e.code!=='ENOENT')throw e;}
        if(fd!==undefined){
          try{
            const stat=fstatSync(fd);
            if(!stat.isFile()||stat.nlink!==1||stat.size>dayLimit)incomplete=true;
            else{
              // Bound the read even if a concurrent appender grows the same file.
              const buffer=Buffer.alloc(Math.min(dayLimit+1,stat.size+1));
              let offset=0;
              while(offset<buffer.length){
                const n=readSync(fd,buffer,offset,buffer.length-offset,null);
                if(!n)break;
                offset+=n;
              }
              if(offset>stat.size||offset>dayLimit)incomplete=true;
              else{
                let sampled=false;
                for(const line of buffer.subarray(0,offset).toString('utf8').split('\n')){
                  if(!line)continue;
                  let event;
                  try{event=JSON.parse(line);}catch{invalidRecords++;incomplete=true;continue;}
                  if(!validEvent(event)){invalidRecords++;incomplete=true;continue;}
                  if(tool&&event.tool!==tool)continue;
                  sampled=true;
                  const a=totals.get(event.tool)||accumulator(event.tool);addEvent(a,event);totals.set(event.tool,a);
                }
                if(sampled)sampleDays.push(day);
              }
            }
          }finally{closeSync(fd);}
        }
      }catch{incomplete=true;}
      if(incomplete)limitedDays.push(day);
    }
    const rows=[...totals.values()].map(summarize).sort((a,b)=>b.calls-a.calls||a.tool.localeCompare(b.tool));
    return {success:true,enabled,from_utc_day:first,to_utc_day:today,retention_days:RETAIN_DAYS,
      measurement_scope:'Accepted MCP proxy round-trip duration on the originating response stream. Excludes network outside the proxy, denied calls and calls not yet in a trusted catalog; success does not certify GitHub operation completeness.',
      percentile_method:'Histogram bucket upper bounds; rounded milliseconds.',
      recorded_calls:rows.reduce((n,r)=>n+r.calls,0),recorded_errors:rows.reduce((n,r)=>n+r.errors,0),
      tool_count:rows.length,returned_count:Math.min(limit,rows.length),truncated:rows.length>limit,
      days_with_samples:sampleDays,coverage_limited_days:limitedDays,invalid_records:invalidRecords,
      registered_tool_count:[...registered].filter(n=>n!=='tool_usage'&&(!tool||n===tool)).length,
      unobserved_tools:[...registered].filter(n=>n!=='tool_usage'&&(!tool||n===tool)&&!totals.has(n)).sort(),
      recording_errors_since_start:recordingErrors,tools:rows.slice(0,limit)};
  }
  return {record,report,flush,register:name=>{if(validTool(name))registered.add(name);}};
}


const REPORT_TOOL='tool_usage';
export const USAGE_DEFINITION={
  name:REPORT_TOOL,
  description:'Read local per-tool calls, latency, errors and tools with no observed calls over 1-30 UTC days.',
  inputSchema:{type:'object',additionalProperties:false,properties:{
    days:{type:'integer',minimum:1,maximum:30},limit:{type:'integer',minimum:1,maximum:100},
    tool:{type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'}},
  },
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
};
export function appendUsageTool(msg,allowed){
  if(allowed.has(REPORT_TOOL)&&Array.isArray(msg?.result?.tools)&&!msg.result.tools.some(t=>t.name===REPORT_TOOL))
    msg.result.tools.push(structuredClone(USAGE_DEFINITION));
  return msg;
}
export function isUsageCall(msg){return msg?.method==='tools/call'&&msg.params?.name===REPORT_TOOL;}
export function usageResult(msg,store,scope){
  try{
    const args=msg.params?.arguments??{};
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['days','limit','tool'].includes(k)))
      throw new Error('Invalid usage arguments');
    return {jsonrpc:'2.0',id:msg.id??null,result:{content:[{type:'text',
      text:JSON.stringify({...store.report(args),source_scope:scope})}]}};
  }catch{
    return {jsonrpc:'2.0',id:msg.id??null,result:{isError:true,
      content:[{type:'text',text:'Tool usage report unavailable or invalid arguments'}]}};
  }
}

// Correlation keys remain in memory only. Do not store request IDs or inspect raw response text.
// One tracker per HTTP POST; the local stdio proxy uses a bounded process-wide tracker.
export function createUsageTracker(store,allowed,{now=()=>performance.now(),maxPending=512}={}){
  const pending=new Map(),ambiguous=new Map();
  const record=(name,ms,code)=>{try{store.record(name,ms,{ok:code===undefined,code});}catch{/* metrics are best effort */}};
  const done=(id,code)=>{
    const item=pending.get(id);
    if(!item)return;
    pending.delete(id);
    record(item.name,Math.max(0,now()-item.at),code);
  };
  function expire(){
    for(const [id,item] of pending)if(now()-item.at>600000)done(id,'NO_RESPONSE');
    for(const [id,until] of ambiguous)if(now()>until)ambiguous.delete(id);
  }
  function start(msg){
    if(msg?.method!=='tools/call'||isUsageCall(msg)||!allowed.has(msg.params?.name))return;
    const name=msg.params.name,id=msg.id;
    expire();
    if(!(typeof id==='number'||(typeof id==='string'&&id.length<=256))){
      record(name,0,'CORRELATION_UNKNOWN');return;
    }
    if(ambiguous.has(id)||pending.has(id)){
      done(id,'CORRELATION_UNKNOWN');
      if(ambiguous.size<maxPending)ambiguous.set(id,now()+600000);
      record(name,0,'CORRELATION_UNKNOWN');return;
    }
    if(pending.size>=maxPending){record(name,0,'CORRELATION_UNKNOWN');return;}
    pending.set(id,{name,at:now()});
  }
  function observe(msg){
    if(msg?.id===undefined||(!Object.hasOwn(msg,'result')&&!Object.hasOwn(msg,'error')))return;
    if(ambiguous.has(msg.id))return;
    const code=msg.error?'RPC_ERROR':msg.result?.isError===true||msg.result?.structuredContent?.success===false?'UPSTREAM_ERROR':undefined;
    done(msg.id,code);
  }
  function finish(code='NO_RESPONSE'){
    for(const id of pending.keys())done(id,code);
    ambiguous.clear();
  }
  return {start,observe,finish,expire};
}


/** Trust only tool names in a policy-filtered upstream tools/list reply.
 * Discovery is scoped to this proxy process; never persist caller-supplied names.
 * Catalog pages can be incomplete and change with upstream toolsets.
 */
export function createCatalogObserver(store,allowed){
  const discovered=new Set();
  return {
    observe(msg,requestIds){
      if(!requestIds.has(msg?.id)||!Array.isArray(msg?.result?.tools))return;
      for(const t of msg.result.tools){
        if(discovered.size>=512)break;
        const name=t?.name;
        if(!validTool(name)||name==='tool_usage')continue;
        discovered.add(name);allowed.add(name);store.register(name);
      }
    },
    size:()=>discovered.size,
  };
}
export function listRequestIds(messages){
  return new Set(messages.filter(m=>m?.method==='tools/list'&&m.id!==undefined).map(m=>m.id));
}
export function reportWithCatalog(msg,store,scope,catalog){
  const reply=usageResult(msg,store,scope);
  if(!reply.result.isError){
    const data=JSON.parse(reply.result.content[0].text);
    data.catalog_observed_count=catalog.size();
    data.catalog_note='Inventory from policy-filtered tools/list responses in this process; refresh discovery before evaluating unobserved tools. Calls before catalog discovery and other connectors are not covered.';
    reply.result.content[0].text=JSON.stringify(data);
  }
  return reply;
}
