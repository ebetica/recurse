// Served HTML previews report their natural document height to the owning
// iframe. This changes neither immutable artifact bytes nor the sandbox/CSP.
// Inline scripts are already permitted; the parent validates the message
// source.
import { prependToHead, themedHtml } from "./theme";
import { ARTIFACT_KEY_RELAY } from "./key_relay";

export function artifactPreview(html: string, css: string): string {
  return prependToHead(
    themedHtml(html, css),
    ARTIFACT_KEY_RELAY +
      `<script id="recurse-preview-size">(()=>{
      if(parent===window)return;
      const start=()=>{
        const style=document.createElement('style');
        style.textContent='html{height:auto!important;overflow-y:hidden!important}body{height:auto!important;min-height:0!important}';
        document.head.append(style);
        const initialViewport=innerHeight;
        let last=0, lastViewport=innerHeight, queued=false, fallback=false;
        const report=()=>{
          queued=false;
          if(fallback)return;
          const body=document.body;
          const height=Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height)+parseFloat(getComputedStyle(body).marginTop||0)+parseFloat(getComputedStyle(body).marginBottom||0));
          // Viewport-sized content can grow with every iframe resize. Keep
          // those interactive layouts at their original viewport instead.
          if(height>30000||(innerHeight>lastViewport&&height>last&&Math.abs((height-last)-(innerHeight-lastViewport))<2)){
            fallback=true;style.remove();
            parent.postMessage({recurseArtifactHeight:initialViewport},'*');return;
          }
          lastViewport=innerHeight;
          if(height!==last){last=height;parent.postMessage({recurseArtifactHeight:height},'*')}
        };
        const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(report)}};
        new ResizeObserver(schedule).observe(document.body);
        new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
        addEventListener('resize',schedule);addEventListener('load',schedule);schedule();
      };
      if(document.readyState==='loading')addEventListener('DOMContentLoaded',start,{once:true});else start();
    })()</script>`,
  );
}
