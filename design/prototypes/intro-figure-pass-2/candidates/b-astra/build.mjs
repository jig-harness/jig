import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const colors={bg:'#f9f6f1',card:'#fffdfa',sunk:'#f0ece5',ink:'#251e18',muted:'#59514a',line:'#d5d0c8','line-strong':'#867f77',accent:'#1a6444','accent-soft':'#dbf2e4'};
const c=k=>`var(--${k},${colors[k]})`, names=['Pick up','Build','Open','Drive','Repair','Merge','Follow up','Dispatcher'];
let body='',origin,ax,ay,bx,by,scale;
function camera(x,y,t=false,s=1){origin=[x,y];[ax,ay,bx,by]=t?[.43,-.78,.94,.36]:[1,-.31,.67,.53];scale=s}
const p=([x,y,z=0])=>[origin[0]+scale*(ax*x+bx*y),origin[1]+scale*(ay*x+by*y-z)];
const pt=a=>a.map(v=>Number(v.toFixed(2))).join(',');
function path(d,fill='none',stroke='ink',w=1){body+=`<path d="${d}" fill="${fill==='none'?fill:fill==='hatch'?'url(#h)':c(fill)}" stroke="${c(stroke)}" stroke-width="${w}"/>`}
function poly(a,f='card',e='ink',w=1){path('M'+a.map(pt).join('L')+'Z',f,e,w)}
function line(a,e='ink',w=1){path('M'+a.map(pt).join('L'),'none',e,w)}
const face=(a,...v)=>poly(a.map(p),...v), wire=(a,...v)=>line(a.map(p),...v);
function circle([x,y],r,f,e='ink',w=1){body+=`<circle cx="${x}" cy="${y}" r="${r}" fill="${c(f)}" stroke="${c(e)}" stroke-width="${w}"/>`}
function label(x,y,s,size=14,anchor='start'){body+=`<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${c('ink')}">${s}</text>`}
function block(x,y,z,l,d,h,top='card',front='hatch',side='sunk'){
 const a=[x,y,z+h],b=[x+l,y,z+h],e=[x+l,y+d,z+h],f=[x,y+d,z+h];
 face([a,f,[x,y+d,z],[x,y,z]],side);face([f,e,[x+l,y+d,z],[x,y+d,z]],front);face([a,b,e,f],top)}
