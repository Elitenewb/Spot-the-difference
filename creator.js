(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const els = {
    manualTab:$('manualTab'), aiTab:$('aiTab'), manualPanel:$('manualPanel'), aiPanel:$('aiPanel'),
    modFile:$('modFile'), origFile:$('origFile'), aiOrigFile:$('aiOrigFile'), modCanvas:$('modCanvas'), origCanvas:$('origCanvas'),
    modFrame:$('modFrame'), origFrame:$('origFrame'), need:$('need'), regionList:$('regionList'), regionCount:$('regionCount'),
    exportBtn:$('exportBtn'), downloadImageBtn:$('downloadImageBtn'), downloadBothBtn:$('downloadBothBtn'), downloadReadyBtn:$('downloadReadyBtn'), importBtn:$('importBtn'), importFile:$('importFile'),
    clearBtn:$('clearPoints'), undoBtn:$('undoPoint'), aiClearBtn:$('aiClearBtn'), aiUndoBtn:$('aiUndoBtn'), aiGenerateBtn:$('aiGenerateBtn'),
    checkExtensionBtn:$('checkExtensionBtn'), extensionStatus:$('extensionStatus'), aiRunStatus:$('aiRunStatus'), aiProgress:$('aiProgress'), aiProgressBar:$('aiProgressBar'), aiProgressText:$('aiProgressText'),
    modBadge:$('modBadge'), diagnostics:$('creatorDiagnostics'), aiAdvanced:$('aiAdvanced'),
    uploadStep:$('uploadStep'), generateStep:$('generateStep'), editStep:$('editStep'), downloadStep:$('downloadStep'), aiRegionCount:$('aiRegionCount'),
    runDiagnostics:$('runCreatorDiagnostics'), loadClassroomFixture:$('loadClassroomFixture'), testLog:$('creatorTestLog')
  };

  const state = {
    mode:'ai', naturalW:0, naturalH:0, originalImage:null, modifiedImage:null,
    regions:[], appliedPatches:new Map(), workCanvas:document.createElement('canvas'), extensionConnected:false,
    dragging:false, dragStart:null, dragCurrent:null, selectedRegionId:null, activeJobId:null, aiBusy:false,
    editQueue:[], editCompleted:0, editTotal:0, jobTimer:null, workflowPhase:'idle', aiProgressPercent:0
  };

  const MIN_DRAG_PX = 5;
  const AUTO_EDIT_VARIANTS = [
    'Favor a clean removal or erasure: smoothly reconstruct the natural surface behind one visible feature, line, mark, or small object.',
    'Favor a conspicuous color, pattern, or material change to one existing feature while preserving its shape, lighting, and texture.',
    'Favor adding one scene-appropriate object or detail that looks as though it was always present.',
    'Favor swapping one existing item, letter, number, symbol, or decorative motif for a different plausible counterpart of similar visual weight.',
    'Favor a gently silly transformation such as changing an object\'s shape, scale, orientation, count, or material while keeping the scene believable.'
  ];
  const ctxOriginal = els.origCanvas.getContext('2d');
  const ctxModified = els.modCanvas.getContext('2d');

  function uid(prefix='region') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }
  function clamp(value,min,max){ return Math.max(min,Math.min(max,value)); }
  function dpr(){ return Math.max(1,window.devicePixelRatio||1); }
  function expectedCount(){ return state.mode==='ai'?10:clamp(Number(els.need.value)||10,1,30); }
  function setAiProgress(value){
    const percent=clamp(Math.round(value),0,100);
    state.aiProgressPercent=percent;
    els.aiProgress.style.width=`${percent}%`;
    els.aiProgressText.textContent=`${percent}%`;
    els.aiProgressBar.setAttribute('aria-valuenow',String(percent));
  }
  function editStageProgress(stage){
    const weight={uploading:.06,attached:.16,submitted:.3,editing:.4,opening:.78}[stage]??.03;
    return 15+((state.editCompleted+weight)/Math.max(1,state.editTotal))*85;
  }

  function resetWorkspace(){
    clearJobTimer();
    state.naturalW=0; state.naturalH=0; state.originalImage=null; state.modifiedImage=null;
    state.regions=[]; state.appliedPatches.clear(); state.workCanvas.width=0; state.workCanvas.height=0;
    state.selectedRegionId=null; state.activeJobId=null; state.aiBusy=false; state.editQueue=[];
    for(const input of [els.modFile,els.origFile,els.aiOrigFile]) input.value='';
    updateRegionList(); fitCanvasSize();
  }

  function setMode(mode){
    if(state.mode!==mode&&(state.originalImage||state.modifiedImage||state.regions.length)){
      if(!window.confirm('Switching creator modes clears the current puzzle workspace. Continue?'))return;
      resetWorkspace();
    }
    state.mode=mode;
    const manual=mode==='manual';
    els.manualTab.setAttribute('aria-selected',String(manual));
    els.aiTab.setAttribute('aria-selected',String(!manual));
    els.manualPanel.hidden=!manual;
    els.aiPanel.hidden=manual;
    document.body.classList.toggle('ai-simple',!manual);
    document.body.classList.toggle('advanced-open',!manual&&els.aiAdvanced.open);
    els.modBadge.textContent=manual?'Modified — drag to mark a region':'Original photo — drag to mark 10 areas';
    updateControls();
    if(!manual) pingExtension();
  }

  function setExtensionStatus(kind,message){
    els.extensionStatus.className=`status ${kind||''}`.trim();
    els.extensionStatus.lastElementChild.textContent=message;
    els.checkExtensionBtn.hidden=kind!=='error';
  }

  function imageFromDataUrl(dataUrl){
    return new Promise((resolve,reject)=>{
      const image=new Image();
      image.onload=()=>resolve(image);
      image.onerror=()=>reject(new Error('Image could not be decoded'));
      image.src=dataUrl;
    });
  }

  function fileToDataUrl(file){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(new Error('File could not be read'));
      reader.readAsDataURL(file);
    });
  }

  async function loadManualImage(file,side){
    const dataUrl=await fileToDataUrl(file);
    const image=await imageFromDataUrl(dataUrl);
    const other=side==='modified'?state.originalImage:state.modifiedImage;
    if(other&&(other.naturalWidth!==image.naturalWidth||other.naturalHeight!==image.naturalHeight)){
      throw new Error(`Image dimensions must match. Expected ${other.naturalWidth}×${other.naturalHeight}, received ${image.naturalWidth}×${image.naturalHeight}.`);
    }
    if(side==='modified') state.modifiedImage=image;
    else state.originalImage=image;
    state.naturalW=image.naturalWidth; state.naturalH=image.naturalHeight;
    if(state.originalImage&&state.modifiedImage) initializeWorkCanvasFromModified();
    fitCanvasSize();
  }

  async function loadAiOriginal(file){
    const dataUrl=await fileToDataUrl(file);
    const original=await imageFromDataUrl(dataUrl);
    const modified=await imageFromDataUrl(dataUrl);
    state.originalImage=original;
    state.modifiedImage=modified;
    state.naturalW=original.naturalWidth;
    state.naturalH=original.naturalHeight;
    state.regions=[];
    state.appliedPatches.clear();
    initializeWorkCanvasFromModified();
    fitCanvasSize();
    updateRegionList();
    state.workflowPhase='idle'; setAiProgress(0);
    els.aiRunStatus.textContent='Photo ready. Drag 10 boxes on the preview.';
    updateControls();
  }

  async function loadDebugClassroomFixture(){
    try{
      setMode('ai');
      const response=await fetch('tests/fixtures/classroom-scene.svg',{cache:'no-store'});
      if(!response.ok)throw new Error(`fixture request failed (${response.status})`);
      await loadAiOriginal(await response.blob());
      els.aiRunStatus.textContent='Synthetic 1200×675 classroom fixture loaded. Draw 10 boxes on the preview.';
    }catch(error){
      els.testLog.textContent=`FAIL: could not load bridge fixture: ${error.message}`;
    }
  }

  function initializeWorkCanvasFromModified(){
    state.workCanvas.width=state.naturalW;
    state.workCanvas.height=state.naturalH;
    const ctx=state.workCanvas.getContext('2d');
    ctx.clearRect(0,0,state.naturalW,state.naturalH);
    if(state.modifiedImage) ctx.drawImage(state.modifiedImage,0,0,state.naturalW,state.naturalH);
  }

  function setFrameAspect(){
    const ratio=state.naturalW&&state.naturalH?`${state.naturalW}/${state.naturalH}`:'4/3';
    els.modFrame.style.aspectRatio=ratio;
    els.origFrame.style.aspectRatio=ratio;
  }

  function fitCanvasSize(){
    setFrameAspect();
    for(const canvas of [els.modCanvas,els.origCanvas]){
      const cssW=Math.max(1,canvas.parentElement.clientWidth);
      const cssH=Math.max(1,canvas.parentElement.clientHeight);
      canvas.width=Math.round(cssW*dpr());
      canvas.height=Math.round(cssH*dpr());
      canvas.style.width=`${cssW}px`;
      canvas.style.height=`${cssH}px`;
      canvas.getContext('2d').setTransform(dpr(),0,0,dpr(),0,0);
    }
    draw();
  }

  function draw(){
    const w=els.modCanvas.clientWidth,h=els.modCanvas.clientHeight;
    for(const canvas of [els.modCanvas,els.origCanvas]){
      canvas.dataset.naturalWidth=String(state.naturalW||0);
      canvas.dataset.naturalHeight=String(state.naturalH||0);
    }
    ctxModified.clearRect(0,0,w,h);
    ctxOriginal.clearRect(0,0,w,h);
    if(state.originalImage) ctxOriginal.drawImage(state.originalImage,0,0,w,h);
    if(state.workCanvas.width&&state.workCanvas.height) ctxModified.drawImage(state.workCanvas,0,0,w,h);
    else if(state.modifiedImage) ctxModified.drawImage(state.modifiedImage,0,0,w,h);
    for(const region of state.regions){
      drawGuide(els.modCanvas,region);
      if(state.mode==='manual')drawGuide(els.origCanvas,region);
    }
    if(state.dragging&&state.dragStart&&state.dragCurrent){
      const preview=normToRect(state.dragStart,state.dragCurrent);
      drawDragPreview(els.modCanvas,preview);
      if(state.mode==='manual')drawDragPreview(els.origCanvas,preview);
    }
    updateControls();
  }

  function drawGuide(canvas,region){
    const ctx=canvas.getContext('2d');
    const x=region.xNorm*canvas.clientWidth,y=region.yNorm*canvas.clientHeight;
    const w=region.wNorm*canvas.clientWidth,h=region.hNorm*canvas.clientHeight;
    const selected=region.id===state.selectedRegionId;
    ctx.save();
    ctx.fillStyle=selected?'rgba(255,200,87,.13)':'rgba(123,212,255,.06)';
    ctx.fillRect(x,y,w,h);
    ctx.strokeStyle=selected?'#ffc857':'#7bd4ff';
    ctx.setLineDash([8,6]); ctx.lineWidth=selected?2.5:1.5; ctx.strokeRect(x,y,w,h);
    ctx.fillStyle=selected?'#ffc857':'#7bd4ff';
    ctx.font='bold 12px system-ui'; ctx.fillText(String(state.regions.indexOf(region)+1),x+5,y+15);
    ctx.restore();
  }

  function drawDragPreview(canvas,region){
    const ctx=canvas.getContext('2d');
    const x=region.xNorm*canvas.clientWidth,y=region.yNorm*canvas.clientHeight;
    const w=region.wNorm*canvas.clientWidth,h=region.hNorm*canvas.clientHeight;
    ctx.save(); ctx.fillStyle='rgba(123,212,255,.14)'; ctx.fillRect(x,y,w,h);
    ctx.strokeStyle='#7bd4ff'; ctx.setLineDash([6,4]); ctx.lineWidth=2; ctx.strokeRect(x,y,w,h); ctx.restore();
  }

  function canvasToNorm(event,canvas){
    const rect=canvas.getBoundingClientRect();
    return {xNorm:clamp((event.clientX-rect.left)/rect.width,0,1),yNorm:clamp((event.clientY-rect.top)/rect.height,0,1)};
  }
  function normToRect(a,b){ return {xNorm:Math.min(a.xNorm,b.xNorm),yNorm:Math.min(a.yNorm,b.yNorm),wNorm:Math.abs(a.xNorm-b.xNorm),hNorm:Math.abs(a.yNorm-b.yNorm)}; }
  function dragDistance(a,b){ return Math.hypot((a.xNorm-b.xNorm)*els.modCanvas.clientWidth,(a.yNorm-b.yNorm)*els.modCanvas.clientHeight); }

  function beginDrag(event){
    if(!state.naturalW||state.regions.length>=expectedCount()||state.aiBusy||state.appliedPatches.size) return;
    if(typeof event.preventDefault==='function')event.preventDefault();
    state.dragging=true; state.dragStart=canvasToNorm(event,els.modCanvas); state.dragCurrent=state.dragStart;
  }
  function moveDrag(event){ if(!state.dragging)return; if(typeof event.preventDefault==='function')event.preventDefault(); state.dragCurrent=canvasToNorm(event,els.modCanvas); draw(); }
  function endDrag(){
    if(!state.dragging)return;
    state.dragging=false;
    const end=state.dragCurrent||state.dragStart;
    if(dragDistance(state.dragStart,end)>=MIN_DRAG_PX){
      const rect=normToRect(state.dragStart,end);
      state.regions.push({...rect,id:uid(),instruction:state.mode==='ai'?'':defaultInstruction(),status:'pending',source:'manual'});
    }
    state.dragStart=null; state.dragCurrent=null; updateSelectionStatus(); updateRegionList(); draw();
  }

  function defaultInstruction(){ return 'Make one clear but natural-looking addition or replacement inside the selected area. Preserve lighting, perspective, texture, and everything outside the target.'; }

  function validRegion(region){
    return ['xNorm','yNorm','wNorm','hNorm'].every(key=>Number.isFinite(region[key]))&&region.wNorm>.006&&region.hNorm>.006&&region.xNorm>=0&&region.yNorm>=0&&region.xNorm+region.wNorm<=1&&region.yNorm+region.hNorm<=1;
  }

  function regionSummary(region){ return `${(region.xNorm*100).toFixed(1)}%, ${(region.yNorm*100).toFixed(1)}% · ${(region.wNorm*100).toFixed(1)}×${(region.hNorm*100).toFixed(1)}%`; }

  function updateRegionList(){
    const focusedRegion=document.activeElement?.closest?.('.region-item')?.dataset.id;
    const focusedSelection=document.activeElement?.tagName==='TEXTAREA'?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
    els.regionCount.textContent=`${state.regions.length} / ${expectedCount()}`;
    if(!state.regions.length){ els.regionList.innerHTML=`<div class="region-empty">${state.mode==='ai'?'Draw numbered boxes on the preview. Optional instructions will appear here.':'Drag rectangles on the modified image.'}</div>`; updateControls(); return; }
    els.regionList.innerHTML='';
    state.regions.forEach((region,index)=>{
      const item=document.createElement('div'); item.className='region-item'; item.dataset.id=region.id;
      const stateClass=region.status==='done'?'done':region.status==='error'?'error':'';
      if(state.mode==='ai'){
        item.innerHTML=`<div class="region-head"><span class="region-index">${index+1}</span><span class="region-label">${escapeHtml(regionSummary(region))}</span><span class="region-state ${stateClass}">${escapeHtml(region.status||'pending')}</span></div><textarea aria-label="Optional edit instruction for region ${index+1}" placeholder="Optional — leave blank and ChatGPT will choose">${escapeHtml(region.instruction||'')}</textarea><div class="region-actions"><button data-action="select">Show</button></div>`;
        item.querySelector('textarea').addEventListener('input',event=>{ region.instruction=event.target.value; updateControls(); });
        item.querySelector('textarea').disabled=!['pending','queued'].includes(region.status||'pending');
      }else{
        item.innerHTML=`<div class="region-head"><span class="region-index">${index+1}</span><span class="region-label">${escapeHtml(regionSummary(region))}</span></div><div class="region-actions"><button data-action="select">Show</button><button data-action="remove" class="danger">Remove</button></div>`;
      }
      item.addEventListener('click',event=>{
        const action=event.target.dataset.action; if(!action)return;
        if(state.aiBusy&&action!=='select')return;
        if(action==='select'){ state.selectedRegionId=region.id; draw(); item.scrollIntoView({block:'nearest'}); }
        if(action==='remove'){ state.appliedPatches.delete(region.id); state.regions=state.regions.filter(r=>r.id!==region.id); recomposeAllPatches(); updateRegionList(); draw(); }
      });
      els.regionList.appendChild(item);
    });
    if(focusedRegion&&focusedSelection){
      const textarea=[...els.regionList.querySelectorAll('.region-item')].find(item=>item.dataset.id===focusedRegion)?.querySelector('textarea');
      if(textarea&&!textarea.disabled){textarea.focus();textarea.setSelectionRange(...focusedSelection);}
    }
    updateControls();
  }

  function escapeHtml(value){ const div=document.createElement('div'); div.textContent=String(value??''); return div.innerHTML; }

  function updateSelectionStatus(){
    if(state.mode!=='ai'||!state.originalImage||state.aiBusy)return;
    const remaining=expectedCount()-state.regions.length;
    els.aiRunStatus.textContent=remaining>0?`${state.regions.length} of 10 areas marked. Draw ${remaining} more.`:'All 10 areas marked. Click Generate puzzle.';
  }

  function updateControls(){
    const countMatches=state.regions.length===expectedCount();
    const hasImages=!!(state.originalImage&&state.modifiedImage&&state.naturalW);
    const aiReady=state.mode==='ai'&&state.extensionConnected&&!!state.originalImage&&!state.aiBusy;
    const allEditsDone=countMatches&&state.regions.length>0&&state.regions.every(region=>region.status==='done');
    if(state.mode==='ai')els.modBadge.textContent=allEditsDone?'Finished puzzle preview':state.aiBusy?'Puzzle preview — edits appear here':'Original photo — drag to mark 10 areas';
    els.uploadStep.classList.toggle('done',!!state.originalImage);
    els.generateStep.classList.toggle('done',countMatches);
    els.editStep.classList.toggle('done',allEditsDone);
    els.downloadStep.classList.toggle('done',allEditsDone);
    if(state.aiBusy)els.aiGenerateBtn.textContent='Cancel generation';
    else if(allEditsDone)els.aiGenerateBtn.textContent='Puzzle ready';
    else if(!state.originalImage)els.aiGenerateBtn.textContent='Upload a photo first';
    else if(!countMatches)els.aiGenerateBtn.textContent=`Mark ${expectedCount()-state.regions.length} more area${expectedCount()-state.regions.length===1?'':'s'}`;
    else if(!state.extensionConnected)els.aiGenerateBtn.textContent='Waiting for connection';
    else els.aiGenerateBtn.textContent='Generate puzzle';
    els.aiGenerateBtn.disabled=state.aiBusy?false:(!aiReady||!countMatches||allEditsDone);
    els.aiGenerateBtn.classList.toggle('danger',state.aiBusy);
    els.aiGenerateBtn.classList.toggle('primary',!state.aiBusy);
    els.exportBtn.disabled=!(hasImages&&countMatches);
    els.downloadImageBtn.disabled=!hasImages;
    els.downloadBothBtn.disabled=!(hasImages&&countMatches);
    els.downloadReadyBtn.disabled=!allEditsDone;
    els.downloadReadyBtn.textContent=allEditsDone?'Download image + config':'Waiting for generation';
    els.clearBtn.disabled=!state.regions.length||state.aiBusy;
    els.undoBtn.disabled=!state.regions.length||state.aiBusy;
    els.aiClearBtn.disabled=!state.regions.length||state.aiBusy||state.appliedPatches.size>0;
    els.aiUndoBtn.disabled=!state.regions.length||state.aiBusy||state.appliedPatches.size>0;
    els.manualTab.disabled=state.aiBusy;
    els.aiTab.disabled=state.aiBusy;
    els.aiOrigFile.disabled=state.aiBusy;
    els.need.disabled=state.aiBusy;
    els.regionCount.textContent=`${state.regions.length} / ${expectedCount()}`;
    els.aiRegionCount.textContent=`${state.regions.length} / 10`;
  }

  function cropGeometry(region){
    const x=region.xNorm*state.naturalW,y=region.yNorm*state.naturalH,w=region.wNorm*state.naturalW,h=region.hNorm*state.naturalH;
    const cropW=Math.max(1,Math.round(w)),cropH=Math.max(1,Math.round(h));
    const sourceX=x,sourceY=y,sourceW=w,sourceH=h;
    const pasteX=x,pasteY=y,pasteW=w,pasteH=h;
    const targetX=0,targetY=0,targetW=cropW,targetH=cropH;
    // The uploaded image contains exactly the user-drawn selection. It is
    // sampled into an integer-sized canvas, then pasted back to the same bounds.
    const applyX=targetX,applyY=targetY,applyW=targetW,applyH=targetH;
    return {cropX:sourceX,cropY:sourceY,cropW,cropH,sourceX,sourceY,sourceW,sourceH,pasteX,pasteY,pasteW,pasteH,targetX,targetY,targetW,targetH,applyX,applyY,applyW,applyH};
  }

  function makeCrop(region){
    const geometry=cropGeometry(region);
    const canvas=document.createElement('canvas'); canvas.width=geometry.cropW; canvas.height=geometry.cropH;
    canvas.getContext('2d').drawImage(state.workCanvas,geometry.sourceX,geometry.sourceY,geometry.sourceW,geometry.sourceH,0,0,geometry.cropW,geometry.cropH);
    return {dataUrl:canvas.toDataURL('image/png'),geometry};
  }

  function downloadBlob(blob,name){
    const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function downloadDataUrl(dataUrl,name){ const link=document.createElement('a'); link.href=dataUrl; link.download=name; document.body.appendChild(link); link.click(); link.remove(); }
  function editFrameSourceRect(image,geometry){
    const expectedRatio=geometry.cropW/geometry.cropH;
    const returnedRatio=image.naturalWidth/image.naturalHeight;
    if(returnedRatio>expectedRatio){
      const width=image.naturalHeight*expectedRatio;
      return {x:(image.naturalWidth-width)/2,y:0,width,height:image.naturalHeight};
    }
    const height=image.naturalWidth/expectedRatio;
    return {x:0,y:(image.naturalHeight-height)/2,width:image.naturalWidth,height};
  }

  function normalizeEditFrame(image,geometry){
    const source=editFrameSourceRect(image,geometry);
    const canvas=document.createElement('canvas'); canvas.width=geometry.cropW; canvas.height=geometry.cropH;
    canvas.getContext('2d').drawImage(image,source.x,source.y,source.width,source.height,0,0,geometry.cropW,geometry.cropH);
    return canvas;
  }

  async function applyPatch(region,dataUrl){
    const image=await imageFromDataUrl(dataUrl);
    const geometry=cropGeometry(region);
    // Image generation may redraw or re-encode the whole crop and may return a
    // different aspect ratio. Normalize it once, then rely on the deterministic
    // exact-target compositor below instead of rejecting a visually valid result.
    const normalizedDataUrl=normalizeEditFrame(image,geometry).toDataURL('image/png');
    state.appliedPatches.set(region.id,{dataUrl:normalizedDataUrl,geometry});
    await recomposeAllPatches();
    region.status='done';
    updateRegionList(); draw();
  }

  async function recomposeAllPatches(){
    initializeWorkCanvasFromModifiedBase();
    for(const region of state.regions){
      const saved=state.appliedPatches.get(region.id); if(!saved)continue;
      const image=await imageFromDataUrl(saved.dataUrl);
      compositePatch(region,image,saved.geometry||cropGeometry(region));
    }
    draw();
  }

  function initializeWorkCanvasFromModifiedBase(){
    const ctx=state.workCanvas.getContext('2d');
    state.workCanvas.width=state.naturalW; state.workCanvas.height=state.naturalH;
    ctx.clearRect(0,0,state.naturalW,state.naturalH);
    if(state.mode==='ai'&&state.originalImage) ctx.drawImage(state.originalImage,0,0,state.naturalW,state.naturalH);
    else if(state.modifiedImage) ctx.drawImage(state.modifiedImage,0,0,state.naturalW,state.naturalH);
  }

  function compositePatch(region,image,geometry){
    const scaled=document.createElement('canvas'); scaled.width=geometry.cropW; scaled.height=geometry.cropH;
    const sctx=scaled.getContext('2d'); sctx.drawImage(image,0,0,geometry.cropW,geometry.cropH);
    const applyX=geometry.applyX??geometry.targetX,applyY=geometry.applyY??geometry.targetY;
    const applyW=geometry.applyW??geometry.targetW,applyH=geometry.applyH??geometry.targetH;
    const patch=document.createElement('canvas'); patch.width=applyW; patch.height=applyH;
    const pctx=patch.getContext('2d');
    pctx.drawImage(scaled,applyX,applyY,applyW,applyH,0,0,applyW,applyH);
    const pixels=pctx.getImageData(0,0,applyW,applyH);
    const feather=Math.max(3,Math.min(18,Math.floor(Math.min(applyW,applyH)*.1)));
    for(let y=0;y<applyH;y++) for(let x=0;x<applyW;x++){
      const edge=Math.min(x,y,applyW-1-x,applyH-1-y);
      const alpha=clamp(edge/feather,0,1);
      pixels.data[(y*applyW+x)*4+3]*=alpha;
    }
    pctx.putImageData(pixels,0,0);
    const pasteX=geometry.pasteX??geometry.cropX+applyX,pasteY=geometry.pasteY??geometry.cropY+applyY;
    const pasteW=geometry.pasteW??applyW,pasteH=geometry.pasteH??applyH;
    state.workCanvas.getContext('2d').drawImage(patch,0,0,applyW,applyH,pasteX,pasteY,pasteW,pasteH);
  }

  function revealBounds(region){
    const saved=state.appliedPatches.get(region.id);
    if(!saved?.geometry)return null;
    const geometry=saved.geometry;
    const applyX=geometry.applyX??geometry.targetX,applyY=geometry.applyY??geometry.targetY;
    const applyW=geometry.applyW??geometry.targetW,applyH=geometry.applyH??geometry.targetH;
    if(applyX===geometry.targetX&&applyY===geometry.targetY&&applyW===geometry.targetW&&applyH===geometry.targetH)return null;
    return {
      xNorm:(geometry.cropX+applyX)/state.naturalW,
      yNorm:(geometry.cropY+applyY)/state.naturalH,
      wNorm:applyW/state.naturalW,
      hNorm:applyH/state.naturalH
    };
  }

  function configJson(){
    const regions=state.regions.map(region=>{
      const {xNorm,yNorm,wNorm,hNorm}=region;
      const reveal=revealBounds(region);
      return reveal?{xNorm,yNorm,wNorm,hNorm,reveal}:{xNorm,yNorm,wNorm,hNorm};
    });
    return JSON.stringify({version:3,natural:{w:state.naturalW,h:state.naturalH},regions,need:expectedCount()},null,2);
  }
  function downloadConfig(){ downloadBlob(new Blob([configJson()],{type:'application/json'}),'spot-config.json'); }
  function downloadModified(){ downloadDataUrl(state.workCanvas.toDataURL('image/png'),'spot-modified.png'); }

  function pingExtension(){
    setExtensionStatus('', 'Checking for extension…');
    window.postMessage({source:'spot-diff-app',type:'SPOT_DIFF_EXTENSION_PING'},'*');
    setTimeout(()=>{ if(!state.extensionConnected)setExtensionStatus('error','AI Bridge extension not detected'); },1200);
  }

  function postToExtension(type,payload){ window.postMessage({source:'spot-diff-app',type,payload},'*'); }

  function clearJobTimer(){
    if(state.jobTimer){ clearTimeout(state.jobTimer); state.jobTimer=null; }
  }

  function armJobTimer(milliseconds, label){
    clearJobTimer();
    const jobId=state.activeJobId;
    state.jobTimer=setTimeout(()=>{
      if(state.aiBusy&&state.activeJobId===jobId) failAi(`${label} timed out. Check the ChatGPT window, then retry.`);
    },milliseconds);
  }

  async function runCreatorDiagnostics(){
    const results=[];
    const expect=(name,condition)=>results.push(`${condition?'PASS':'FAIL'}: ${name}`);
    try{
      state.mode='ai';
      const source=document.createElement('canvas'); source.width=1200; source.height=675;
      const sctx=source.getContext('2d');
      const gradient=sctx.createLinearGradient(0,0,1200,675); gradient.addColorStop(0,'#27496d'); gradient.addColorStop(1,'#d67d3e');
      sctx.fillStyle=gradient; sctx.fillRect(0,0,1200,675);
      sctx.fillStyle='#f5e9cf'; for(let y=70;y<620;y+=130) for(let x=90;x<1120;x+=210)sctx.fillRect(x,y,54,34);
      const dataUrl=source.toDataURL('image/png');
      state.originalImage=await imageFromDataUrl(dataUrl); state.modifiedImage=await imageFromDataUrl(dataUrl);
      state.naturalW=1200; state.naturalH=675; state.appliedPatches.clear(); initializeWorkCanvasFromModifiedBase();
      state.regions=[];
      for(let i=0;i<10;i++) state.regions.push({id:uid(),xNorm:.06+(i%5)*.19,yNorm:.13+Math.floor(i/5)*.52,wNorm:.065,hNorm:.085,instruction:`Remove the small light rectangle ${i+1}.`,status:'pending',source:'diagnostic'});
      const first=state.regions[0],crop=makeCrop(first),geometry=crop.geometry;
      const edited=document.createElement('canvas'); edited.width=geometry.cropW; edited.height=geometry.cropH;
      edited.getContext('2d').drawImage(await imageFromDataUrl(crop.dataUrl),0,0);
      edited.getContext('2d').fillStyle='#e22635'; edited.getContext('2d').fillRect(0,0,geometry.cropW,geometry.cropH);
      const before=source.getContext('2d').getImageData(0,0,1,1).data.join(',');
      const outsideX=Math.max(0,Math.floor(geometry.pasteX)-5),outsideY=Math.floor(geometry.pasteY+geometry.pasteH/2);
      const outsideBefore=source.getContext('2d').getImageData(outsideX,outsideY,1,1).data.join(',');
      await applyPatch(first,edited.toDataURL('image/png'));
      const centerX=Math.floor(geometry.pasteX+geometry.pasteW/2),centerY=Math.floor(geometry.pasteY+geometry.pasteH/2);
      const center=state.workCanvas.getContext('2d').getImageData(centerX,centerY,1,1).data;
      const outsideSelection=state.workCanvas.getContext('2d').getImageData(outsideX,outsideY,1,1).data.join(',');
      const outside=state.workCanvas.getContext('2d').getImageData(0,0,1,1).data.join(',');
      const parsed=JSON.parse(configJson());
      expect('native resolution is preserved',state.workCanvas.width===1200&&state.workCanvas.height===675);
      expect('ten regions are present',state.regions.length===10);
      expect('all normalized regions are valid',state.regions.every(validRegion));
      expect('uploaded crop contains only the exact selected area',geometry.targetX===0&&geometry.targetY===0&&geometry.cropW===geometry.targetW&&geometry.cropH===geometry.targetH&&geometry.sourceX===first.xNorm*state.naturalW&&geometry.sourceY===first.yNorm*state.naturalH&&geometry.sourceW===first.wNorm*state.naturalW&&geometry.sourceH===first.hNorm*state.naturalH);
      expect('composite area exactly matches the drawn box',geometry.applyX===geometry.targetX&&geometry.applyY===geometry.targetY&&geometry.applyW===geometry.targetW&&geometry.applyH===geometry.targetH);
      const normalizedSource=editFrameSourceRect({naturalWidth:2109,naturalHeight:746},geometry);
      expect('wide editor output is center-cropped instead of regenerated',normalizedSource.width<2109&&normalizedSource.height===746);
      state.regions[1].instruction='';
      const automaticPrompt=editPrompt(state.regions[1],cropGeometry(state.regions[1]),1);
      expect('blank instructions use the indexed edit-variety rotation',automaticPrompt.includes(AUTO_EDIT_VARIANTS[1]));
      state.regions[2].instruction='Add a bright red bow inside this area.';
      const customPrompt=editPrompt(state.regions[2],cropGeometry(state.regions[2]),2);
      expect('custom instructions are passed into the edit prompt',customPrompt.includes('Perform this requested change: Add a bright red bow inside this area.'));
      expect('edited center pixel is composited',center[0]>180&&center[1]<80);
      expect('pixel beside the drawn box is not changed',outsideSelection===outsideBefore);
      expect('pixel outside the drawn box remains unchanged',outside===before);
      expect('patch is tracked for deterministic recomposition',state.appliedPatches.has(first.id));
      expect('version 3 export preserves region count',parsed.version===3&&parsed.regions.length===10&&parsed.need===10);
      updateRegionList(); fitCanvasSize(); updateControls();
    }catch(error){ results.push(`FAIL: diagnostic threw ${error.message}`); }
    els.testLog.textContent=results.join('\n');
  }

  function editPrompt(region,geometry,index){
    const instruction=String(region.instruction||'').trim();
    const requested=instruction
      ?`Perform this requested change: ${instruction}`
      :`Choose and perform one clear, playful, natural-looking change to the main visible feature intersecting the target center. ${AUTO_EDIT_VARIANTS[index%AUTO_EDIT_VARIANTS.length]} Make it noticeable at normal full-image viewing size; do not change a person's identity.`;
    return `TOOL POLICY: Do not call Adobe, Photoshop, Canva, or any other external app, connected app, plugin, or editing tool. Do not open an external editor or ask for tool permission. Perform the image edit directly in this ChatGPT conversation and return the edited image. This uploaded image contains exactly the user-selected area for a fun classroom spot-the-difference puzzle; there are no surrounding context pixels. The entire image is the editable target. Keep changes harmless, playful, and visually clear; playful face edits such as changing glasses, adding a silly accessory, or making a gentle expression change are welcome when they preserve identity and remain non-graphic. ${requested} Never add margins, padding, borders, or new canvas area. Never add, remove, replace, or alter a mustache, and avoid facial-hair jokes. Never move a whole limb, change a person's pose or body position, or reposition the subject. Keep it localized, seamless, believable, and gently amusing when it is a visual joke. A removed human feature must look like a clean, harmless visual oddity with natural uninjured skin—never a wound, gore, distress, or grotesque disfigurement. Preserve this image's exact rectangular framing and aspect ratio: do not crop, zoom, pan, translate, rotate, stretch, extend, or reframe it. Preserve lighting, texture, color profile, sharpness, and all unrelated details inside the selection. Do not add labels, highlights, watermarks, or explanatory text. Return one edited image only. This is edit ${index+1} of ${state.regions.length}.`;
  }

  function startAiWorkflow(){
    if(state.aiBusy)return;
    if(state.regions.length!==expectedCount()){ updateSelectionStatus(); return; }
    const pending=state.regions.filter(region=>region.status!=='done');
    if(pending.length)startEditQueue(pending);
  }

  function startEditQueue(regions){
    if(state.aiBusy||!state.extensionConnected||!regions.length)return;
    state.aiBusy=true; state.activeJobId=uid('edit'); state.workflowPhase='editing'; setAiProgress(15);
    setExtensionStatus('busy','ChatGPT edit queue is running…');
    els.aiRunStatus.textContent=`Preparing ${regions.length} crop edit${regions.length===1?'':'s'}…`;
    state.editQueue=regions.map(region=>{region.status='queued';return region.id;});
    state.editCompleted=0; state.editTotal=state.editQueue.length;
    updateRegionList(); updateControls();
    sendNextEdit();
  }

  function sendNextEdit(){
    const regionId=state.editQueue[0];
    if(!regionId){
      clearJobTimer(); state.aiBusy=false; state.workflowPhase='complete'; setAiProgress(100); setExtensionStatus('connected','Edit queue complete');
      els.aiRunStatus.textContent='Puzzle complete. Download both files in step 4.'; updateRegionList(); updateControls();
      return;
    }
    const region=state.regions.find(item=>item.id===regionId);
    if(!region){state.editQueue.shift();sendNextEdit();return;}
    const crop=makeCrop(region);
    const edit={regionId:region.id,imageDataUrl:crop.dataUrl,prompt:editPrompt(region,crop.geometry,state.regions.indexOf(region))};
    region.status='editing';
    els.aiRunStatus.textContent=`Creating difference ${state.editCompleted+1} of ${state.editTotal}…`;
    updateRegionList();
    armJobTimer(360000,`Edit ${state.editCompleted+1}`);
    postToExtension('SPOT_DIFF_EDIT_ONE',{jobId:state.activeJobId,edit});
  }

  function failAi(message){
    clearJobTimer(); state.aiBusy=false; state.editQueue=[]; state.activeJobId=uid('cancelled'); setExtensionStatus('error',message); els.aiRunStatus.textContent=message;
    const retryableStates=new Set(['queued','editing','uploading','attached','submitted']);
    for(const region of state.regions) if(retryableStates.has(region.status))region.status='pending';
    updateRegionList(); updateControls();
  }

  function cancelAi(){
    if(!state.aiBusy)return;
    const jobId=state.activeJobId;
    postToExtension('SPOT_DIFF_CANCEL',{jobId});
    failAi('Current ChatGPT job cancelled. You can adjust the puzzle and retry.');
    state.workflowPhase='idle'; setAiProgress(0);
  }

  function finishCancelled(message='Generation cancelled. Ready when you want to try again.'){
    clearJobTimer(); state.aiBusy=false; state.editQueue=[]; state.activeJobId=uid('cancelled'); state.workflowPhase='idle'; setAiProgress(0);
    const retryableStates=new Set(['queued','editing','uploading','attached','submitted']);
    for(const region of state.regions)if(retryableStates.has(region.status))region.status='pending';
    state.extensionConnected=true; setExtensionStatus('connected','Ready'); els.aiRunStatus.textContent=message;
    updateRegionList(); updateControls();
  }

  window.addEventListener('message',async event=>{
    if(event.source!==window||event.data?.source!=='spot-diff-extension')return;
    const {type,payload}=event.data;
    if(type==='SPOT_DIFF_EXTENSION_PONG'){
      state.extensionConnected=true; setExtensionStatus('connected','Ready'); updateControls();
    }
    if(type==='SPOT_DIFF_AI_PROGRESS'&&payload?.jobId===state.activeJobId){
      els.aiRunStatus.textContent=payload.message||'ChatGPT is working…';
      const region=state.regions.find(item=>item.id===payload.regionId);
      if(region)region.status=payload.stage||'editing';
      setAiProgress(Math.max(state.aiProgressPercent,editStageProgress(payload.stage)));
      updateRegionList();
    }
    if(type==='SPOT_DIFF_EDIT_PROGRESS'&&payload?.jobId===state.activeJobId){
      const region=state.regions.find(item=>item.id===payload.regionId);
      if(region) region.status=payload.status||'editing';
      setAiProgress(Math.max(state.aiProgressPercent,editStageProgress(payload.status||'editing')));
      els.aiRunStatus.textContent=payload.message||`Editing ${Math.min((payload.completed||0)+1,payload.total||1)} of ${payload.total||1}…`;
      updateRegionList();
    }
    if(type==='SPOT_DIFF_EDIT_RESULT'&&payload?.jobId===state.activeJobId){
      const region=state.regions.find(item=>item.id===payload.regionId);
      if(region){
        try{
          await applyPatch(region,payload.imageDataUrl);
          state.editQueue.shift(); state.editCompleted++;
          setAiProgress(15+(state.editCompleted/state.editTotal)*85);
          sendNextEdit();
        }catch(error){ region.status='error'; failAi(error.message); }
      }
    }
    if(type==='SPOT_DIFF_JOB_CANCELLED'&&payload?.jobId===state.activeJobId)finishCancelled(payload.message);
    if(type==='SPOT_DIFF_AI_ERROR'&&(!payload?.jobId||payload.jobId===state.activeJobId)) failAi(payload?.message||'The ChatGPT bridge reported an error.');
  });

  els.manualTab.addEventListener('click',()=>setMode('manual'));
  els.aiTab.addEventListener('click',()=>setMode('ai'));
  els.checkExtensionBtn.addEventListener('click',pingExtension);
  els.aiGenerateBtn.addEventListener('click',()=>state.aiBusy?cancelAi():startAiWorkflow());
  window.addEventListener('pagehide',()=>{
    if(state.aiBusy)postToExtension('SPOT_DIFF_CANCEL',{jobId:state.activeJobId});
  });
  els.modFile.addEventListener('change',async event=>{ try{ if(event.target.files[0])await loadManualImage(event.target.files[0],'modified'); }catch(error){ alert(error.message); event.target.value=''; } });
  els.origFile.addEventListener('change',async event=>{ try{ if(event.target.files[0])await loadManualImage(event.target.files[0],'original'); }catch(error){ alert(error.message); event.target.value=''; } });
  els.aiOrigFile.addEventListener('change',async event=>{ try{ if(event.target.files[0])await loadAiOriginal(event.target.files[0]); }catch(error){ alert(error.message); event.target.value=''; } });
  els.need.addEventListener('input',()=>{ updateRegionList(); draw(); });
  function clearRegions(){ state.regions=[]; state.appliedPatches.clear(); initializeWorkCanvasFromModifiedBase(); updateSelectionStatus(); updateRegionList(); draw(); }
  function undoLastRegion(){ const region=state.regions.pop(); if(region)state.appliedPatches.delete(region.id); recomposeAllPatches(); updateSelectionStatus(); updateRegionList(); draw(); }
  els.clearBtn.addEventListener('click',clearRegions);
  els.undoBtn.addEventListener('click',undoLastRegion);
  els.aiClearBtn.addEventListener('click',clearRegions);
  els.aiUndoBtn.addEventListener('click',undoLastRegion);
  els.exportBtn.addEventListener('click',downloadConfig);
  els.downloadImageBtn.addEventListener('click',downloadModified);
  els.downloadBothBtn.addEventListener('click',()=>{ downloadModified(); setTimeout(downloadConfig,250); });
  els.downloadReadyBtn.addEventListener('click',()=>{ downloadModified(); setTimeout(downloadConfig,250); });
  els.aiAdvanced.addEventListener('toggle',()=>document.body.classList.toggle('advanced-open',state.mode==='ai'&&els.aiAdvanced.open));
  setMode('ai');
  els.importBtn.addEventListener('click',()=>els.importFile.click());
  els.importFile.addEventListener('change',async event=>{
    const file=event.target.files[0]; if(!file)return;
    try{
      const config=JSON.parse(await file.text());
      let raw=config.version>=3&&Array.isArray(config.regions)?config.regions:[];
      if(!raw.length&&Array.isArray(config.points)){
        const nw=config.natural?.w||1,nh=config.natural?.h||1,minSide=Math.min(nw,nh);
        const radiusNorm=config.radiusNorm||(config.radius?config.radius/minSide:.02);
        const wNorm=radiusNorm*minSide*2/nw,hNorm=radiusNorm*minSide*2/nh;
        raw=config.points.map(point=>({xNorm:point.xNorm-wNorm/2,yNorm:point.yNorm-hNorm/2,wNorm,hNorm}));
      }
      const imported=raw.map(item=>({...item,id:uid(),instruction:defaultInstruction(),status:'pending',source:'import'}));
      if(!imported.length||!imported.every(validRegion))throw new Error('Config contains invalid regions');
      state.regions=imported; els.need.value=clamp(Number(config.need)||imported.length,1,30); updateRegionList(); draw();
    }catch(error){ alert(`Could not import config: ${error.message}`); }
    event.target.value='';
  });
  els.modCanvas.addEventListener('mousedown',beginDrag);
  els.modCanvas.addEventListener('mousemove',moveDrag);
  window.addEventListener('mouseup',endDrag);
  els.modCanvas.addEventListener('touchstart',event=>{ event.preventDefault(); beginDrag(event.touches[0]); },{passive:false});
  els.modCanvas.addEventListener('touchmove',event=>{ event.preventDefault(); moveDrag(event.touches[0]); },{passive:false});
  window.addEventListener('touchend',endDrag);
  window.addEventListener('resize',fitCanvasSize);
  window.addEventListener('DOMContentLoaded',()=>{ fitCanvasSize(); updateRegionList(); updateControls(); });
  if(new URLSearchParams(location.search).has('debug')){
    els.diagnostics.hidden=false;
    els.runDiagnostics.addEventListener('click',runCreatorDiagnostics);
    els.loadClassroomFixture.addEventListener('click',loadDebugClassroomFixture);
  }
})();
