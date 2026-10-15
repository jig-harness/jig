/**
 * The script of the audit sheet: light interactivity on a sheet that already
 * holds all of its content. With JavaScript off every section is visible and
 * the choices, the profile selector, the score flags, the copy buttons and
 * the tray stay hidden.
 *
 * What it does: shows each recommendation's choices (accept, the lighter
 * option where the card has one, refine, decline, this is wrong) and the
 * fields a choice opens; shows the conditional targets of the profile that
 * will apply beside the profile selector, checked as the record has them;
 * lets the reader flag any criterion's score as wrong, with a note; keeps
 * all of it in `localStorage`, keyed by repository, commit and the report's
 * fingerprint, so a sheet rendered for another commit or another version of
 * the report starts clean; shows the tray once any choice exists, with the
 * counts, what is still missing, the text to copy and the copy button; folds
 * the later and optional recommendations, the criteria still open beyond
 * the target and the module detail away (they render open, for print and
 * for a reader without JavaScript), and opens a folded group when a link
 * points inside it; copies the starter configuration; keeps each popover
 * and term tip inside the viewport; and turns the guide, the page's last
 * section, into a view of its own on the `#guide` route, which Back, Escape
 * or its back link leave for the place the reader came from. The sheet
 * kit's fragments mark the section in view and show the time left; the
 * popovers and the guide do not count toward it.
 *
 * It reads the embedded data block, never the page, for the recommendations
 * and the record; the page's checkboxes for each profile's conditional
 * targets; and the label table for every word it writes. It makes no network
 * request.
 *
 * This is plain script text, not TypeScript. It must hold no backtick and no
 * dollar-brace, because the module wraps it in a template literal.
 */
import { embedJson } from "../../../decide/scripts/sheet-kit/html.ts";
import { KIT_SCRIPT as KS } from "../../../decide/scripts/sheet-kit/script.ts";
import { DATA_BLOCK_ID } from "./data.ts";
import { CHOICES, LIGHTER_PREFIX } from "./feedback-text.ts";
import { SHEET_LABEL } from "./labels.ts";