function machine(i,x,y,pose=0){
 const q=(u,v,h)=>p([x+u,y+v,h]);
 const wheel=(u,v,r)=>{circle(q(u,v,12),r*scale,'line-strong');circle(q(u,v,12),r*.36*scale,'card')};
 const box=(u,v,z,l,d,h,...fills)=>block(x+u,y+v,z,l,d,h,...fills);
 for(const u of [-13,12])wheel(u,9,i===3?7:4);
 const lift=[0,13,0][pose], b=[5,34,44][pose], h=[38,43,24][pose];
 const a=4;
 if(i===0||i===4){
   for(const u of [-17,11]){box(u,-4,14,6,16,4);box(u,-2,18,5,9,i===0?34:25)}
   box(-17,-3,i===0?52:43,34,13,6);
 }else if(i===1){
   box(-18,-4,14,36,16,10);for(const u of [-15,10])box(u,-2,24,5,10,21);
 }else if(i===3||i===7){
   box(-18,-6,15,36,18,6);
   for(const [u,v] of [[-14,8],[14,8],[0,-4]])wire([[x+u,y+v,21],[x+3,y+3,i===7?44:46]],'ink',2.4*scale);
 }else if(i===6){
   box(-16,-5,14,32,18,27);box(-14,-4,41,27,12,5);
   for(let u=-11;u<8;u+=4)wire([[x+u,y+13,20],[x+u,y+13,27]],'muted');
 }else{
   box(-17,-4,14,34,16,6);box(-14,-2,20,10,10,25);
 }
 const pivot=i===0?54:i===4?46:i===1?44:i===6?44:i===2?43:i===7?44:46;
 const end=pose===0?pivot+7:pivot+lift;
 face([[x-4,y+2,pivot],[x+4,y+2,pivot+3],[x+8,y+b,end],[x+1,y+b,end-3]],'sunk');
 circle(q(2,3,pivot),2.6*scale,'card');
 wire([[x+a,y+b,end],[x+a,y+b,h]],'ink',2*scale);
 const tool=q(a,b,h);
 if(i===0){for(const j of [-1,1])line([tool,q(a+j*7,b,h-4),q(a+j*8,b,h-13),q(a+j*4,b,h-14)],'ink',2)}
 if(i===1){block(x-8,y+b,h-10,25,7,7,'line-strong');circle(q(-8,b+3,h-7),4*scale,'sunk')}
 if(i===2)face([[x-6,y+b,h],[x+15,y+b,h],[x+11,y+b+3,h-12],[x-8,y+b+3,h-7]]);
 if(i===3||i===7){circle(q(a,b,h-6),9*scale,'sunk');circle(q(a,b,h-6),6.3*scale,'card');line([q(a-3,b,h-8),q(a+2,b,h-3)],'line-strong')}
 if(i===4){block(x-1,y+b-2,h-8,12,6,9);block(x-7,y+b-5,h-12,24,13,4,'sunk')}
 if(i===6){block(x-10,y+b-5,h-12,26,12,13);wire([[x-6,y+b+7,h-7],[x+12,y+b+7,h-7]],'ink',2)}
}
function proof(x,y,z,state,s=1){
 const q=(u,v)=>p([x+u*s,y+v*s,z]), shape=(a,...v)=>poly(a.map(b=>q(...b)),...v),mark=(a,...v)=>line(a.map(b=>q(...b)),...v);
 shape([[-19,-22],[10,-22],[18,-14],[18,22],[-19,22]]);
 circle(q(-14,-17),1.4*s*scale,'sunk'); for(const [v,l] of [[-10,16],[-3,23],[3,19],[10,12]])mark([[-13,v],[-13+l,v]],'muted',s*scale*.9);
 if(state>=2&&state<5){shape([[12,-17],[42,-22],[42,17],[12,22]],'sunk');mark([[15,-15],[15,19]],'line-strong');
 if(state===2)for(let v=-10;v<12;v+=6)mark([[20,v],[37,v-3]],'muted');
 if(state===3){for(const v of [-10,3])shape([[18,v],[29,v-2],[29,v+4],[23,v+5],[20,v+9],[20,v+5],[18,v+5]]);
 for(const v of [-12,-2])circle(q(35,v),2*s*scale,'card');for(const d of [-1,1])mark([[32,10-3*d],[38,10+3*d]],'ink',1.5*s*scale)}
 if(state===4)for(const v of [-12,-1,10])mark([[23,v],[27,v+4],[35,v-5]],'accent',2*s*scale)}
 if(state===5){shape([[-20,-2],[19,-2],[19,12],[-20,12]],'accent-soft');mark([[-10,2],[-4,6],[10,6]],'accent',2*s*scale);mark([[-10,10],[-4,6]],'accent',2*s*scale)}
}
function human(x,y,act){block(x-21,y-15,0,42,38,16,'accent-soft','accent','accent-soft');
 const [u,v]=p([x,y,16]),s=scale;body+=`<g transform="translate(${u} ${v}) scale(${s})">`;
 path('M-13,0 Q-13,-18 -6,-22 Q0,-26 6,-22 Q11,-20 12,-12 L10,-2Z','accent-soft','accent');circle([0,-30],7,'card','accent');path(act?'M4,-18 Q9,-12 20,-11 L24,-8 Q24,-5 20,-6 L5,-9 L0,-15':'M4,-18 L8,-11 L4,-4 L0,-5 L3,-12','card','accent');body+='</g>'}
