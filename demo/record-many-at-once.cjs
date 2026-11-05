'use strict';
// Reproduces the "Many at once" screen recording from scratch, on your own machine, with nothing taken on trust:
// a fresh Gov5 Gateway with its own new signing key, 1,000 demo agents (stand-in model: no AI is called, no cost),
// then the real console in a phone-sized browser while eight agents break eight rules at once, twice.
// Frames come from the browser itself; nothing is drawn on them except the label at the bottom.
//   npm install && npm i -D playwright && npx playwright install chromium
//   node demo/record-many-at-once.cjs       -> demo/out/list.txt (frames), then:
//   ffmpeg -f concat -safe 0 -i demo/out/list.txt -vf "fps=30,tpad=stop_mode=clone:stop_duration=6,format=yuv420p" -c:v libx264 -crf 20 demo/out/many-at-once.mp4
const path=require('path'); const ROOT=path.join(__dirname,'..'); process.chdir(ROOT);
const R=m=>require(path.join(ROOT,'node_modules',m));
const crypto=require('crypto'),fs=require('fs'),os=require('os'),axios=R('axios');
const kp=crypto.generateKeyPairSync('ed25519');const ADMIN='gwadmin_'+crypto.randomBytes(6).toString('hex');
const OUT=path.join(__dirname,'out'); fs.rmSync(OUT,{recursive:true,force:true}); fs.mkdirSync(OUT+'/fr',{recursive:true});
Object.assign(process.env,{ECOS_NO_LIVE:'1',PORT:process.env.PORT_DEMO||'19021',OSHI_V5_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'v-')),GATEWAY_ENC_KEY:crypto.randomBytes(32).toString('hex'),GATEWAY_ADMIN_KEY:ADMIN,RECEIPT_SIGNING_KEY_PEM:kp.privateKey.export({type:'pkcs8',format:'pem'})});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{require(path.join(ROOT,'server.cjs'));await sleep(900);const GW='http://127.0.0.1:'+(process.env.PORT_DEMO||'19021')+'',H={headers:{'x-console-key':ADMIN},validateStatus:()=>true,timeout:120000};
const dm=(await axios.post(GW+'/console/api/demo/agents',{},H)).data;
const {chromium}=require('playwright');const b=await chromium.launch({args:['--force-device-scale-factor=2.5']});
const ctx=await b.newContext({viewport:{width:432,height:768},colorScheme:'dark'});
const p=await ctx.newPage();
await p.addInitScript(([k,tid])=>{sessionStorage.setItem('gwc_key',k);sessionStorage.setItem('gwc_tenant',tid);},[ADMIN,dm.tenantId]);
await p.goto(GW+'/console#agents');await p.waitForSelector('.lh .sky .dot',{timeout:20000});
const topY=await p.evaluate(()=>{const r=document.querySelector('.lh .recon');return r.getBoundingClientRect().top+scrollY-112;});
let feedY=null;
await p.evaluate(y=>window.scrollTo(0,y),topY); await sleep(2500);
const frames=[]; const cdp=await ctx.newCDPSession(p); let k=0, base=null;
cdp.on('Page.screencastFrame', async f=>{ const ts=f.metadata.timestamp; if(base===null) base=ts; const fn=OUT+'/fr/'+String(k++).padStart(5,'0')+'.jpg'; fs.writeFileSync(fn,Buffer.from(f.data,'base64')); frames.push([fn,ts-base]); try{await cdp.send('Page.screencastFrameAck',{sessionId:f.sessionId});}catch(e){} });
await cdp.send('Page.startScreencast',{format:'jpeg',quality:82,maxWidth:1080,maxHeight:1920,everyNthFrame:1});
const t0=Date.now(); let clicked=false, picked=false, opened=false, target=null; const pre=new Set((await axios.get(GW+'/console/api/lighthouse?tenant='+dm.tenantId,H)).data.agents.filter(a=>a.state==='held').map(a=>a.id));
const ease=x=>x<.5?2*x*x:1-Math.pow(-2*x+2,2)/2;
while(true){ const t=(Date.now()-t0)/1000; if(t>40) break;
  if(!clicked && t>2.5){ clicked=true; await p.click('#lhStorm'); }
  if(feedY===null && t>10.5) feedY=await p.evaluate(()=>{const f=document.querySelector('#lhFeed');return f.getBoundingClientRect().top+scrollY-330;});
  let y=topY; if(t>11&&t<=16) y=topY+(feedY-topY)*ease((t-11)/5); else if(t>16&&t<=22) y=feedY; else if(t>22&&t<=24.5) y=feedY+(topY-feedY)*ease((t-22)/2.5);
  if(t<=26.5){ await p.evaluate(y=>window.scrollTo(0,y),y); }
  // the extra time: tap one agent held in the burst, read its card, open the receipt that waits for a person
  else if(!picked){ picked=true; const L=(await axios.get(GW+'/console/api/lighthouse?tenant='+dm.tenantId,H)).data;
    const c=L.agents.filter(a=>a.state==='held'&&!pre.has(a.id)&&a.holds.some(h=>h.receiptId)), a=c.find(a=>a.holds.some(h=>h.checks.includes('money-approval')))||c[0];
    target=a&&a.id; console.log('V target',a&&a.name,a&&a.holds[0].why);
    if(target){ await p.evaluate(id=>{const el=document.querySelector('[data-lha="'+id+'"]');el.scrollIntoView({block:'center'});},target); await sleep(900); await p.click('[data-lha="'+target+'"]'); await sleep(700);
      await p.evaluate(()=>{const c=document.querySelector('#lhCard');window.scrollTo({top:c.getBoundingClientRect().top+scrollY-120,behavior:'smooth'});}); } }
  else if(target && !opened && t>32){ opened=true; await p.click('#lhCard [data-held]'); }
  await sleep(30); }
await cdp.send('Page.stopScreencast'); await sleep(300);
let list=''; for(let i=0;i<frames.length;i++){ const d=(i+1<frames.length?frames[i+1][1]:frames[i][1]+.1)-frames[i][1]; list+="file '"+frames[i][0]+"'\nduration "+d.toFixed(3)+"\n"; } list+="file '"+frames[frames.length-1][0]+"'\n";
fs.writeFileSync(OUT+'/list.txt',list); console.log('V frames',frames.length,'fps',(frames.length/40).toFixed(1),'size',require('child_process').execSync('ffprobe -v error -show_entries stream=width,height -of csv=p=0 '+frames[0][0]).toString().trim());
await b.close();process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});
