const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000,ADMIN_USER=process.env.ADMIN_USER||'admin',ADMIN_PASS=process.env.ADMIN_PASSWORD||'';
if(!ADMIN_PASS){console.error('Set ADMIN_PASSWORD');process.exit(1);}
// ---- storage: key/value in Google Sheet (via Apps Script) or local SQLite ----
let kv;
if(process.env.SHEET_URL){
  const call=async o=>{const r=await fetch(process.env.SHEET_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({...o,secret:process.env.SHEET_SECRET||''})});const j=JSON.parse(await r.text());if(j.error)throw new Error(j.error);return j;};
  kv={all:async()=>(await call({action:'all'})).data,set:(key,value)=>call({action:'set',key,value}),del:key=>call({action:'del',key}),report:rows=>call({action:'report',rows})};
}else{
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.env.DB_FILE||path.join(__dirname,'tournament.db'));
  db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT)');
  kv={all:async()=>Object.fromEntries(db.prepare('SELECT k,v FROM kv').all().map(r=>[r.k,r.v])),
    set:async(k,v)=>{db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').run(k,v);},
    del:async k=>{db.prepare('DELETE FROM kv WHERE k=?').run(k);},report:async()=>{}};
}
// ---- state (kept in memory, written through to storage) ----
const SEED=[
 {id:'b12',name:'Boys Under 12',gender:'Boys',cutoff:'2016-01-01',fee:100,note:'',open:true},
 {id:'b14',name:'Boys Under 14',gender:'Boys',cutoff:'2014-01-01',fee:100,note:'',open:true},
 {id:'b17',name:'Boys Under 17',gender:'Boys',cutoff:'2011-01-01',fee:100,note:'',open:true},
 {id:'bopen',name:'Boys Open',gender:'Boys',cutoff:null,fee:100,note:'',open:true},
 {id:'g12',name:'Girls Under 12',gender:'Girls',cutoff:'2016-01-01',fee:100,note:'',open:true},
 {id:'gopen',name:'Girls Open',gender:'Girls',cutoff:null,fee:100,note:'',open:true},
 {id:'mixed',name:'Mixed',gender:'Any',cutoff:null,fee:100,note:'Min. 1 girl per team, others boys, no age limit',open:true}];
