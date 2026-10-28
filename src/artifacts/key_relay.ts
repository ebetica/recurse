// Relay sandbox keys after page handlers; keep editing/modified keys native.
export const ARTIFACT_KEY_RELAY = `<script id="recurse-pane-keys">(()=>{
  if(parent===window)return;
  addEventListener('keydown',(event)=>{
    if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.isComposing||event.keyCode===229||event.repeat)return;
    if(event.composedPath().some(node=>node instanceof Element&&(node.matches('input,textarea,select')||node.isContentEditable)))return;
    setTimeout(()=>{
      if(!event.defaultPrevented)parent.postMessage({recurseArtifactKey:event.key},'*');
    },0);
  },true);
})()</script>`;
