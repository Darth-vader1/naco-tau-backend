const path=require('path'),Module=require('module');const B=path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
let authCalls=0,redisGets=0,redisSets=0,getUserCalls=0;
const stubs={
 [path.join(B,'config/supabase.js')]:{supabase:{auth:{getUser:async()=>{getUserCalls++;return{data:{user:{id:'u1'}}}}}}},
 [path.join(B,'config/logger.js')]:{logger:{info(){},warn(){},debug(){},error(){}}},
 [path.join(B,'config/redis.js')]:{redisClient:{status:'ready',get:async()=>{redisGets++;return null},setex:async()=>{redisSets++},del:async()=>{}}},
 [path.join(B,'middleware/auth.js')]:{getAuthContext:async(t)=>{authCalls++;return t==='good'?{invalid:false,user:{id:'u1',email:'a@b'}}:{invalid:true}}}
};
const o=Module._load;Module._load=function(r,p,m){const f=Module._resolveFilename(r,p,m);return stubs[f]||o.apply(this,arguments)};
const {trackSession}=require(path.join(B,'middleware/sessionManager.js'));
(async()=>{let fails=0;const ck=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':' '+JSON.stringify(x)));if(!c)fails++};
 const run=t=>new Promise(res=>trackSession({headers:{authorization:'Bearer '+t},cookies:{},ip:'1',method:'GET',path:'/'},{status(){return{json(){res('401')}}}},()=>res('next')));
 for(let i=0;i<10;i++) await run('good');
 ck('uses cached login check, never Supabase Auth directly',getUserCalls===0&&authCalls===10,{getUserCalls,authCalls});
 ck('10 quick requests -> 1 Redis read, 1 Redis write',redisGets===1&&redisSets===1,{redisGets,redisSets});
 ck('bad token just continues',await run('bad')==='next');
 console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0)})();
