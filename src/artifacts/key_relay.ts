// Relay sandbox keys after page handlers; keep editing/modified keys native.
import {
  isNativeActivationKey,
  isTextEditorTarget,
} from "../keyboard_target.js";

export const ARTIFACT_KEY_RELAY = `<script id="recurse-pane-keys">(()=>{
  if(parent===window)return;
  const textEntry=${isTextEditorTarget.toString()};
  const nativeActivation=${isNativeActivationKey.toString()};
  addEventListener('keydown',(event)=>{
    if(event.ctrlKey||event.metaKey||event.altKey||(event.shiftKey&&!['G','P','H','J','K','L'].includes(event.key))||event.isComposing||event.keyCode===229||(event.repeat&&!['j','k','d','u'].includes(event.key)))return;
    if(event.composedPath().some(textEntry)||nativeActivation(event.key,event.target))return;
    setTimeout(()=>{
      if(!event.defaultPrevented)parent.postMessage({recurseArtifactKey:event.key},'*');
    },0);
  },true);
  addEventListener('message',(event)=>{
    if(event.source!==parent)return;
    const action=event.data?.recursePaneScroll;
    if(action==='top'||action==='bottom')window.scrollTo(0,action==='top'?0:document.documentElement.scrollHeight);
    else if(['next','previous','half-down','half-up'].includes(action))window.scrollBy(0,action==='next'?40:action==='previous'?-40:innerHeight*(action==='half-down'?0.5:-0.5));
  });
})()</script>`;