const S={regs:{},cats:[],settings:{registrationOpen:true,editOpen:false,notice:'',title:'Diwali 3x3 Tournament',subtitle:'Age-category 3x3 basketball festival',about:'Players join categories by date of birth and may also play in other categories they are eligible for. The organizer may add or change categories later; you can then log in and edit your registration when the circular is released.'},next:1};
const saveReg=r=>kv.set('reg:'+r.id,JSON.stringify(r)),saveCats=()=>kv.set('cats',JSON.stringify(S.cats)),saveSettings=()=>kv.set('settings',JSON.stringify(S.settings));
async function init(){
  const d=await kv.all();
  for(const [k,v] of Object.entries(d)){try{
    if(k.startsWith('reg:')){const r=JSON.parse(v);S.regs[r.id]=r;S.next=Math.max(S.next,r.id+1);}
    else if(k==='cats')S.cats=JSON.parse(v);else if(k==='settings')Object.assign(S.settings,JSON.parse(v));}catch(e){}}
  if(!S.cats.length){S.cats=SEED;await saveCats();}
}
const eligible=(c,p)=>(c.gender==='Any'||c.gender===p.gender)&&(!c.cutoff||p.dob>=c.cutoff);
const catOf=id=>S.cats.find(c=>c.id===id);
const fee=r=>r.cats.reduce((a,id)=>a+((catOf(id)||{}).fee||0),0);
const pub=r=>{const {pw,...x}=r;return {...x,fee:fee(r),balance:fee(r)-(r.paid||0)};};
function validCats(p,ids,prev=[]){
  if(!ids.length)return 'Select at least one category';
  for(const id of ids){const c=catOf(id);if(!c)return 'Unknown category';
    if(!eligible(c,p))return 'Not eligible for '+c.name;
    if(!c.open&&!prev.includes(id))return c.name+' is closed for new entries';}
  return null;
}
let rt;const scheduleReport=()=>{clearTimeout(rt);rt=setTimeout(()=>kv.report(reportRows()).catch(e=>console.error('report',e.message)),5000);};
const csvCell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
function reportRows(){
  const h=['ID','Registered','Name','Gender','DOB','Phone','Team','FIBA ID','Categories','Fee','Paid','Balance'];
  return [h].concat(Object.values(S.regs).sort((a,b)=>a.id-b.id).map(r=>{const p=pub(r);return [r.id,r.created,r.name,r.gender,r.dob,r.phone,r.team,r.fiba,r.cats.map(i=>(catOf(i)||{}).name).join(' | '),p.fee,r.paid||0,p.balance];}));
}
// ---- passwords & tokens ----
const hash=pw=>{const s=crypto.randomBytes(8).toString('hex');return s+':'+crypto.scryptSync(pw,s,32).toString('hex');};
const check=(pw,h)=>{const [s,x]=h.split(':');return crypto.timingSafeEqual(Buffer.from(x,'hex'),crypto.scryptSync(pw,s,32));};
const KEY=crypto.createHash('sha256').update('k|'+ADMIN_PASS+'|'+(process.env.SHEET_SECRET||'')).digest();
const sign=p=>crypto.createHmac('sha256',KEY).update(p).digest('hex');
const mkTok=id=>{const p=id+'.'+(Date.now()+12*36e5);return p+'.'+sign(p);};
const readTok=t=>{const [id,exp,sig]=String(t||'').replace('Bearer ','').split('.');return sig&&sign(id+'.'+exp)===sig&&Date.now()<+exp?+id:null;};
const tries={};const limited=k=>(tries[k]=(tries[k]||[]).filter(x=>Date.now()-x<9e5)).length>=10;
// ---- http helpers ----
const send=(res,code,body,type='application/json')=>{res.writeHead(code,{'Content-Type':type});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
const E=(res,code,error)=>send(res,code,{error});
const readBody=req=>new Promise((ok,no)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e5){no(new Error('big'));req.destroy();}});req.on('end',()=>ok(d?JSON.parse(d):{}));});
const str=(v,n)=>String(v??'').trim().slice(0,n);
function adminOk(req,res){
  const h=req.headers.authorization||'';const [u,...p]=Buffer.from(h.replace('Basic ',''),'base64').toString().split(':');
  if(h.startsWith('Basic ')&&u===ADMIN_USER&&p.join(':')===ADMIN_PASS)return true;
  res.writeHead(401,{'WWW-Authenticate':'Basic realm="Admin"'});res.end('Login required');return false;
}
const page=(res,f)=>send(res,200,fs.readFileSync(path.join(__dirname,'public',f)),f.endsWith('.css')?'text/css':'text/html; charset=utf-8');

