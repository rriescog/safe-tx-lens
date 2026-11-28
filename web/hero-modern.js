// Modern hero: a transaction drawn as a stack of layers. The friendly
// signing screen is only the top one; the stack opens to show the hash,
// the calls and the contract underneath. Decoration only: loaded by
// skin.js when WebGL is available. Colours come from the skin's tokens.
(function(){
  const canvas=document.getElementById('hero-modern');if(!canvas||canvas.dataset.ready)return;const stage=canvas.parentElement;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!window.THREE)return;let renderer;
  try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true})}catch(e){return}
  canvas.dataset.ready='1';stage.classList.add('lp-is-3d');
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(34,1,.1,100);camera.position.set(0,5.6,8.8);camera.lookAt(0,-.25,0);
  const group=new THREE.Group();scene.add(group);
  const W=4.6,H=2.875,TW=1024,TH=640,N=4;
  const LAYERS=[{kind:'ui',flag:false},{kind:'hash',flag:false},{kind:'calls',flag:true},{kind:'code',flag:true}];
  function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
  function chip(c,x,y,text,fg,bg){c.font='600 30px "Instrument Sans",system-ui,sans-serif';const w=c.measureText(text).width+44;rr(c,x,y,w,54,27);c.fillStyle=bg;c.fill();c.fillStyle=fg;c.fillText(text,x+22,y+38)}
  function paint(cv,kind){const c=cv.getContext('2d'),P={surface:css('--surface'),fg:css('--fg'),muted:css('--muted'),line:css('--line'),accent:css('--accent'),accentFg:css('--accent-fg'),danger:css('--danger'),dangerBg:css('--danger-bg'),ok:css('--ok'),okBg:css('--ok-bg'),s2:css('--surface-2')};
    c.clearRect(0,0,TW,TH);rr(c,6,6,TW-12,TH-12,34);c.globalAlpha=.94;c.fillStyle=P.surface;c.fill();c.globalAlpha=1;
    const sans=(w,s)=>`${w} ${s}px "Instrument Sans",system-ui,sans-serif`,mono=s=>`500 ${s}px "IBM Plex Mono",ui-monospace,monospace`;
    if(kind==='ui'){c.fillStyle=P.muted;c.font=sans(500,34);c.fillText('What your screen shows',56,92);
      c.fillStyle=P.fg;c.font=sans(700,92);c.fillText('Send 10 ETH',56,236);c.fillStyle=P.muted;c.font=sans(400,44);c.fillText('to Treasury wallet',56,306);
      rr(c,56,400,330,104,22);c.fillStyle=P.accent;c.fill();c.fillStyle=P.accentFg;c.font=sans(600,46);c.fillText('Sign',170,468);
      chip(c,430,424,'Looks routine',P.ok,P.okBg)}
    else{const title={hash:'The hash you really sign',calls:'The calls inside',code:'The contract that runs'}[kind];
      c.fillStyle=P.muted;c.font=sans(500,34);c.fillText(title,56,372);
      if(kind==='hash'){c.fillStyle=P.fg;c.font=mono(50);c.fillText('0x3daf…0d78',56,458);chip(c,56,514,'Recalculated: matches',P.ok,P.okBg)}
      if(kind==='calls'){c.fillStyle=P.danger;c.font=mono(46);c.fillText('delegatecall → 0x96…41c',56,456);chip(c,56,514,'Not a transfer',P.danger,P.dangerBg)}
      if(kind==='code'){c.fillStyle=P.fg;c.font=mono(46);c.fillText('0x96…41c',56,456);chip(c,56,514,'No verified source',P.danger,P.dangerBg)}}}
  const items=LAYERS.map((L,i)=>{const cv=document.createElement('canvas');cv.width=TW;cv.height=TH;const tex=new THREE.CanvasTexture(cv);tex.anisotropy=renderer.capabilities.getMaxAnisotropy();
    const geo=new THREE.PlaneGeometry(W,H);geo.rotateX(-Math.PI/2);
    const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({map:tex,transparent:true,side:THREE.DoubleSide,depthWrite:false}));mesh.renderOrder=N-i;
    const edge=new THREE.LineSegments(new THREE.EdgesGeometry(geo),new THREE.LineBasicMaterial({transparent:true,opacity:.9}));edge.renderOrder=N-i;mesh.add(edge);group.add(mesh);return{L,cv,tex,mesh,edge}});
  const linkGeo=new THREE.BufferGeometry();linkGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array((N-1)*4*6),3));
  const links=new THREE.LineSegments(linkGeo,new THREE.LineBasicMaterial({transparent:true,opacity:.35}));group.add(links);
  function repaint(){items.forEach(o=>{paint(o.cv,o.L.kind);o.tex.needsUpdate=true;o.edge.material.color.set(css(o.L.flag?'--danger':'--accent'))});links.material.color.set(css('--muted'));draw(last)}
  const ease=x=>x<0?0:x>1?1:1-Math.pow(1-x,3);
  let mx=0,my=0,tx=0,ty=0,last=0,visible=true,t0=null;
  function draw(t){const e=reduce?1:ease((t-.9)/2.4);const p=linkGeo.attributes.position.array;let k=0;
    items.forEach((o,i)=>{o.mesh.position.set(0,((N-1)/2-i)*(.035+1.1*e)+(reduce?0:Math.sin(t*.8+i*1.3)*.035*e),(i-(N-1)/2)*.62*e)});
    for(let i=0;i<N-1;i++){const a=items[i].mesh.position,b=items[i+1].mesh.position;for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){p[k++]=sx*W/2;p[k++]=a.y;p[k++]=a.z+sz*H/2;p[k++]=sx*W/2;p[k++]=b.y;p[k++]=b.z+sz*H/2}}
    linkGeo.attributes.position.needsUpdate=true;links.material.opacity=.35*e;
    tx+=(mx*.4-tx)*.05;ty+=(my*.18-ty)*.05;group.rotation.y=-.5+tx+(reduce?0:Math.sin(t*.22)*.05);group.rotation.x=ty;renderer.render(scene,camera)}
  function layout(){const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;group.position.set(0,-.1,0);group.scale.setScalar(Math.min(1.05,w/560));camera.updateProjectionMatrix();draw(last)}
  addEventListener('pointermove',e=>{mx=e.clientX/innerWidth-.5;my=e.clientY/innerHeight-.5},{passive:true});
  function loop(now){if(t0===null)t0=now;if(visible&&!reduce){last=(now-t0)/1000;draw(last)}requestAnimationFrame(loop)}
  new ResizeObserver(layout).observe(stage);new IntersectionObserver(e=>{visible=e[0].isIntersecting}).observe(stage);
  repaint();layout();(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(repaint);
  if(!reduce)requestAnimationFrame(loop);
  window.__heroRepaint=function(){repaint();layout()};
  const again=document.getElementById('replay-modern');if(again)again.addEventListener('click',()=>{t0=null});
})();
