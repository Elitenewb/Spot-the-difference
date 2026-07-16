(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const els = {
    manualTab:$('manualTab'), aiTab:$('aiTab'), manualPanel:$('manualPanel'), aiPanel:$('aiPanel'),
    modFile:$('modFile'), origFile:$('origFile'), aiOrigFile:$('aiOrigFile'), modCanvas:$('modCanvas'), origCanvas:$('origCanvas'),
    modFrame:$('modFrame'), origFrame:$('origFrame'), need:$('need'), regionList:$('regionList'), regionCount:$('regionCount'),
    exportBtn:$('exportBtn'), downloadImageBtn:$('downloadImageBtn'), downloadBothBtn:$('downloadBothBtn'), downloadReadyBtn:$('downloadReadyBtn'), importBtn:$('importBtn'), importFile:$('importFile'),
    clearBtn:$('clearPoints'), undoBtn:$('undoPoint'), analyzeBtn:$('analyzeBtn'), generateBtn:$('generateBtn'), cancelAiBtn:$('cancelAiBtn'),
    checkExtensionBtn:$('checkExtensionBtn'), extensionStatus:$('extensionStatus'), aiRunStatus:$('aiRunStatus'), aiProgress:$('aiProgress'),
    patchUpload:$('patchUpload'), modBadge:$('modBadge'), diagnostics:$('creatorDiagnostics'), aiAdvanced:$('aiAdvanced'),
    uploadStep:$('uploadStep'), generateStep:$('generateStep'), downloadStep:$('downloadStep'),
    runDiagnostics:$('runCreatorDiagnostics'), loadClassroomFixture:$('loadClassroomFixture'), testLog:$('creatorTestLog')
  };

  const state = {
    mode:'manual', naturalW:0, naturalH:0, originalImage:null, modifiedImage:null, originalDataUrl:'',
    regions:[], appliedPatches:new Map(), workCanvas:document.createElement('canvas'), extensionConnected:false,
    dragging:false, dragStart:null, dragCurrent:null, uploadRegionId:null, activeJobId:null, aiBusy:false,
    editQueue:[], editCompleted:0, editTotal:0, jobTimer:null, analysisRepairAttempts:0
  };

  const MIN_DRAG_PX = 5;
  const ctxOriginal = els.origCanvas.getContext('2d');
  const ctxModified = els.modCanvas.getContext('2d');

  function uid(prefix='region') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }
  function clamp(value,min,max){ return Math.max(min,Math.min(max,value)); }
  function dpr(){ return Math.max(1,window.devicePixelRatio||1); }
  function expectedCount(){ return clamp(Number(els.need.value)||10,1,30); }

  function resetWorkspace(){
    clearJobTimer();
    state.naturalW=0; state.naturalH=0; state.originalImage=null; state.modifiedImage=null; state.originalDataUrl='';
    state.regions=[]; state.appliedPatches.clear(); state.workCanvas.width=0; state.workCanvas.height=0;
    state.uploadRegionId=null; state.activeJobId=null; state.aiBusy=false; state.editQueue=[];
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
    els.modBadge.textContent=manual?'Modified — drag to mark a region':'AI preview — drag to add or adjust the region set';
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
    else { state.originalImage=image; state.originalDataUrl=dataUrl; }
    state.naturalW=image.naturalWidth; state.naturalH=image.naturalHeight;
    if(state.originalImage&&state.modifiedImage) initializeWorkCanvasFromModified();
    fitCanvasSize();
  }

  async function loadAiOriginal(file){
    const dataUrl=await fileToDataUrl(file);
    const original=await imageFromDataUrl(dataUrl);
    const modified=await imageFromDataUrl(dataUrl);
    state.originalDataUrl=dataUrl;
    state.originalImage=original;
    state.modifiedImage=modified;
    state.naturalW=original.naturalWidth;
    state.naturalH=original.naturalHeight;
    state.regions=[];
    state.appliedPatches.clear();
    initializeWorkCanvasFromModified();
    fitCanvasSize();
    updateRegionList();
    els.aiProgress.style.width='0%';
    els.aiRunStatus.textContent='Photo ready. Click Generate puzzle.';
    updateControls();
  }

  async function loadDebugClassroomFixture(){
    try{
      setMode('ai');
      const response=await fetch('tests/fixtures/classroom-scene.svg',{cache:'no-store'});
      if(!response.ok)throw new Error(`fixture request failed (${response.status})`);
      await loadAiOriginal(await response.blob());
      els.aiRunStatus.textContent='Synthetic 1200×675 classroom fixture loaded. The bridge test can now suggest regions.';
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
    for(const region of state.regions){ drawGuide(els.modCanvas,region); drawGuide(els.origCanvas,region); }
    if(state.dragging&&state.dragStart&&state.dragCurrent){
      const preview=normToRect(state.dragStart,state.dragCurrent);
      drawDragPreview(els.modCanvas,preview); drawDragPreview(els.origCanvas,preview);
    }
    updateControls();
  }

  function drawGuide(canvas,region){
    const ctx=canvas.getContext('2d');
    const x=region.xNorm*canvas.clientWidth,y=region.yNorm*canvas.clientHeight;
    const w=region.wNorm*canvas.clientWidth,h=region.hNorm*canvas.clientHeight;
    const selected=region.id===state.uploadRegionId;
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
    if(!state.naturalW||state.regions.length>=expectedCount()||state.aiBusy) return;
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
      state.regions.push({...rect,id:uid(),instruction:defaultInstruction(),status:'pending',source:'manual'});
    }
    state.dragStart=null; state.dragCurrent=null; updateRegionList(); draw();
  }

  function defaultInstruction(){ return 'Make one clear but natural-looking addition or replacement inside the selected area. Preserve lighting, perspective, texture, and everything outside the target.'; }

  function validRegion(region){
    return ['xNorm','yNorm','wNorm','hNorm'].every(key=>Number.isFinite(region[key]))&&region.wNorm>.006&&region.hNorm>.006&&region.xNorm>=0&&region.yNorm>=0&&region.xNorm+region.wNorm<=1&&region.yNorm+region.hNorm<=1;
  }

  function regionSummary(region){ return `${(region.xNorm*100).toFixed(1)}%, ${(region.yNorm*100).toFixed(1)}% · ${(region.wNorm*100).toFixed(1)}×${(region.hNorm*100).toFixed(1)}%`; }

  function updateRegionList(){
    els.regionCount.textContent=`${state.regions.length} / ${expectedCount()}`;
    if(!state.regions.length){ els.regionList.innerHTML='<div class="region-empty">Drag rectangles on the modified image or ask ChatGPT to suggest them.</div>'; updateControls(); return; }
    els.regionList.innerHTML='';
    state.regions.forEach((region,index)=>{
      const item=document.createElement('div'); item.className='region-item'; item.dataset.id=region.id;
      const stateClass=region.status==='done'?'done':region.status==='error'?'error':'';
      if(state.mode==='ai'){
        item.innerHTML=`<div class="region-head"><span class="region-index">${index+1}</span><span class="region-label">${escapeHtml(regionSummary(region))}</span><span class="region-state ${stateClass}">${escapeHtml(region.status||'pending')}</span></div><textarea aria-label="Edit instruction for region ${index+1}">${escapeHtml(region.instruction||defaultInstruction())}</textarea><div class="region-actions"><button data-action="select">Show</button><button data-action="generate">Generate</button><button data-action="download">Crop</button><button data-action="upload">Upload edit</button><button data-action="remove" class="danger">Remove</button></div>`;
        item.querySelector('textarea').addEventListener('input',event=>{ region.instruction=event.target.value; updateControls(); });
        item.querySelector('[data-action="generate"]').disabled=state.aiBusy||!state.extensionConnected||String(region.instruction||'').trim().length<=5;
      }else{
        item.innerHTML=`<div class="region-head"><span class="region-index">${index+1}</span><span class="region-label">${escapeHtml(regionSummary(region))}</span></div><div class="region-actions"><button data-action="select">Show</button><button data-action="remove" class="danger">Remove</button></div>`;
      }
      item.addEventListener('click',event=>{
        const action=event.target.dataset.action; if(!action)return;
        if(state.aiBusy&&action!=='select')return;
        if(action==='select'){ state.uploadRegionId=region.id; draw(); item.scrollIntoView({block:'nearest'}); }
        if(action==='remove'){ state.appliedPatches.delete(region.id); state.regions=state.regions.filter(r=>r.id!==region.id); recomposeAllPatches(); updateRegionList(); draw(); }
        if(action==='download') downloadCrop(region);
        if(action==='generate') startEditQueue([region]);
        if(action==='upload'){ state.uploadRegionId=region.id; els.patchUpload.value=''; els.patchUpload.click(); draw(); }
      });
      els.regionList.appendChild(item);
      if(state.aiBusy) item.querySelectorAll('button:not([data-action="select"]), textarea').forEach(control=>{ control.disabled=true; });
    });
    updateControls();
  }

  function escapeHtml(value){ const div=document.createElement('div'); div.textContent=String(value??''); return div.innerHTML; }

  function updateControls(){
    const countMatches=state.regions.length===expectedCount();
    const hasImages=!!(state.originalImage&&state.modifiedImage&&state.naturalW);
    const instructionsReady=state.regions.every(region=>String(region.instruction||'').trim().length>5);
    const aiReady=state.mode==='ai'&&state.extensionConnected&&!!state.originalImage&&!state.aiBusy;
    const allEditsDone=countMatches&&state.regions.length>0&&state.regions.every(region=>region.status==='done');
    els.uploadStep.classList.toggle('done',!!state.originalImage);
    els.generateStep.classList.toggle('done',allEditsDone);
    els.downloadStep.classList.toggle('done',allEditsDone);
    if(state.aiBusy)els.analyzeBtn.textContent='Generating…';
    else if(allEditsDone)els.analyzeBtn.textContent='Puzzle ready';
    else if(!state.originalImage)els.analyzeBtn.textContent='Upload a photo first';
    else if(!state.extensionConnected)els.analyzeBtn.textContent='Waiting for connection';
    else if(state.regions.length===expectedCount())els.analyzeBtn.textContent='Continue generation';
    else els.analyzeBtn.textContent='Generate puzzle';
    els.analyzeBtn.disabled=!aiReady||allEditsDone;
    els.generateBtn.disabled=!(aiReady&&countMatches&&instructionsReady&&state.regions.some(region=>region.status!=='done'));
    els.exportBtn.disabled=!(hasImages&&countMatches);
    els.downloadImageBtn.disabled=!hasImages;
    els.downloadBothBtn.disabled=!(hasImages&&countMatches);
    els.downloadReadyBtn.disabled=!allEditsDone;
    els.downloadReadyBtn.textContent=allEditsDone?'Download image + config':'Waiting for generation';
    els.clearBtn.disabled=!state.regions.length||state.aiBusy;
    els.undoBtn.disabled=!state.regions.length||state.aiBusy;
    els.cancelAiBtn.disabled=!state.aiBusy;
    els.manualTab.disabled=state.aiBusy;
    els.aiTab.disabled=state.aiBusy;
    els.aiOrigFile.disabled=state.aiBusy;
    els.need.disabled=state.aiBusy;
    els.regionCount.textContent=`${state.regions.length} / ${expectedCount()}`;
  }

  function cropGeometry(region){
    const x=region.xNorm*state.naturalW,y=region.yNorm*state.naturalH,w=region.wNorm*state.naturalW,h=region.hNorm*state.naturalH;
    const padX=Math.max(24,w*.65),padY=Math.max(24,h*.65);
    const cropX=Math.max(0,Math.floor(x-padX)),cropY=Math.max(0,Math.floor(y-padY));
    const cropR=Math.min(state.naturalW,Math.ceil(x+w+padX)),cropB=Math.min(state.naturalH,Math.ceil(y+h+padY));
    return {cropX,cropY,cropW:cropR-cropX,cropH:cropB-cropY,targetX:Math.round(x-cropX),targetY:Math.round(y-cropY),targetW:Math.max(1,Math.round(w)),targetH:Math.max(1,Math.round(h))};
  }

  function makeCrop(region){
    const geometry=cropGeometry(region);
    const canvas=document.createElement('canvas'); canvas.width=geometry.cropW; canvas.height=geometry.cropH;
    canvas.getContext('2d').drawImage(state.workCanvas,geometry.cropX,geometry.cropY,geometry.cropW,geometry.cropH,0,0,geometry.cropW,geometry.cropH);
    return {dataUrl:canvas.toDataURL('image/png'),geometry};
  }

  function downloadBlob(blob,name){
    const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function downloadDataUrl(dataUrl,name){ const link=document.createElement('a'); link.href=dataUrl; link.download=name; document.body.appendChild(link); link.click(); link.remove(); }
  function downloadCrop(region){ const crop=makeCrop(region); downloadDataUrl(crop.dataUrl,`spot-crop-${state.regions.indexOf(region)+1}.png`); }

  async function applyPatch(region,dataUrl){
    const image=await imageFromDataUrl(dataUrl);
    const geometry=cropGeometry(region);
    state.appliedPatches.set(region.id,{dataUrl,geometry});
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
    const patch=document.createElement('canvas'); patch.width=geometry.targetW; patch.height=geometry.targetH;
    const pctx=patch.getContext('2d');
    pctx.drawImage(scaled,geometry.targetX,geometry.targetY,geometry.targetW,geometry.targetH,0,0,geometry.targetW,geometry.targetH);
    const pixels=pctx.getImageData(0,0,geometry.targetW,geometry.targetH);
    const feather=Math.max(2,Math.min(14,Math.floor(Math.min(geometry.targetW,geometry.targetH)*.12)));
    for(let y=0;y<geometry.targetH;y++) for(let x=0;x<geometry.targetW;x++){
      const edge=Math.min(x,y,geometry.targetW-1-x,geometry.targetH-1-y);
      const alpha=clamp(edge/feather,0,1);
      pixels.data[(y*geometry.targetW+x)*4+3]*=alpha;
    }
    pctx.putImageData(pixels,0,0);
    state.workCanvas.getContext('2d').drawImage(patch,geometry.cropX+geometry.targetX,geometry.cropY+geometry.targetY);
  }

  function configJson(){
    return JSON.stringify({version:3,natural:{w:state.naturalW,h:state.naturalH},regions:state.regions.map(({xNorm,yNorm,wNorm,hNorm})=>({xNorm,yNorm,wNorm,hNorm})),need:expectedCount()},null,2);
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
      if(state.aiBusy&&state.activeJobId===jobId) failAi(`${label} timed out. Check the temporary ChatGPT tab, then retry.`);
    },milliseconds);
  }

  function analysisPrompt(){
    return `You are planning a fun classroom spot-the-difference puzzle. Inspect this full image and choose exactly ${expectedCount()} distinct, visually meaningful details that can each be edited independently. Make the differences clear on close inspection but still natural, believable, and not awkward or immediately obvious. When people are visible, prioritize people, their clothes, and accessories for roughly half the set. Include an occasional harmless visual joke when it suits the image: for example cleanly omit one eyebrow, a mouth, one eye, one visible finger, a glasses lens, a shoelace, a pocket, a button, or a small clothing feature. These jokes must feel playful rather than gross, disturbing, insulting, sexual, offensive, or injury-like; show no wound, gore, distress, or damaged skin. Do not alter a person's identity or body shape. Strongly favor additions and replacements: use them for at least 6 of every 10 suggestions, such as adding a small plausible accessory, replacing a symbol or short word, changing an object's shape or pattern, or swapping one clothing detail for another. Use removals sparingly except for one or two playful omissions. Do not rely on tiny marks or extremely subtle changes. Use no more than 2 color-only changes in a set of 10. Avoid overlapping regions, image borders, large areas, and changes that would alter the global composition. Return valid JSON only as an array of objects with numeric xNorm, yNorm, wNorm, hNorm values from 0 to 1, a changeType value of add, replace, remove, color, or detail, and an instruction string describing one specific realistic change. Use changeType color only when the main difference is merely recoloring something. Do not put quotation-mark characters inside instruction values; describe any visible text without quoting it. Every rectangle must have wNorm and hNorm greater than 0.006; use at least 0.008 for each dimension to leave a safety margin. Each rectangle must tightly enclose its target and use less than 15% of the image area.`;
  }

  function analysisImageDataUrl(){
    const maxSide=1600;
    const scale=Math.min(1,maxSide/Math.max(state.naturalW,state.naturalH));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(state.naturalW*scale)); canvas.height=Math.max(1,Math.round(state.naturalH*scale));
    canvas.getContext('2d').drawImage(state.originalImage,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',.9);
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
      state.originalDataUrl=dataUrl; state.originalImage=await imageFromDataUrl(dataUrl); state.modifiedImage=await imageFromDataUrl(dataUrl);
      state.naturalW=1200; state.naturalH=675; state.appliedPatches.clear(); initializeWorkCanvasFromModifiedBase();
      state.regions=[];
      for(let i=0;i<10;i++) state.regions.push({id:uid(),xNorm:.06+(i%5)*.19,yNorm:.13+Math.floor(i/5)*.52,wNorm:.065,hNorm:.085,instruction:`Remove the small light rectangle ${i+1}.`,status:'pending',source:'diagnostic'});
      const first=state.regions[0],crop=makeCrop(first),geometry=crop.geometry;
      const edited=document.createElement('canvas'); edited.width=geometry.cropW; edited.height=geometry.cropH;
      edited.getContext('2d').drawImage(await imageFromDataUrl(crop.dataUrl),0,0);
      edited.getContext('2d').fillStyle='#e22635'; edited.getContext('2d').fillRect(geometry.targetX,geometry.targetY,geometry.targetW,geometry.targetH);
      const before=source.getContext('2d').getImageData(0,0,1,1).data.join(',');
      await applyPatch(first,edited.toDataURL('image/png'));
      const centerX=geometry.cropX+geometry.targetX+Math.floor(geometry.targetW/2),centerY=geometry.cropY+geometry.targetY+Math.floor(geometry.targetH/2);
      const center=state.workCanvas.getContext('2d').getImageData(centerX,centerY,1,1).data;
      const outside=state.workCanvas.getContext('2d').getImageData(0,0,1,1).data.join(',');
      const parsed=JSON.parse(configJson());
      expect('native resolution is preserved',state.workCanvas.width===1200&&state.workCanvas.height===675);
      expect('ten regions are present',state.regions.length===10);
      expect('all normalized regions are valid',state.regions.every(validRegion));
      expect('crop includes context and stays below full image size',geometry.cropW>geometry.targetW&&geometry.cropH>geometry.targetH&&geometry.cropW<1200&&geometry.cropH<675);
      expect('edited center pixel is composited',center[0]>180&&center[1]<80);
      expect('pixel outside target remains unchanged',outside===before);
      expect('patch is tracked for deterministic recomposition',state.appliedPatches.has(first.id));
      expect('version 3 export preserves region count',parsed.version===3&&parsed.regions.length===10&&parsed.need===10);
      updateRegionList(); fitCanvasSize(); updateControls();
    }catch(error){ results.push(`FAIL: diagnostic threw ${error.message}`); }
    els.testLog.textContent=results.join('\n');
  }

  function normalizeChangeType(item,instruction){
    const supplied=String(item.changeType||item.type||'').toLowerCase().trim();
    const colorOnly=/\b(?:recolor|change (?:the )?(?:color|colour)|change .{0,35} to (?:red|blue|green|yellow|orange|purple|pink|black|white|brown|gray|grey))\b/i.test(instruction)&&!/\b(?:add|attach|insert|replace|swap|substitute|remove|erase|delete)\b/i.test(instruction);
    if(colorOnly)return 'color';
    if(['add','replace','remove','color','detail'].includes(supplied))return supplied;
    if(/\b(?:add|attach|insert|draw|give|put)\b/i.test(instruction))return 'add';
    if(/\b(?:replace|swap|substitute|turn\s+.+\s+into)\b/i.test(instruction))return 'replace';
    if(/\b(?:remove|erase|delete|take away)\b/i.test(instruction))return 'remove';
    if(/\b(?:recolor|change (?:the )?(?:color|colour))\b/i.test(instruction))return 'color';
    return 'detail';
  }

  function validateSuggestedRegions(raw,accepted=[]){
    const items=Array.isArray(raw)?raw:Array.isArray(raw?.regions)?raw.regions:[];
    const normalized=[...accepted],rejected=[];
    for(const [index,item] of items.entries()){
      const values=[item.xNorm,item.yNorm,item.wNorm,item.hNorm].map(Number);
      const largest=Math.max(...values);
      const scale=largest>1?(largest<=100?100:1000):1;
      const instruction=String(item.instruction||item.prompt||defaultInstruction());
      const region={id:uid(),xNorm:values[0]/scale,yNorm:values[1]/scale,wNorm:values[2]/scale,hNorm:values[3]/scale,instruction,changeType:normalizeChangeType(item,instruction),status:'pending',source:'chatgpt'};
      let reason='';
      if(!values.every(Number.isFinite))reason='coordinates must all be numeric';
      else if(region.wNorm<=.006)reason=`width ${region.wNorm.toFixed(4)} is not greater than 0.006`;
      else if(region.hNorm<=.006)reason=`height ${region.hNorm.toFixed(4)} is not greater than 0.006`;
      else if(region.xNorm<0||region.yNorm<0||region.xNorm+region.wNorm>1||region.yNorm+region.hNorm>1)reason='rectangle extends outside the image';
      else if(region.wNorm*region.hNorm>=.15)reason='rectangle covers 15% or more of the image';
      else if(normalized.some(existing=>regionOverlap(existing,region)>.2))reason='rectangle overlaps an accepted suggestion by more than 20%';
      else if(region.changeType==='color'&&normalized.filter(existing=>existing.changeType==='color').length>=2)reason='the set already contains the maximum of two color-only changes';
      else if(normalized.length>=expectedCount())reason='more suggestions were returned than requested';
      if(reason)rejected.push({number:index+1,reason,instruction:region.instruction});
      else normalized.push(region);
    }
    return {accepted:normalized,rejected};
  }

  function repairAnalysisPrompt(missing,accepted,rejected){
    const acceptedJson=accepted.map(({xNorm,yNorm,wNorm,hNorm,changeType,instruction})=>({xNorm,yNorm,wNorm,hNorm,changeType,instruction}));
    const reasons=rejected.map(item=>`Suggestion ${item.number}: ${item.reason}`).join('; ')||'The response did not contain enough usable regions.';
    const colorSlots=Math.max(0,2-accepted.filter(region=>region.changeType==='color').length);
    return `Your previous response produced ${accepted.length} accepted regions and ${rejected.length} rejected regions. Rejection details: ${reasons}. Return exactly ${missing} replacement ${missing===1?'object':'objects'} as a JSON array only. Favor meaningful additions and replacements that are clear on close inspection but natural and believable. When people are visible, prefer their clothes, accessories, or an occasional harmless visual joke such as a cleanly omitted eyebrow, mouth, eye, visible finger, glasses lens, shoelace, pocket, or button. It must look playful rather than gross, disturbing, insulting, sexual, offensive, or injury-like, with no wound, gore, distress, or damaged skin. Do not propose a tiny mark or an extremely subtle change. At most ${colorSlots} of these replacements may be color-only. Include changeType as add, replace, remove, color, or detail; use color only for a mere recoloring. Each replacement must identify a new detail that does not overlap any accepted rectangle by more than 20%. Every xNorm, yNorm, wNorm, and hNorm must be numeric from 0 to 1. Both wNorm and hNorm must be greater than 0.006; use at least 0.008 for safety. Each rectangle must stay inside the image and cover less than 15% of it. Do not repeat any accepted target. Accepted regions to avoid: ${JSON.stringify(acceptedJson)}.`;
  }

  function requestMissingRegions(validation){
    state.regions=validation.accepted;
    const missing=expectedCount()-state.regions.length;
    if(missing<=0)return false;
    if(state.analysisRepairAttempts>=2)throw new Error(`Received ${expectedCount()} or more suggestions, but only ${state.regions.length} passed validation after two replacement attempts. ${validation.rejected.map(item=>`Suggestion ${item.number}: ${item.reason}`).join('; ')}`);
    state.analysisRepairAttempts++;
    const details=validation.rejected.map(item=>`#${item.number} ${item.reason}`).join('; ');
    setExtensionStatus('busy',`Accepted ${state.regions.length} of ${expectedCount()}; requesting ${missing} replacement${missing===1?'':'s'}…`);
    els.aiRunStatus.textContent=`Rejected ${validation.rejected.length}: ${details}. Requesting ${missing} replacement${missing===1?'':'s'}…`;
    updateRegionList(); draw();
    armJobTimer(240000,`Replacement analysis ${state.analysisRepairAttempts}`);
    postToExtension('SPOT_DIFF_REPAIR_ANALYSIS',{jobId:state.activeJobId,count:missing,prompt:repairAnalysisPrompt(missing,state.regions,validation.rejected)});
    return true;
  }

  function regionOverlap(a,b){
    const left=Math.max(a.xNorm,b.xNorm),top=Math.max(a.yNorm,b.yNorm);
    const right=Math.min(a.xNorm+a.wNorm,b.xNorm+b.wNorm),bottom=Math.min(a.yNorm+a.hNorm,b.yNorm+b.hNorm);
    const intersection=Math.max(0,right-left)*Math.max(0,bottom-top);
    const union=a.wNorm*a.hNorm+b.wNorm*b.hNorm-intersection;
    return union?intersection/union:0;
  }

  async function startAnalysis(){
    if(!state.originalDataUrl||state.aiBusy)return;
    state.aiBusy=true; state.activeJobId=uid('analysis');
    state.analysisRepairAttempts=0;
    setExtensionStatus('busy','ChatGPT is inspecting the image…');
    els.aiProgress.style.width='4%';
    els.aiRunStatus.textContent=`Step 1 of 2: choosing ${expectedCount()} differences in ChatGPT…`; updateControls();
    armJobTimer(240000,'Region analysis');
    postToExtension('SPOT_DIFF_ANALYZE',{jobId:state.activeJobId,imageDataUrl:analysisImageDataUrl(),count:expectedCount(),prompt:analysisPrompt()});
  }

  function editPrompt(region,geometry,index){
    const left=Math.round(geometry.targetX/geometry.cropW*100),top=Math.round(geometry.targetY/geometry.cropH*100);
    const right=Math.round((geometry.targetX+geometry.targetW)/geometry.cropW*100),bottom=Math.round((geometry.targetY+geometry.targetH)/geometry.cropH*100);
    return `Edit this crop for a fun classroom spot-the-difference puzzle. ${region.instruction.trim()} Make the change seamless, believable, and gently amusing when the instruction is a visual joke. A removed human feature must look like a clean, harmless visual oddity with natural uninjured skin—never a wound, gore, distress, or grotesque disfigurement. Preserve the crop's exact viewpoint, lighting, texture, color profile, sharpness, and all unrelated details. The target is approximately ${left}%–${right}% across and ${top}%–${bottom}% down; change only that target. Do not add borders, labels, highlights, watermarks, or explanatory text. Return one edited image only, keeping the same aspect ratio. This is edit ${index+1} of ${state.regions.length}.`;
  }

  function startAiWorkflow(){
    if(state.aiBusy)return;
    const pending=state.regions.filter(region=>region.status!=='done');
    if(state.regions.length===expectedCount()&&pending.length)startEditQueue(pending);
    else startAnalysis();
  }

  function startGeneration(){
    if(state.aiBusy)return;
    const pending=state.regions.filter(region=>region.status!=='done');
    startEditQueue(pending);
  }

  function startEditQueue(regions){
    if(state.aiBusy||!state.extensionConnected||!regions.length)return;
    state.aiBusy=true; state.activeJobId=uid('edit'); els.aiProgress.style.width='0%';
    setExtensionStatus('busy','ChatGPT edit queue is running…');
    els.aiRunStatus.textContent=`Preparing ${regions.length} crop edit${regions.length===1?'':'s'}…`;
    state.editQueue=regions.map(region=>{
      const crop=makeCrop(region);
      region.status='queued';
      return {regionId:region.id,imageDataUrl:crop.dataUrl,prompt:editPrompt(region,crop.geometry,state.regions.indexOf(region))};
    });
    state.editCompleted=0; state.editTotal=state.editQueue.length;
    updateRegionList(); updateControls();
    sendNextEdit();
  }

  function sendNextEdit(){
    const edit=state.editQueue[0];
    if(!edit){
      clearJobTimer(); state.aiBusy=false; els.aiProgress.style.width='100%'; setExtensionStatus('connected','Edit queue complete');
      els.aiRunStatus.textContent='Puzzle complete. Download both files in step 3.'; updateRegionList(); updateControls();
      return;
    }
    const region=state.regions.find(item=>item.id===edit.regionId); if(region)region.status='editing';
    els.aiRunStatus.textContent=`Step 2 of 2: creating difference ${state.editCompleted+1} of ${state.editTotal}…`;
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
    failAi('Current ChatGPT job cancelled. You can adjust the puzzle and retry.');
    els.aiProgress.style.width='0%';
  }

  window.addEventListener('message',async event=>{
    if(event.source!==window||event.data?.source!=='spot-diff-extension')return;
    const {type,payload}=event.data;
    if(type==='SPOT_DIFF_EXTENSION_PONG'){
      state.extensionConnected=true; setExtensionStatus('connected','Ready'); updateControls();
    }
    if(type==='SPOT_DIFF_ANALYSIS_RESULT'&&payload?.jobId===state.activeJobId){
      try{
        clearJobTimer();
        const validation=validateSuggestedRegions(payload.regions,payload.repair?state.regions:[]);
        if(requestMissingRegions(validation))return;
        state.regions=validation.accepted.slice(0,expectedCount());
        state.appliedPatches.clear(); state.aiBusy=false;
        setExtensionStatus('connected',`${state.regions.length} differences selected`);
        els.aiRunStatus.textContent='Differences selected. Starting image edits automatically…';
        updateRegionList(); draw();
        startEditQueue(state.regions.filter(region=>region.status!=='done'));
      }catch(error){ failAi(error.message); }
    }
    if(type==='SPOT_DIFF_AI_PROGRESS'&&payload?.jobId===state.activeJobId){
      els.aiRunStatus.textContent=payload.message||'ChatGPT is working…';
      if(payload.kind==='edit'){
        const region=state.regions.find(item=>item.id===payload.regionId);
        if(region)region.status=payload.stage||'editing';
        updateRegionList();
      }
    }
    if(type==='SPOT_DIFF_EDIT_PROGRESS'&&payload?.jobId===state.activeJobId){
      const region=state.regions.find(item=>item.id===payload.regionId);
      if(region) region.status=payload.status||'editing';
      els.aiProgress.style.width=`${clamp((payload.completed||0)/(payload.total||1)*100,0,100)}%`;
      els.aiRunStatus.textContent=payload.message||`Editing ${Math.min((payload.completed||0)+1,payload.total||1)} of ${payload.total||1}…`;
      updateRegionList();
    }
    if(type==='SPOT_DIFF_EDIT_RESULT'&&payload?.jobId===state.activeJobId){
      const region=state.regions.find(item=>item.id===payload.regionId);
      if(region){
        try{
          await applyPatch(region,payload.imageDataUrl);
          state.editQueue.shift(); state.editCompleted++;
          els.aiProgress.style.width=`${state.editCompleted/state.editTotal*100}%`;
          sendNextEdit();
        }catch(error){ region.status='error'; failAi(error.message); }
      }
    }
    if(type==='SPOT_DIFF_AI_ERROR'&&(!payload?.jobId||payload.jobId===state.activeJobId)) failAi(payload?.message||'The ChatGPT bridge reported an error.');
  });

  els.manualTab.addEventListener('click',()=>setMode('manual'));
  els.aiTab.addEventListener('click',()=>setMode('ai'));
  els.checkExtensionBtn.addEventListener('click',pingExtension);
  els.analyzeBtn.addEventListener('click',startAiWorkflow);
  els.generateBtn.addEventListener('click',startGeneration);
  els.cancelAiBtn.addEventListener('click',cancelAi);
  els.modFile.addEventListener('change',async event=>{ try{ if(event.target.files[0])await loadManualImage(event.target.files[0],'modified'); }catch(error){ alert(error.message); event.target.value=''; } });
  els.origFile.addEventListener('change',async event=>{ try{ if(event.target.files[0])await loadManualImage(event.target.files[0],'original'); }catch(error){ alert(error.message); event.target.value=''; } });
  els.aiOrigFile.addEventListener('change',async event=>{ try{ if(event.target.files[0])await loadAiOriginal(event.target.files[0]); }catch(error){ alert(error.message); event.target.value=''; } });
  els.need.addEventListener('input',()=>{ updateRegionList(); draw(); });
  els.clearBtn.addEventListener('click',()=>{ state.regions=[]; state.appliedPatches.clear(); initializeWorkCanvasFromModifiedBase(); updateRegionList(); draw(); });
  els.undoBtn.addEventListener('click',()=>{ const region=state.regions.pop(); if(region)state.appliedPatches.delete(region.id); recomposeAllPatches(); updateRegionList(); draw(); });
  els.exportBtn.addEventListener('click',downloadConfig);
  els.downloadImageBtn.addEventListener('click',downloadModified);
  els.downloadBothBtn.addEventListener('click',()=>{ downloadModified(); setTimeout(downloadConfig,250); });
  els.downloadReadyBtn.addEventListener('click',()=>{ downloadModified(); setTimeout(downloadConfig,250); });
  els.aiAdvanced.addEventListener('toggle',()=>document.body.classList.toggle('advanced-open',state.mode==='ai'&&els.aiAdvanced.open));
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
  els.patchUpload.addEventListener('change',async event=>{
    const file=event.target.files[0],region=state.regions.find(item=>item.id===state.uploadRegionId); if(!file||!region)return;
    try{ await applyPatch(region,await fileToDataUrl(file)); els.aiRunStatus.textContent=`Uploaded edit applied to region ${state.regions.indexOf(region)+1}.`; }
    catch(error){ alert(error.message); }
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