const server=http.createServer(async(req,res)=>{try{
  const p=new URL(req.url,'http://x').pathname,m=req.method;
  if(m==='GET'){if(p==='/')return page(res,'index.html');if(p==='/my')return page(res,'my.html');if(p==='/style.css')return page(res,'style.css');}
  if(p==='/api/public')return send(res,200,{cats:S.cats,settings:S.settings});
  if(m==='POST'&&p==='/api/register'){
    const b=await readBody(req);if(!S.settings.registrationOpen)return E(res,403,'Registration is closed');
    const r={id:S.next,created:new Date().toISOString().slice(0,16).replace('T',' '),name:str(b.name,80),gender:b.gender,dob:str(b.dob,10),
      phone:String(b.phone||'').replace(/\D/g,'').slice(-10),team:str(b.team,60),fiba:str(b.fibaId,30),cats:[...new Set(b.cats||[])],paid:0};
    const pw=String(b.password||'');
    if(!r.name)return E(res,400,'Enter the name');
    if(!['Boys','Girls'].includes(r.gender))return E(res,400,'Select Boy or Girl');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(r.dob)||r.dob>new Date().toISOString().slice(0,10))return E(res,400,'Invalid date of birth');
    if(r.phone.length!==10)return E(res,400,'Enter a valid 10-digit phone number');
    if(!r.fiba)return E(res,400,'FIBA Profile ID is required');
    if(pw.length<6)return E(res,400,'Password must be at least 6 characters');
    if(Object.values(S.regs).some(x=>x.fiba.toLowerCase()===r.fiba.toLowerCase()))return E(res,409,'This FIBA Profile ID is already registered. Use Login to view or edit.');
    const e=validCats(r,r.cats);if(e)return E(res,400,e);
    r.pw=hash(pw);S.next++;S.regs[r.id]=r;
    try{await saveReg(r);}catch(x){delete S.regs[r.id];throw x;}
    scheduleReport();return send(res,200,{id:r.id,fee:fee(r)});
  }
  if(m==='POST'&&p==='/api/login'){
    const b=await readBody(req),f=str(b.fibaId,30).toLowerCase(),k=req.socket.remoteAddress+'|'+f;
    if(limited(k))return E(res,429,'Too many attempts. Try again in 15 minutes.');
    const r=Object.values(S.regs).find(x=>x.fiba.toLowerCase()===f);
    if(!r||!check(String(b.password||''),r.pw)){tries[k].push(Date.now());return E(res,401,'Wrong FIBA ID or password');}
    return send(res,200,{token:mkTok(r.id)});
  }
  if(p==='/api/me'||p==='/api/me/update'){
    const r=S.regs[readTok(req.headers.authorization)];if(!r)return E(res,401,'Please login again');
    if(m==='GET')return send(res,200,{reg:pub(r),cats:S.cats,settings:S.settings});
    if(!S.settings.editOpen)return E(res,403,'Editing is not open yet. Wait for the circular from the organizer.');
    const b=await readBody(req),cats=[...new Set(b.cats||[])],e=validCats(r,cats,r.cats);if(e)return E(res,400,e);
    const phone=String(b.phone||'').replace(/\D/g,'').slice(-10);if(phone.length!==10)return E(res,400,'Enter a valid 10-digit phone number');
    const old={...r};r.cats=cats;r.phone=phone;r.team=str(b.team,60);
    try{await saveReg(r);}catch(x){Object.assign(r,old);throw x;}
    scheduleReport();return send(res,200,{reg:pub(r)});
  }
  if(p==='/admin'||p.startsWith('/api/admin/')){
    if(!adminOk(req,res))return;
    if(p==='/admin')return page(res,'admin.html');
    if(p==='/api/admin/state')return send(res,200,{regs:Object.values(S.regs).map(pub),cats:S.cats,settings:S.settings});
    if(p==='/api/admin/export.csv'){res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="registrations.csv"'});return res.end(reportRows().map(r=>r.map(csvCell).join(',')).join('\n'));}
    const b=await readBody(req);
    if(p==='/api/admin/cats'){
      const c={id:b.id||'c'+Date.now().toString(36),name:str(b.name,40),gender:b.gender,cutoff:/^\d{4}-\d{2}-\d{2}$/.test(b.cutoff||'')?b.cutoff:null,fee:Math.max(0,parseInt(b.fee)||0),note:str(b.note,100),open:!!b.open};
      if(!c.name||!['Boys','Girls','Any'].includes(c.gender))return E(res,400,'Enter a name and choose Boys, Girls or Any');
      const i=S.cats.findIndex(x=>x.id===c.id);if(i>=0)S.cats[i]=c;else S.cats.push(c);
      await saveCats();scheduleReport();return send(res,200,{ok:true});
    }
    if(p==='/api/admin/cats/delete'){
      S.cats=S.cats.filter(c=>c.id!==b.id);await saveCats();
      for(const r of Object.values(S.regs))if(r.cats.includes(b.id)){r.cats=r.cats.filter(x=>x!==b.id);await saveReg(r);}
      scheduleReport();return send(res,200,{ok:true});
    }
    if(p==='/api/admin/settings'){Object.assign(S.settings,{registrationOpen:!!b.registrationOpen,editOpen:!!b.editOpen,notice:str(b.notice,300),title:str(b.title,80)||'Diwali 3x3 Tournament',subtitle:str(b.subtitle,120),about:String(b.about||'').trim().slice(0,2000)});await saveSettings();return send(res,200,{ok:true});}
    const r=S.regs[b.id];if(!r)return E(res,404,'Player not found');
    if(p==='/api/admin/paid'){r.paid=Math.max(0,parseInt(b.amount)||0);await saveReg(r);scheduleReport();return send(res,200,{ok:true});}
    if(p==='/api/admin/reset'){const t=crypto.randomBytes(4).toString('hex').slice(0,6);r.pw=hash(t);await saveReg(r);return send(res,200,{temp:t});}
    if(p==='/api/admin/delete'){delete S.regs[r.id];await kv.del('reg:'+r.id);scheduleReport();return send(res,200,{ok:true});}
  }
  E(res,404,'Not found');
}catch(e){console.error(e);E(res,500,'Server error');}});
init().catch(e=>console.error('INIT FAILED',e.message)).then(()=>server.listen(PORT,()=>console.log('Running on http://localhost:'+PORT)));
