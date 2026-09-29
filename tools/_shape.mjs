import { readFileSync } from 'node:fs'
const JAR='C:/Users/DELL/AppData/Local/Temp/dshjar.txt'
function cookieHeader(p){let raw=readFileSync(p,'utf8');const out=[];for(let l of raw.split(/\r?\n/)){if(!l.trim())continue;if(l.startsWith('#HttpOnly_'))l=l.slice(10);else if(l.startsWith('#'))continue;const f=l.split('\t');if(f.length<7)continue;out.push(`${f[5]}=${f[6]}`)}return out.join('; ')}
async function rpc(m,a){const r=await fetch(`http://127.0.0.1:3080/api/${m}`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookieHeader(JAR)},body:JSON.stringify({type:'client-request',rpcId:'x1',method:m,payload:{args:a}})});const t=await r.text();return JSON.parse(t)}
const j=await rpc('pluginInventory/list',{})
const v=j?.result?.value
console.log('typeof value=',typeof v)
if(v&&typeof v==='object'){console.log('keys=',JSON.stringify(Object.keys(v)));const s=JSON.stringify(v);console.log('len=',s.length);console.log('head=',s.slice(0,700))}else console.log('value=',JSON.stringify(v).slice(0,300))
