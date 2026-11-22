// Injected before app scripts. Only the mounted viewer can persist saved state;
// standalone pages and publication checks get fresh, in-memory state instead.
import {
  APP_STATE_FRAGMENT,
  APP_STATE_INVALID,
  APP_STATE_MAX_BYTES,
  APP_STATE_TOO_LARGE,
} from "../artifact_app_state_protocol";

export const APP_STATE_SCRIPT = `<script id="recurse-app-state">(()=>{
  const prefix=${JSON.stringify(APP_STATE_FRAGMENT)};
  const token=parent!==window&&location.hash.startsWith(prefix)?location.hash.slice(prefix.length):'';
  let current='null', loaded=false, loadError, refused, ready, resolveReady, port, active, pending;
  if(token){
    const channel=new MessageChannel();
    port=channel.port1;
    port.onmessage=({data})=>{
      const resolve=resolveReady;
      if(data.type==='refused'){
        refused=new Error(data.error);
        resolve?.();
        active?.reject(refused);
        pending?.reject(refused);
        active=pending=undefined;
      }else if(data.type==='state'){
        loadError=data.error;
        const changed=loaded&&data.json!==undefined&&current!==data.json;
        if(data.json!==undefined){current=data.json;loaded=true}
        resolve();
        if(changed)dispatchEvent(new CustomEvent('recurse:statechange',{detail:JSON.parse(current)}));
      }else if(data.type==='saved'&&active){
        if(data.error)active.reject(new Error(data.error));
        else{current=active.json;loadError=undefined;loaded=true;resolve();active.resolve()}
        active=undefined;
        flush();
      }
    };
    parent.postMessage({type:'recurse-app-state:connect',token},'*',[channel.port2]);
  }
  const connect=()=>ready??=new Promise(resolve=>{
    resolveReady=resolve;
    if(refused)resolve();
    else port.postMessage({type:'load'});
  });
  const flush=()=>{
    if(active||!pending)return;
    active=pending;
    pending=undefined;
    port.postMessage({type:'save',json:active.json});
  };
  window.recurse={
    async getState(){
      if(token)await connect();
      if(refused)throw refused;
      if(loadError)throw new Error(loadError);
      return JSON.parse(current);
    },
    async setState(value){
      let json;
      try{
        json=JSON.stringify(value,(_key,item)=>{
          if(item===null||typeof item==='string'||typeof item==='boolean'||Number.isFinite(item)||Array.isArray(item)||
            (typeof item==='object'&&(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null)))return item;
          throw new Error();
        });
      }catch{throw new Error(${JSON.stringify(APP_STATE_INVALID)})}
      if(json.length>${APP_STATE_MAX_BYTES}||new TextEncoder().encode(json).byteLength>${APP_STATE_MAX_BYTES})throw new Error(${JSON.stringify(APP_STATE_TOO_LARGE)});
      if(!token){current=json;return}
      if(refused)throw refused;
      connect();
      if(pending){pending.json=json;return pending.promise}
      const next={json};
      next.promise=new Promise((resolve,reject)=>Object.assign(next,{resolve,reject}));
      pending=next;
      flush();
      return next.promise;
    },
  };
})()</script>`;