const SCRIPT_BODY = String.raw`
var d=document,W=window,D;
try{D=JSON.parse(d.getElementById(DATA).textContent)}catch(e){return}
var src=D.source,R=D.record,recs=src.recommendations,KEY='jig-audit:'+src.repository.name+':'+R.commit+':'+D.report;
var KINDS=CHOICES,S={c:{},profile:'',cond:null,s:{}},byId={};
recs.forEach(function(r){byId[r.id]=r});
${KS.helpers}
d.documentElement.classList.add('js');
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function str(v){return typeof v==='string'?v:''}
var sel=d.getElementById('profile-pick'),known={};
if(sel)$$('option',sel).forEach(function(o){if(o.value)known[o.value]=1});
// Keep only choices that still mean something: a recommendation this sheet has, a known choice, a shipped profile, a module, a criterion the record holds.
(function(){var sv;try{sv=JSON.parse(localStorage.getItem(KEY))}catch(e){sv=null}
 if(!sv||typeof sv!=='object')return;
 var c=sv.c&&typeof sv.c==='object'?sv.c:{},sc=sv.s&&typeof sv.s==='object'?sv.s:{};
 Object.keys(c).forEach(function(id){var x=c[id];if(byId[id]&&x&&KINDS.indexOf(x.k)>=0&&(x.k!=='lighter'||byId[id].lighter))S.c[id]={k:x.k,note:str(x.note),reason:str(x.reason),when:str(x.when)}});
 if(known[sv.profile])S.profile=sv.profile;
 if(Array.isArray(sv.cond))S.cond=sv.cond.filter(function(m){return typeof m==='string'&&/^M\d+$/.test(m)});
 Object.keys(sc).forEach(function(ref){if(R.criteria[ref]&&typeof sc[ref]==='string')S.s[ref]=sc[ref]})})();
function save(){try{if(chosen())localStorage.setItem(KEY,JSON.stringify(S));else localStorage.removeItem(KEY)}catch(e){}}
function profileChanged(){return !!S.profile&&S.profile!==(R.profile||'')}
// Modules by number, then criteria by id, as feedback-text.ts orders them: M3 before M12.
function byRef(a,b){var n=function(s){return Number(s.slice(1).split('/')[0])};return n(a)-n(b)||(a<b?-1:a>b?1:0)}
function uniq(a){return a.filter(function(x,i){return a.indexOf(x)===i})}
// The conditional targets of the profile that will apply: the reader's choice, or the record's.
var condSets=$$('fieldset[data-prof]');
function condBox(){var p=S.profile||R.profile||'';return condSets.filter(function(f){return f.getAttribute('data-prof')===p})[0]||null}
function conds(){var f=condBox();if(!f)return [];
 return uniq($$('input',f).filter(function(i){return i.checked}).map(function(i){return i.value})).sort(byRef)}
function condsChanged(){if(!condBox())return false;var now=conds(),was=uniq(R.profile_conditions||[]).sort(byRef);return now.join(',')!==was.join(',')||(profileChanged()&&now.length>0)}
function flagged(){return Object.keys(S.s).sort(byRef)}
function chosen(){return Object.keys(S.c).length>0||profileChanged()||condsChanged()||flagged().length>0}
// The decisions block. feedback-text.ts builds the same text, and a browser test holds the two equal.
function q(s){return JSON.stringify(String(s||'').trim())}
function refs(r){return '['+r.refs.map(q).join(', ')+']'}
// A taken lighter option is a refine whose note names it.
function refineNote(r,c){if(c.k!=='lighter')return c.note;var own=c.note.trim();return LIGHTER+String(r.lighter||'').trim()+(own?'; '+own:'')}
function entry(r,c){
 if(c.k==='decline')return '    - { id: '+r.id+', refs: '+refs(r)+', reason: '+q(c.reason)+', revisit_when: '+q(c.when)+' }';
 if(c.k==='wrong')return '    - { id: '+r.id+', refs: '+refs(r)+', note: '+q(c.note)+' }';
 return '    - { id: '+r.id+', note: '+q(refineNote(r,c))+' }'}
function listOf(k){return k==='lighter'?'refine':k}
function of(list){return recs.filter(function(r){return S.c[r.id]&&listOf(S.c[r.id].k)===list})}
function text(){var out=['# Jig audit decisions: '+src.repository.name+' at '+R.commit.slice(0,7)+' ('+R.date+')','audit_feedback:','  v: 1','  repository: '+q(src.repository.name),'  commit: '+q(R.commit),'  report: '+q(D.report)];
 if(profileChanged())out.push('  profile: '+S.profile);
 if(condsChanged())out.push('  profile_conditions: ['+conds().join(', ')+']');
 var acc=of('accept');if(acc.length)out.push('  accept: ['+acc.map(function(r){return r.id}).join(', ')+']');
 ['refine','decline','wrong'].forEach(function(k){var l=of(k);if(!l.length)return;out.push('  '+k+':');l.forEach(function(r){out.push(entry(r,S.c[r.id]))})});
 var fl=flagged();if(fl.length){out.push('  scores:');fl.forEach(function(ref){out.push('    - { ref: '+q(ref)+', note: '+q(S.s[ref])+' }')})}
 return out.join('\n')}
function noted(k){return k==='refine'||k==='wrong'}
function needs(c){if(c.k==='decline')return [c.reason.trim()?'':L.needReason,c.when.trim()?'':L.needWhen].filter(Boolean);return noted(c.k)&&!c.note.trim()?[L.needNote]:[]}
function missing(){return recs.filter(function(r){return S.c[r.id]&&needs(S.c[r.id]).length}).map(function(r){return r.id+' '+L.needs+' '+needs(S.c[r.id]).join(' '+L.and+' ')})
 .concat(flagged().filter(function(ref){return !S.s[ref].trim()}).map(function(ref){return ref+' '+L.needs+' '+L.needNote}))}
${KS.tips}
${KS.barHeight}
${KS.progress}
${KS.inView}
// The popovers and the map's marks repeat what the sheet says elsewhere and the guide is read on its own, so none of them counts toward the time left.
(function(){var m=d.querySelector('main').cloneNode(true);$$('.pop,.tip,.cells,.guide',m).forEach(function(e){if(e.parentNode)e.parentNode.removeChild(e)});count=(m.textContent.match(/\S+/g)||[]).length;onScroll()})();
// Popovers and term tips: the stylesheet shows them; the script places each inside the viewport, below what it explains or above it where there is no room below.
var popAt=null;
function popHost(e){if(!e||!e.closest)return null;var w=e.closest('.pw,.tw');if(!w&&e.matches('summary'))w=e.querySelector('.pw');return w}
function place(w){var p=w.querySelector('.pop,.tip'),t=w.firstElementChild;if(!p||!t)return;popAt=w;
 if(!p.offsetWidth){W.requestAnimationFrame(function(){if(p.offsetWidth)place(w)});return}
 var r=t.getBoundingClientRect(),vw=d.documentElement.clientWidth,vh=W.innerHeight,pw=p.offsetWidth,ph=p.offsetHeight,y=r.bottom+6;
 if(y+ph>vh-8&&r.top-ph-6>=8)y=r.top-ph-6;
 p.style.left=Math.max(8,Math.min(r.left,vw-pw-8))+'px';p.style.top=y+'px'}
d.addEventListener('mouseover',function(e){var w=popHost(e.target);if(w)place(w)});
d.addEventListener('focusin',function(e){var w=popHost(e.target);if(w)place(w)});
W.addEventListener('scroll',function(){if(popAt)place(popAt)},{passive:true});
// A click inside a module heading's popover selects its text rather than folding the module.
d.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('summary .pop'))e.preventDefault()});
// A link to a place inside a folded group opens the group, so the browser can scroll to it.
function openTo(el){for(var f=el&&el.closest('details');f;f=f.parentElement&&f.parentElement.closest('details'))f.open=true}
d.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(a)openTo(d.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))))});
// The guide: a view of its own on the #guide route. Leaving it returns to the place and the scroll position the reader came from.
var G=d.getElementById('guide'),root=d.documentElement,back=0,from='',yAt=hashOf(W.location.href);
// The view router restores scroll itself; browser history must not restore it a second time. Each history entry carries a key in its state, and its position is kept under that key as the reader scrolls (and in the state itself, for a reload). Arriving at an entry, by Back, Forward or a reload, in the guide or out of it, returns to that entry's own position; an entry never seen before gets the view's default. Only the most recently used positions are kept in memory; an older entry falls back to the one in its state. A position that differs from the one in its entry's state (left by Back before the delayed save) is the only copy, so positions their states already hold are dropped first; memory never holds more than the bound, because an entry a new link discarded from history can never be revisited to save its position.
W.history.scrollRestoration='manual';
var Y={},U={},yO=[],YMAX=20,yT=0,want=null,yN=0,yP=null,yK=mint();
// yP is the position the current entry's state holds, so noting the current entry knows whether memory is the only copy.
function note(k,y){Y[k]=y;if(y===yP)delete U[k];else U[k]=1;if(yO[yO.length-1]===k)return;var i=yO.indexOf(k);if(i>=0)yO.splice(i,1);yO.push(k);
 for(i=0;yO.length>YMAX&&i<yO.length;)if(U[yO[i]])i++;else delete Y[yO.splice(i,1)[0]];
 while(yO.length>YMAX){i=yO.shift();delete Y[i];delete U[i]}}
function saved(k,s){return Y.hasOwnProperty(k)?Y[k]:yOf(s)}
function newKey(){return Date.now().toString(36)+'.'+(++yN)+'.'+Math.random().toString(36).slice(2,6)}
function yOf(s){return s&&typeof s.y==='number'?s.y:null}
function mint(){var s=W.history.state,k=s&&s.k;yP=yOf(s);if(!k){k=newKey();try{W.history.replaceState({k:k,y:yP},'')}catch(e){yP=null}}return k}
function keepY(){clearTimeout(yT);yT=0;var y=W.scrollY;note(yK,y);try{W.history.replaceState({k:yK,y:y},'');yP=y;delete U[yK]}catch(e){}}
W.addEventListener('scroll',function(){note(yK,W.scrollY);if(!yT)yT=setTimeout(keepY,150)},{passive:true});
d.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('a[href^="#"]'))keepY()},true);
W.addEventListener('beforeunload',keepY);
// A keyed state means a traversal to an entry already seen: note the position being left (the page has not moved yet) and the one to return to. A new entry has no position of its own.
W.addEventListener('popstate',function(e){clearTimeout(yT);yT=0;var s=e.state;
 if(s&&s.k){note(yK,W.scrollY);yK=s.k;yP=yOf(s);want=saved(yK,s)}else{yK=mint();want=null}
 var h=hashOf(W.location.href);if(h===yAt)arrive(h,yAt)});
function hashOf(u){var i=u.indexOf('#');return i<0?'':decodeURIComponent(u.slice(i+1))}
// Switching views jumps: the page's smooth scrolling is for moving within one view.
var NOW={behavior:'instant'};
// A smooth scroll still running (a link was just followed) keeps adding to a jump made meanwhile and leaves the page a few pixels off; the jump is made again once the animation has had two frames to end.
// Any later navigation, or the reader scrolling on purpose, drops a jump not yet made again.
// Reader input drops only a jump made before it: the window's capture phase runs ahead of every other handler of the same event, so a jump that event makes itself (Escape leaving the guide) is kept.
var jumpN=0;
function unjump(){jumpN++;root.style.scrollBehavior=''}
function jump(y){var n=++jumpN;root.style.scrollBehavior='auto';W.scrollTo({top:y,left:0,behavior:'instant'});
 W.requestAnimationFrame(function(){W.requestAnimationFrame(function(){if(n!==jumpN)return;if(W.scrollY!==y)W.scrollTo({top:y,left:0,behavior:'instant'});root.style.scrollBehavior=''})})}
['wheel','touchstart','keydown','mousedown'].forEach(function(t){W.addEventListener(t,unjump,{capture:true,passive:true})});
function isGuide(h){return h==='guide'||h.indexOf('guide-')===0}
function show(h,old,first){var on=!!G&&isGuide(h),was=root.classList.contains('guide-on'),el=h?d.getElementById(h):null;
 unjump();
 if(on&&!was){back=W.scrollY;from=old}
 root.classList.toggle('guide-on',on);
 if(on){if(h==='guide'||!el)jump(0);else el.scrollIntoView(NOW);return}
 if(was&&(h===from||!el)){jump(back);return}
 if(el&&(was||first)){openTo(el);el.scrollIntoView(NOW)}}
function arrive(h,old,first){var y=want;want=null;yAt=h;show(h,old,first);if(y!==null)jump(y)}
function leave(){keepY();yK=newKey();yP=null;W.history.pushState({k:yK,y:null},'',from?'#'+from:W.location.pathname+W.location.search);yAt=from;show(from,'',false)}
W.addEventListener('hashchange',function(e){var s=W.history.state;if(!s||s.k!==yK){yK=mint();want=null}arrive(hashOf(W.location.href),hashOf(e.oldURL||''))});
$$('[data-back]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();leave()})});
// choices
$$('[data-js]').forEach(function(e){e.hidden=false});
var cards=$$('.rec[data-rec]'),crits=$$('li[data-crit]'),tray=d.getElementById('tray'),anyLighter=recs.some(function(r){return r.lighter});
// Folded groups stay open where they hold a choice or a flag; print opens them all.
var folds=$$('details[data-fold]');
folds.forEach(function(f){f.open=$$('.rec[data-rec]',f).some(function(c){return S.c[c.getAttribute('data-rec')]})||$$('li[data-crit]',f).some(function(li){return S.s[li.getAttribute('data-crit')]!==undefined})});
W.addEventListener('beforeprint',function(){folds.forEach(function(f){f.open=true})});
function paintCard(card){var id=card.getAttribute('data-rec'),c=S.c[id],k=c?c.k:'',more=card.querySelector('.more');
 if(k)card.setAttribute('data-choice',k);else card.removeAttribute('data-choice');
 $$('input[type=radio]',card).forEach(function(i){i.checked=i.value===k});
 card.querySelector('.clr').hidden=!k;more.hidden=!k||k==='accept';
 $$('[data-for]',more).forEach(function(l){var on=(' '+l.getAttribute('data-for')+' ').indexOf(' '+k+' ')>=0,f=l.querySelector('[data-f]');l.hidden=!on;l.classList.toggle('need',on&&(k==='decline'||noted(k))&&!f.value.trim())})}
function fill(card){var c=S.c[card.getAttribute('data-rec')];$$('[data-f]',card).forEach(function(f){f.value=c?c[f.getAttribute('data-f')]:''})}
function paintCrit(li){var ref=li.getAttribute('data-crit'),on=S.s[ref]!==undefined,n=li.querySelector('.swn');
 if(on)li.setAttribute('data-flag','');else li.removeAttribute('data-flag');
 li.querySelector('[data-sw]').checked=on;n.hidden=!on;n.classList.toggle('need',on&&!S.s[ref].trim())}
function fillCrit(li){li.querySelector('[data-swn]').value=S.s[li.getAttribute('data-crit')]||''}
function paintConds(){var f=condBox();condSets.forEach(function(x){x.hidden=x!==f||!$$('input',x).length});
 if(f)$$('input',f).forEach(function(i){i.checked=S.cond?S.cond.indexOf(i.value)>=0:i.defaultChecked})}
function paintTray(){if(!tray)return;var on=chosen();tray.hidden=!on;d.documentElement.classList.toggle('has-tray',on);if(!on)return;
 var n={};KINDS.forEach(function(k){n[k]=0});Object.keys(S.c).forEach(function(id){n[S.c[id].k]++});
 var h=KINDS.filter(function(k){return k!=='lighter'||anyLighter}).map(function(k){return '<span>'+esc(L.choice[k])+' <b>'+n[k]+'</b></span>'}).join('');
 if(profileChanged())h+='<span>'+esc(L.profileChosen)+' <b>'+esc(S.profile)+'</b></span>';
 if(condsChanged()){var cs=conds();h+='<span>'+esc(L.conditionsChosen)+' <b>'+esc(cs.length?cs.join(', '):L.noneWord)+'</b></span>'}
 var nf=flagged().length;if(nf)h+='<span>'+esc(L.scoresFlagged)+' <b>'+nf+'</b></span>';
 tray.querySelector('.counts').innerHTML=h;
 var m=missing(),miss=tray.querySelector('.miss');miss.hidden=!m.length;miss.textContent=m.length?L.notReady+' '+m.join('; ')+'.':'';
 tray.querySelector('[data-act=copy]').disabled=m.length>0;
 tray.querySelector('.preview').textContent=text();
 d.documentElement.style.setProperty('--tray-h',tray.offsetHeight+'px')}
function sync(){cards.forEach(paintCard);crits.forEach(paintCrit);paintConds();paintTray()}
cards.forEach(function(card){var id=card.getAttribute('data-rec');fill(card);
 card.addEventListener('change',function(e){var t=e.target;if(t.type!=='radio')return;S.c[id]=S.c[id]||{k:t.value,note:'',reason:'',when:''};S.c[id].k=t.value;save();sync()});
 card.addEventListener('input',function(e){var f=e.target.getAttribute&&e.target.getAttribute('data-f');if(!f||!S.c[id])return;S.c[id][f]=e.target.value;save();paintCard(card);paintTray()});
 card.querySelector('.clr').addEventListener('click',function(){delete S.c[id];fill(card);save();sync()})});
crits.forEach(function(li){var ref=li.getAttribute('data-crit'),note=li.querySelector('[data-swn]');fillCrit(li);
 li.querySelector('[data-sw]').addEventListener('change',function(e){if(e.target.checked)S.s[ref]=note.value;else delete S.s[ref];save();paintCrit(li);paintTray()});
 note.addEventListener('input',function(){if(S.s[ref]===undefined)return;S.s[ref]=note.value;save();paintCrit(li);paintTray()})});
condSets.forEach(function(f){f.addEventListener('change',function(){S.cond=$$('input',f).filter(function(i){return i.checked}).map(function(i){return i.value});save();paintTray()})});
// Another profile has other conditional targets: they start as the record has them.
if(sel){sel.value=S.profile;sel.addEventListener('change',function(){S.profile=sel.value;S.cond=null;paintConds();save();paintTray()})}
function copy(t,done){function ok(){done.textContent=L.copied;setTimeout(function(){done.textContent=''},2500)}
 function fb(){var ae=d.activeElement,a=d.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';d.body.appendChild(a);a.select();
  try{if(d.execCommand('copy'))ok();else done.textContent=L.copyFallback}catch(e){done.textContent=L.copyFallback}d.body.removeChild(a);if(ae&&ae.focus)ae.focus()}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(ok,fb);else fb()}
function showText(on){var b=tray.querySelector('[data-act=show]');tray.querySelector('.preview').hidden=!on;b.setAttribute('aria-expanded',on);b.textContent=on?L.hideText:L.showText;paintTray()}
if(tray){
 tray.querySelector('[data-act=show]').addEventListener('click',function(){showText(tray.querySelector('.preview').hidden)});
 tray.querySelector('[data-act=copy]').addEventListener('click',function(){if(missing().length)return;showText(true);copy(text(),tray.querySelector('.done'))});
 tray.querySelector('[data-act=reset]').addEventListener('click',function(){S={c:{},profile:'',cond:null,s:{}};cards.forEach(fill);crits.forEach(fillCrit);if(sel)sel.value='';paintConds();save();showText(false);sync()})}
$$('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var from=d.getElementById(b.getAttribute('data-copy'));if(from)copy(from.textContent,b.parentNode.querySelector('.done'))})});
d.addEventListener('keydown',function(e){if(e.key!=='Escape')return;d.documentElement.classList.add('notip');if(root.classList.contains('guide-on'))leave()});
sync();
// Opening the sheet is an arrival too: a reloaded entry returns to its saved position.
want=saved(yK,W.history.state);arrive(hashOf(W.location.href),'',true);
`;

export const REPORT_SCRIPT = `(function(){var L=${embedJson(SHEET_LABEL)},DATA=${embedJson(DATA_BLOCK_ID)},CHOICES=${embedJson(CHOICES)},LIGHTER=${embedJson(LIGHTER_PREFIX)};${SCRIPT_BODY}})();`;