function leader(point,x,y,name,anchor='middle'){
 const end=[x,y+(y<point[1] ? 4 : -13)];
 line([point,end],'muted',.85);circle(point,1.65,'ink');label(x,y,name,14,anchor);
}
const states=[0,1,2,3,4,5,5,0],actors=[-1,0,2,3,4,5,6,7];
function scene(step,t){
 const actor=actors[step-1],gap=t?82:91;
 camera(t?107:168,t?390:358,t,t?1:1.51);
 block(-60,-25,0,gap*5+92,76,9);
 for(const v of [-23,-9,47])block(-58,v,9,gap*5+88,2,3,'sunk');
 for(let u=-55;u<gap*5+27;u+=18)wire([[u,-5,9],[u,45,9]],'line',.75);
 block(-56,-76,0,24,56,7);for(const u of [-53,-37])block(u,-74,7,2,51,2);
 machine(6,t?-46:-39,t?-77:-69,actor===6?2:0);
 if(step===7)proof(-44,-31,12,1,.48);
 for(let i=4;i>=0;i--){
   if(actor===i)proof(i*gap+3,23,i===0?17:12,states[step-1],1.6*(t?.94:1.08));
   machine(i,i*gap,-22,actor===i?2:0);
 }
 human(5*gap,-16,step===6);block(5*gap-18,0,9,46,38,7,'accent-soft','accent-soft');
 if(step===4)proof(5*gap+2,18,17,1,.55);
 if(step===6||step===7)proof(5*gap+2,19,17,5,step===6?1.504:.94);
 if(step===8)block(-22,-16,9,6,66,42,'card','hatch','hatch');
 for(let j=0;j<(step===1||step===8?4:3);j++)proof(-58+j*7,20,12+j*.8,1,.59);
 if(step===7)proof(-59,-5,13,1,.48);
 const dx=t?-56:-48,dy=t?75:101;
 machine(7,dx,dy,actor===7?2:0);
 if(step===8){
   const gauges=['Memory','Processor','Disk','Forge budget'];
   const xs=t?[46,140,234,332]:[282,406,530,654],v=t?486:477;
   gauges.forEach((name,i)=>{
     const x=xs[i],r=t?12:16;
     if(i===0){
       poly([[x-8,v-r],[x+8,v-r],[x+8,v+r],[x-8,v+r]],'card');
       poly([[x-5,v],[x+5,v],[x+5,v+r-3],[x-5,v+r-3]],'hatch');
     }else if(i===1){
       circle([x,v],r,'card');
       line([[x-r+4,v],[x-r+6,v]],'muted');
       line([[x,v],[x+r*.44,v-r*.65]],'ink',1.6);
       circle([x,v],1.7,'ink');
     }else if(i===2){
       poly([[x-21,v-7],[x+21,v-7],[x+21,v+7],[x-21,v+7]],'card');
       line([[x-17,v],[x+17,v]],'muted');
       poly([[x+4,v-4],[x+10,v-4],[x+7,v+1]],'ink');
     }else{
       path(`M${x-19} ${v+7}a19 19 0 0 1 38 0h-7a12 12 0 0 0 -24 0Z`,'sunk');
       for(const angle of [-2.4,-1.6,-.8])line([12,19].map(rad=>[x+rad*Math.cos(angle),v+7+rad*Math.sin(angle)]));
     }
     label(x,v+29,name,14,'middle');
   });
   const wall=p([-19,48,51]);
   leader(wall,t?224:257,t?381:283,'Usage limit','start');
 }
 for(let i=0;i<6;i++){const at=p([i*gap+8,50,6]);leader(at,at[0]+(t?(i===5?8:17):(i===0?36:12)),at[1]+(t?16:24),names[i],t?'start':'middle')}
 const feed=p([-54,-71,35]);leader(feed,t?8:26,feed[1]-40,'Follow up','start');
 const queue=p([-59,22,15]);leader(queue,t?12:32,queue[1]+27,'Queue','start');
 const reader=p([dx-12,dy+6,20]);if(t && step===8)leader(reader,232,448,'Dispatcher','start');
 else leader(reader,reader[0]-(t?9:36),reader[1]+29,'Dispatcher','end');
 if(step===4){const at=p([5*gap+8,20,18]);leader(at,at[0]+12,at[1]-38,'Question','start')}
}
function write(file,w,h){writeFileSync(file,`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" stroke-linejoin="round" stroke-linecap="round"><defs><pattern id="h" width="5" height="4" patternUnits="userSpaceOnUse"><rect width="5" height="4" fill="${c('sunk')}"/><path d="M0 2h5" stroke="${c('line-strong')}" stroke-width=".7"/></pattern></defs><rect width="100%" height="100%" fill="${c('bg')}"/>${body}</svg>\n`);body=''}
for(const t of [false,true]){const dir=t?'tall':'wide';mkdirSync(dir,{recursive:true});for(let i=1;i<=8;i++){scene(i,t);write(dir+'/step-'+i+'.svg',t?390:960,t?520:540)}}
for(const [row,i] of [0,1,2,3,4,6,7].entries()){const y=93+row*99;label(42,y-27,names[i],18);for(let j=0;j<3;j++){camera(280+j*242,y,false,1.27);block(-28,-4,7,64,3,4);if(j===2){if(i===7){block(-7,39,7,22,13,6);circle(p([4,46,15]),7*scale,'sunk');line([p([4,46,15]),p([7,46,19])])}else proof(4,45,12,1,.55)}machine(i,0,0,j)}}
write('agents.svg',960,720);
for(let i=0;i<5;i++){camera(75+i*184,110,false,1.7);proof(0,0,0,i+1);label(85+i*185,191,['Issue','Pull request','Comments','Checks','Merged'][i],18,'middle')}
write('item-states.svg',960,240);
