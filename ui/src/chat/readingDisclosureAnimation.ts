import { animate } from 'motion/mini';

export type ReadingDisclosureVisual = { play: () => void; complete: () => boolean };

/** Snapshot only visible mounted rows; final layout and native scroll remain untouched. */
export function captureReadingDisclosureVisual(scroller: HTMLElement, boxes: ReadonlyMap<string, HTMLElement>, affected: ReadonlySet<string>, bottom: number): ReadingDisclosureVisual | null {
  if (typeof Element.prototype.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const viewport = scroller.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.dataset.readingVisualOverlay = '';
  overlay.inert = true;
  overlay.setAttribute('aria-hidden','true');
  Object.assign(overlay.style,{position:'fixed',left:`${viewport.left}px`,top:`${viewport.top}px`,width:`${scroller.clientWidth}px`,height:`${scroller.clientHeight}px`,overflow:'hidden',pointerEvents:'none',zIndex:'1'});
  const visible=(rect:DOMRect)=>rect.bottom>viewport.top&&rect.top<viewport.top+scroller.clientHeight;
  const pendingScrolls:Array<()=>void>=[];
  const copyRow=(element:HTMLElement,rect:DOMRect)=>{
    const copy=element.cloneNode(true) as HTMLElement;
    const originals=[element,...element.querySelectorAll<HTMLElement>('*')];
    const copies=[copy,...copy.querySelectorAll<HTMLElement>('*')];
    for(const node of copies){
      for(const attribute of [...node.attributes])if(attribute.name==='id'||attribute.name==='tabindex'||attribute.name.startsWith('data-'))node.removeAttribute(attribute.name);
    }
    Object.assign(copy.style,{position:'absolute',left:`${rect.left-viewport.left}px`,top:`${rect.top-viewport.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:'0',transform:'none'});
    overlay.append(copy);
    const positions=originals.map(node=>({top:node.scrollTop,left:node.scrollLeft}));
    const restore=()=>{for(const [index,node] of copies.entries()){node.scrollTop=positions[index].top;node.scrollLeft=positions[index].left;}};
    if(overlay.isConnected)restore();else pendingScrolls.push(restore);
    return copy;
  };
  const before=new Map<string,{rect:DOMRect;copy:HTMLElement}>();
  for(const [key,element] of boxes){const rect=element.getBoundingClientRect();if(visible(rect)&&element.getAttribute('aria-busy')!=='true')before.set(key,{rect,copy:copyRow(element,rect)});}
  if(!before.size)return null;
  scroller.append(overlay);
  for(const restore of pendingScrolls)restore();pendingScrolls.length=0;
  scroller.setAttribute('data-reading-visual-commit','');
  const controls:Array<ReturnType<typeof animate>>=[];
  let completed=false;
  let started=false;
  const complete=()=>{
    if(completed)return false;
    completed=true;
    for(const control of controls){control.complete();control.cancel();}
    controls.length=0;before.clear();overlay.replaceChildren();
    scroller.removeAttribute('data-reading-visual-commit');
    overlay.remove();
    return true;
  };
  const run=(element:HTMLElement,transform:number,clip:number,exit=false)=>{
    controls.push(animate(element,{transform:exit?['translateY(0px)',`translateY(${transform}px)`]:[`translateY(${transform}px)`,'translateY(0px)'],clipPath:exit?['inset(0px)',`inset(0px 0px ${clip}px 0px)`]:[`inset(0px 0px ${clip}px 0px)`,'inset(0px)']},{duration:0.18,ease:'easeOut'}));
  };
  return {complete,play:()=>{
    if(completed||started)return;
    started=true;
    for(const [key,old] of before){
      const element=boxes.get(key);
      if(!element?.isConnected){
        if(affected.has(key))run(old.copy,bottom-(old.rect.bottom-viewport.top),old.rect.height,true);
        else old.copy.remove();
        continue;
      }
      const rect=element.getBoundingClientRect();
      const delta=old.rect.top-rect.top;
      if(affected.has(key)&&old.rect.height>rect.height+0.5){
        run(old.copy,-delta,old.rect.height-rect.height,true);
      }else{
        old.copy.remove();
        if(!visible(rect))continue;
        const copy=copyRow(element,rect);
        if(Math.abs(delta)>0.5||affected.has(key)&&rect.height>old.rect.height+0.5)run(copy,delta,affected.has(key)?Math.max(0,rect.height-old.rect.height):0);
      }
    }
    for(const [key,element] of boxes){
      if(before.has(key))continue;
      const rect=element.getBoundingClientRect();
      if(!visible(rect)||element.getAttribute('aria-busy')==='true')continue;
      const copy=copyRow(element,rect);
      if(affected.has(key))run(copy,Math.max(0,bottom-(rect.bottom-viewport.top)),rect.height);
    }
    void Promise.all(controls.map(control=>control.finished)).then(complete,error=>{const interrupted=completed;complete();if(!interrupted)queueMicrotask(()=>{throw error;});});
    if(!controls.length)complete();
  }};
}
