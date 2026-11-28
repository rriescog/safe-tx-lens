// Retro hero: a modelled 8-bit home computer whose screen loads and lists
// a transaction. Decoration only: loaded by skin.js when WebGL is
// available; otherwise the static screen in the HTML stays visible.
(function(){
  const canvas=document.getElementById('hero-retro');if(!canvas||canvas.dataset.ready)return;const stage=canvas.parentElement;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!window.THREE||!stage)return;let renderer;
  try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true})}catch(e){return}
  canvas.dataset.ready='1';stage.classList.add('lp-is-3d');const again=document.getElementById('replay-retro');again.hidden=false;
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(30,1,.1,100);camera.position.set(0,1.5,13.2);camera.lookAt(0,.2,0);
  scene.add(new THREE.AmbientLight(0xffffff,.78));const sun=new THREE.DirectionalLight(0xffffff,.55);sun.position.set(4,6,7);scene.add(sun);
  const pc=new THREE.Group();scene.add(pc);
  const BEIGE=0xCFC8B4,DARK=0x2A2733,INK=0x0B0824;
  function box(w,h,d,color,x,y,z,parent){const g=new THREE.BoxGeometry(w,h,d),m=new THREE.Mesh(g,new THREE.MeshLambertMaterial({color}));m.position.set(x,y,z);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g),new THREE.LineBasicMaterial({color:INK})));(parent||pc).add(m);return m}
  box(4.4,3.5,3.2,BEIGE,0,1.75,0);box(2.2,.35,2.2,0xB9B19B,0,-.18,0);box(3.75,2.9,.06,DARK,0,1.8,1.61);box(.16,.16,.05,0xFF4D3D,1.9,.25,1.62);
  const SW=800,SH=600,scv=document.createElement('canvas');scv.width=SW;scv.height=SH;const stex=new THREE.CanvasTexture(scv);stex.anisotropy=renderer.capabilities.getMaxAnisotropy();
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(3.4,2.55),new THREE.MeshBasicMaterial({map:stex}));screen.position.set(0,1.8,1.65);pc.add(screen);
  const kb=new THREE.Group();kb.position.set(0,-.72,2.55);kb.rotation.x=.13;pc.add(kb);box(5.8,.5,2.7,BEIGE,0,0,0,kb);
  const kcv=document.createElement('canvas');kcv.width=1024;kcv.height=400;(function(){const c=kcv.getContext('2d');c.fillStyle='#CFC8B4';c.fillRect(0,0,1024,400);
    for(let r=0;r<5;r++)for(let k=0;k<17;k++){const fn=k>14;if(r===4&&!fn&&k>2&&k<12){if(k===3){c.fillStyle='#3B352C';c.fillRect(190,r*76+18,520,58)}continue}
      c.fillStyle=fn?'#8A7F68':'#3B352C';c.fillRect(k*58+(fn?34:16)+(r%2?10:0)*(fn?0:1),r*76+18,48,58);c.fillStyle='rgba(255,255,255,.14)';c.fillRect(k*58+(fn?34:16)+(r%2?10:0)*(fn?0:1),r*76+18,48,8)}})();
  const keys=new THREE.Mesh(new THREE.PlaneGeometry(5.3,2.1),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(kcv)}));keys.rotation.x=-Math.PI/2;keys.position.set(0,.26,.05);kb.add(keys);
  /* screen program */
  const HEAD=['','   **** SAFE TX LENS 64 V0.2 ****','',' 64K RAM SYSTEM  READ-ONLY  0 KEYS HELD','','READY.'];
  const SEQ=[['type','LOAD "0X3DAF...0D78",8,1'],['print',''],['print','SEARCHING FOR 0X3DAF...0D78'],['print','LOADING'],['raster',1500],['print','READY.'],['type','LIST'],['print',''],
    ['print','10 REM SAFE NONCE 385 ON POLYGON'],['print','20 HASH CHECK ........... OK'],['print','30 CALL ADDOWNERWITHTHRESHOLD'],['print','40   OWNER 0X5B38...DDC4'],['print','50   THRESHOLD 3'],['print','60 CONTRACT CODE ..... VERIFIED'],['print',''],['print','?REVIEW BEFORE SIGNING'],['print','READY.']];
  let lines=[...HEAD],typing='',loading=false,run=0,dirty=true;const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const BANDS=['#FF8A7A','#EDF171','#7FD6DE','#40318D','#94E089','#7869C4','#FFFFFF','#8B3F96'];
  function paint(t){const c=scv.getContext('2d');
    if(loading){let y=0,i=Math.floor(t*14);while(y<SH){const h=8+((i*37)%29);c.fillStyle=BANDS[(i*5)%BANDS.length];c.fillRect(0,y,SW,h);y+=h;i++}}else{c.fillStyle='#7869C4';c.fillRect(0,0,SW,SH)}
    c.fillStyle='#40318D';c.fillRect(64,56,SW-128,SH-112);c.font='34px VT323,"Courier New",monospace';c.textBaseline='top';
    const all=typing!==null?[...lines,typing]:lines,vis=all.slice(-15);
    vis.forEach((s,i)=>{c.fillStyle=/^\?/.test(s)?'#EDF171':/(OK|VERIFIED)$/.test(s)?'#94E089':'#B5A9FF';c.fillText(s,80,66+i*31)});
    if(Math.floor(t*2)%2===0||reduce){const last=vis[vis.length-1]||'';const cy=typing!==null?vis.length-1:vis.length;const cx=typing!==null?c.measureText(last).width:0;if(cy<15){c.fillStyle='#B5A9FF';c.fillRect(80+cx,66+cy*31+2,15,27)}}
    c.fillStyle='rgba(0,0,0,.13)';for(let y=0;y<SH;y+=4)c.fillRect(0,y,SW,1);stex.needsUpdate=true}
  function final(){lines=[...HEAD,...SEQ.filter(s=>s[0]!=='raster').map(s=>s[1])];typing=null;loading=false;dirty=true}
  async function play(){const me=++run;lines=[...HEAD];typing='';loading=false;await wait(1500);
    for(const [k,v] of SEQ){if(me!==run)return;
      if(k==='type'){typing='';for(const ch of v){if(me!==run)return;typing+=ch;await wait(48)}lines.push(typing);typing=null;await wait(260);}
      else if(k==='raster'){loading=true;await wait(v);loading=false}
      else{typing=null;lines.push(v);await wait(v?230:60)}}
    typing=''}
  const ease=x=>x<0?0:x>1?1:1-Math.pow(1-x,3);let mx=0,my=0,tx=0,ty=0,visible=true,t0=null;
  function draw(t){paint(t);const e=reduce?1:ease(t/1.6);tx+=(mx*.5-tx)*.06;ty+=(my*.2-ty)*.06;pc.rotation.y=-1.25+.87*e+tx+(reduce?0:Math.sin(t*.35)*.03);pc.rotation.x=.04+ty;pc.position.y=-.45+(reduce?0:Math.sin(t*.9)*.04);renderer.render(scene,camera)}
  function layout(){const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();pc.scale.setScalar(Math.min(1,w/h*.86));draw(0)}
  addEventListener('pointermove',e=>{mx=e.clientX/innerWidth-.5;my=e.clientY/innerHeight-.5},{passive:true});
  function loop(now){if(t0===null)t0=now;if(visible)draw((now-t0)/1000);requestAnimationFrame(loop)}
  new ResizeObserver(layout).observe(stage);new IntersectionObserver(e=>{visible=e[0].isIntersecting}).observe(stage);
  (document.fonts&&document.fonts.load?document.fonts.load('34px VT323'):Promise.resolve()).then(()=>{if(reduce){final();layout()}else{play();requestAnimationFrame(loop)}});
  if(reduce){final();layout()}
  again.addEventListener('click',()=>{if(reduce){final();layout()}else{t0=null;play()}});
})();
