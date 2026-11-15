// Limiters grabbed by routes BEFORE initRateLimiters must count in the shared store after it.
const path=require('path');const B=path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const express=require(path.join(B,'node_modules','express'));
const RL=require(path.join(B,'node_modules','express-rate-limit'));const rateLimit=RL.rateLimit||RL.default||RL;
const mod=require(path.join(B,'middleware/rateLimitInstances.js'));
// what routes/auth.js does at load time:
const { instances: { authLimiter } } = mod;
const guest = mod.registerLimiter('guest', (store)=>rateLimit({windowMs:60000,max:3,standardHeaders:true,legacyHeaders:false,validate:false,store}));
// shared "Redis": one counter map for all server copies
const shared=new Map(); const used=new Set();
class FakeStore{constructor(p){this.prefix=p;}init(){} async increment(k){const key=this.prefix+k;used.add(this.prefix);const n=(shared.get(key)||0)+1;shared.set(key,n);return{totalHits:n,resetTime:new Date(Date.now()+60000)};} async decrement(k){} async resetKey(k){shared.delete(this.prefix+k);} }
mod.initRateLimiters((p)=>new FakeStore(p+':'));
const later = mod.registerLimiter('later', (store)=>rateLimit({windowMs:60000,max:5,validate:false,store}));
const app=express(); app.set('trust proxy',false);
app.post('/login',authLimiter,(q,s)=>s.json({ok:1})); app.post('/guest',guest,(q,s)=>s.json({ok:1})); app.get('/later',later,(q,s)=>s.json({ok:1}));
const srv=app.listen(0,async()=>{const b=`http://127.0.0.1:${srv.address().port}`;let f=0;const ck=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':' '+JSON.stringify(x)));if(!c)f++};
 await fetch(b+'/login',{method:'POST'}); ck('login limiter (taken before Redis was ready) now counts in shared store',used.has('auth:'),[...used]);
 const codes=[];for(let i=0;i<5;i++)codes.push((await fetch(b+'/guest',{method:'POST'})).status);
 ck('guest checkout limiter counts in shared store and blocks after its max',used.has('guest:')&&codes.join()=='200,200,200,429,429',{codes,used:[...used]});
 await fetch(b+'/later'); ck('limiter registered after init uses shared store straight away',used.has('later:'),[...used]);
 let dup=false;try{mod.registerLimiter('guest',()=>{})}catch(e){dup=true} ck('same limiter name twice is refused',dup);
 srv.close();console.log(f?f+' FAILED':'ALL PASSED');process.exitCode=f?1:0;setTimeout(()=>process.exit(process.exitCode),200)});
