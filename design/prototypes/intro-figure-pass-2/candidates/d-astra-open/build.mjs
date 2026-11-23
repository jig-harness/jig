import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const color=(name,hex)=>`var(--${name},#${hex})`;
const ink=color('ink','251e18'), paper=color('bg','f9f6f1'), white=color('card','fffdfa'), grey=color('sunk','f0ece5'), quiet=color('muted','59514a'), hair=color('line','d5d0c8'), green=color('accent','1a6444'), mint=color('accent-soft','dbf2e4'), hatch='url(#engrave)';
const path=(d,f='none',s=ink,w=1)=>`<path d="${d}" fill="${f}" stroke="${s}" stroke-width="${w}"/>`;
const circ=(x,y,r,f=white,s=ink)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${f}" stroke="${s}"/>`;
const g=(x,y,k,body)=>`<g transform="translate(${x} ${y}) scale(${k})">${body}</g>`;
const label=(x,y,t,size=14,anchor='middle',weight=550)=>`<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${ink}">${t}</text>`;
const names=['Pick up','Build','Open','Drive','Repair','Merge','Follow up','Dispatcher'];
const deck=(w,d,h,face=white,side=hatch)=>path(`M0 0l${w} ${w*.26} ${d} ${-d*.54} ${-w} ${-w*.26}Z`,face)+path(`M0 0l${w} ${w*.26}v${h}l${-w} ${-w*.26}Z`,side)+path(`M${w} ${w*.26}l${d} ${-d*.54}v${h}l${-d} ${d*.54}Z`,grey);
function item(state){
 const ticket=path('M-23 -14H8L16 -7V16H-23Z',white)+circ(-17,-8,2.1,grey)+path('M-17 1H5M-17 5H0M-17 10H-7','none',quiet,.8);
 const leaf=path('M-4 -20H27L34 -13V12H-4Z',white)+path('M27 -20v7h7 M0 -16v24','none',quiet,.8);
 const speech=y=>path(`M4 ${y}h13v5h-7l-4 3v-3H4Z`,grey);
 const tick=(x,y)=>path(`M${x} ${y}l2 2 4 -5`,'none',green,1.8);
 let marks=path('M5 -9h17M5 -4h13M5 2h17','none',quiet,.8);
 if(state===3||state===4)marks=speech(-13)+speech(-1)+(state===3?circ(26,-10,2.3)+circ(26,-3,2.3)+path('M23 2l6 6m0 -6 -6 6','none',ink,1.7):[-10,-3,5].map(y=>tick(23,y)).join(''));
 const seal=path('M-21 -11h31l8 7v23h-39Z',grey)+ticket+path('M-23 0h39v9h-39Z',mint)+circ(6,4,6,green)+path('M2 4l3 2 5 -6','none',white,1.4);
 return `<g transform="matrix(1 .26 -.28 .86 0 0)">${state===5?seal:ticket+(state>1?leaf+marks:'')}</g>`;
}
function person(act){
 return g(-20,-2,1,deck(38,19,12,mint,green))+path('M-10 -12q-2 -13 6 -17q9 -2 11 8l4 10 -8 4 -4 -10v12l-10 -2Z',mint)+path('M-5 -31q-4 -3 -3 -9q1 -7 7 -6q5 1 5 6l2 3 -3 1q1 7 -6 5Z',white)+path('M-8 -40q-1 -9 8 -7l4 4 -2 3 -5 -1 -2 4Z',ink)+path(act?'M2 -24l7 10 19 5 -1 4 -23 -5 -7 -10Z':'M2 -24l8 9 8 -3 2 4 -13 6 -10 -12Z',mint)+path(act?'M18 -3l11 -5':'M18 -3l4 -16','none',ink,2)+circ(18,-3,2);
}
function machine(id,pose=0){
 if(id===5)return person(pose===2);
 const x=[12,24,34][pose], y=[-29,-23,-13][pose];
 const foot=g(-17,-1,1,deck(24,13,5));
 if(id===6)return foot+path('M-14 -4v-25l14 -7 16 5v24l-15 8Z',white)+path('M1 1v-24l15 -8v24Z',hatch)+circ(-6,-15,5,grey)+circ(-6,-15,2)+path('M5 -12l10 -5v4l-10 5Z',ink)+g(10+pose*3,-12+pose,0.22+pose*.08,item(1));
 const tools=[
 path('M-2 -3v7l-8 4v2l16 4 6 -4 -10 -5V-3Z',grey),
 path('M-9 2l9 -5 12 4 -9 6Z',grey)+path('M-9 2v6l12 4V7Z',hatch)+circ(6,6,5,grey),
 path('M-4 -3l8 2 7 16 -16 -7Z',white)+path('M-5 8l16 7 -4 1 -15 -6Z',hatch),
 path('M-3 0l4 5','none',ink,3)+`<g transform="rotate(15 3 9)"><ellipse cx="3" cy="9" rx="11" ry="7" fill="${grey}" stroke="${ink}"/><ellipse cx="3" cy="8" rx="8" ry="4.8" fill="${white}" stroke="${quiet}"/></g>`,
 path('M-5 -4l9 2v12l-5 3 -5 -3Z',hatch)+path('M-8 9l13 3 4 -3v4l-5 3 -12 -3Z',grey),
 '', '',path('M-5 0l12 3 -2 6 -5 4 -6 -2Z',hatch)];
 const body=path('M-12 -2v-25l6 -6 9 3v27l-7 4Z',white)+path('M-4 1v-26l7 -5v27Z',hatch)+path('M-10 -14l4 1m-4 3 4 1','none',quiet,.7);
 return foot+body+path(`M-8 -28l12 -14 ${x+1} ${y+37} -3 5 -${x} -${y+32} -8 10Z`,grey)+circ(-5,-27,4)+circ(5,-38,3)+g(x,y,1,tools[id])+circ(x,y,2);
}
const namesAt=['Queue','Pick up','Open','Drive','Repair','Merge','Follow up','Dispatcher'];
const active=[-1,0,2,3,4,5,6,7], states=[0,1,2,3,4,5,5,0];
function fan(){return [0,1,2].map(i=>g(i*5,-i*4,.69,item(1))).join('')}
function wall(){return path('M0 0v-34l14 -8v34Z',hatch)+path('M0 -34l-3 -1 14 -8 3 1Z',white)+path('M0 0l-3 -1v-34l3 1Z',grey)}
const question=()=>path('M0 0v-16h21v14H7L2 2v-4Z',white)+path('M4 -12h12m-12 4h8','none',quiet,.8);
function overview(s,t){
 const pts=t?[[85,103],[173,103],[261,103],[320,184],[226,184],[134,184],[34,52]]:[[171,120],[302,120],[428,120],[554,120],[680,120],[815,120],[65,68]];
 const q=t?[31,111]:[65,125],k=t?.71:1.12;
 let out=path('M'+[q,...pts.slice(0,6)].map(([x,y])=>[x,y+8].join(' ')).join(' L'),'none',quiet,2)+path('M'+[q,...pts.slice(0,6)].map(([x,y])=>[x,y+12].join(' ')).join(' L'),'none',hair,2);
 const [fx,fy]=pts[6];
 out+=path(`M${fx+8} ${fy+7}L${q[0]-10} ${q[1]-4}m3 -5 -3 5 -1 -5`,'none',quiet,.85)+g(...q,k,fan())+label(q[0],q[1]+35,'Queue');
 pts.forEach(([x,y],id)=>{
 const state=id===active[s]&&s>=1&&s<=4?states[s]:id===5&&(s===5||s===6)?5:0;
 if(id===active[s] && s>=1 && s<=6){
 const bx=x-18*k, by=id===6?y-42*k-18:y+46;
 out+=path(`M${bx} ${by+(id===6?5:-5)}v${id===6?-5:5}h${69*k}v${id===6?5:-5}`,'none',ink,2.4);
 }
 if(s===6 && id===6)out+=g(x+24*k,y+5*k,k*.58,item(1));
 if(state)out+=g(x+31*k,y+3*k,k*.73,item(state));
 out+=g(x,y,k,machine(id,active[s]===id?2:0))+label(x+(id===6?15:3),y+(id===6?-42*k:33),names[id]);
 if(s===3&&id===5)out+=g(x+23*k,y-5*k,k,question());
 });

 return out;
}
function rack(count){
 let r=deck(23*count+8,24,4,grey);
 for(let i=0;i<count;i++){
 const x=12+i*23;
 r+=g(x+6,x*.26-8,.75,item(1))+path(`M${x-8} ${x*.26-2}l23 6 4 -3v4l-4 3 -23 -6Z`,hatch);
 }
 return r;
}
function capacity(t){
 const x=t?22:95,y=t?314:278,k=t?.79:1.65;
 let c=g(x,y,k,deck(203,43,5,grey)+g(4,-5,1,rack(4))+
 path('M119 31v-34l45 -24V7Z',hatch)+path('M119 -3l-5 -2 45 -24 5 2Z',white)+path('M119 31l-5 -2v-34l5 2Z',grey));
 const wx=x+158*k, wy=y-27*k;
 c+=path(`M${wx} ${wy}l9 -13h9`,'none',quiet)+label(wx+22,wy-10,'Usage limit',t?15:20,'start');
 const shapes=[
 path('M-11 0v-31h22V0Z',grey)+path('M-6 -3v-16H6v16Z',hatch)+path('M-6 -24H6','none',quiet),
 path('M-22 0v-7a22 22 0 0 1 44 0v7Z',white)+path('M-16 -7a16 16 0 0 1 32 0','none',quiet)+path('M0 -6l9 -13','none',ink,2)+circ(0,-6,2),
 circ(0,-14,16,grey)+path('M0 -14v-12a12 12 0 1 1 -11 16Z',hatch)+circ(0,-14,3),
 path('M-25 -17h50v13h-50Z',grey)+path('M-21 -13h25v5h-25Z',hatch)+path('M9 -19v17','none',ink,2)
 ];
 const xs=t?[44,139,232,332]:[157,365,578,795], gy=t?464:451;
 const dx=t?197:494,dy=t?402:375,dk=t?1.03:1.6;
 c+=g(dx,dy,dk,machine(7,2));
 xs.forEach((xx,i)=>{
 const yy=gy;
 c+=g(xx-(t?31:50),yy+1,t?1.15:1.9,deck(44,13,3,grey));
  c+=g(xx,yy-6,t?1.38:2.15,shapes[i])+label(xx,yy+(t?37:58),['Memory','Processor','Disk','Forge budget'][i],t?14:16);
 });
 return c;
}
function detail(s,t){
 const top=t?236:173;
 let d=path(`M${t?18:42} ${top}H${t?372:918}`,'none',quiet,.8)+label(t?19:42,top+31,namesAt[s],t?23:29,'start',620);
 if(s===7)return d+capacity(t);
 const cx=t?(s===0?272:123):(s===0?646:421),base=t?377:373,k=t?2:3.63;
 const tool=s===0?0:active[s],ix=cx+(tool===5?37:35)*k;
 const x=t?24:62,w=t?290:747,depth=t?48:87,y=t?362:296;
 d+=g(x,y,1,deck(w,depth,t?8:12,grey));
 if(s===0)d+=g(t?40:106,t?365:318,t?1.7:3.3,rack(5));
 else if(s<=5)d+=g(ix,base+2*k,k,item(states[s]));
 else {
 const rx=t?33:155, ry=t?361:318, rk=t?.96:1.85;
 const endX=rx+79*rk, endY=ry+15*rk;
 const length=t?120:234, startX=endX+length, startY=endY+length*.26;
 const mk=t?1.8:3.2;
 d+=g(startX+16*mk,startY+9*mk,mk,'<g transform="scale(-1 1)">'+machine(6,2)+'</g>');
 d+=g(endX,endY,1,deck(length,13,3,white));
 d+=path(`M${endX+26} ${endY+2}l-11 -3 5 7m-5 -7 9 -3`,'none',ink,2);
 d+=g(endX+length*.50+6,endY+length*.13-4,t?.55:1,item(1))+g(rx,ry,rk,rack(3));
 return d+label(endX+length*.50+6,t?484:521,'Issue',t?17:21);
 }
 d+=g(cx,base,k,s===0?'<g transform="scale(-1 1)">'+machine(0,0)+'</g>':machine(tool,2));
 if(s===3){const px=t?305:769,py=t?393:440;d+=g(px,py,t?1:1.65,person(false))+g(px+19,py-8,1,question())+label(px,t?485:521,'Question',t?14:18);}
 const caption=['Issue','Issue','Pull request','Comments','Checks','Merged','Issue'][s];
 const lx=s===0?(t?117:346):ix;
 d+=label(lx,t?484:521,caption,t?17:21);
 if(s===3)d+=label(lx,t?505:537,'Checks',t?14:15);
 return d;
}
function save(file,w,h,body){
 writeFileSync(file,`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" stroke-linejoin="round" stroke-linecap="round"><defs><pattern id="engrave" width="5" height="4" patternUnits="userSpaceOnUse"><rect width="5" height="4" fill="${grey}"/><path d="M-1 0l7 2" stroke="${quiet}" stroke-width=".55"/></pattern></defs><rect width="100%" height="100%" fill="${paper}"/>${body}</svg>\n`);
}
for(const t of [false,true]){
 const dir=t?'tall':'wide';mkdirSync(dir,{recursive:true});
 for(let s=0;s<8;s++)save(`${dir}/step-${s+1}.svg`,t?390:960,t?520:540,overview(s,t)+detail(s,t));
}
save('agents.svg',960,720,[0,1,2,3,4,6,7].map((id,i)=>label(43,88+i*99,names[id],19,'start')+[0,1,2].map((p,j)=>g(265+j*250,87+i*99,1.6,machine(id,p))).join('')).join(''));
save('item-states.svg',960,240,[1,2,3,4,5].map((s,i)=>g(86+i*190,115,2.45,item(s))+label(90+i*190,203,['Issue','Pull request','Comments','Checks','Merged'][i],20)).join(''));
