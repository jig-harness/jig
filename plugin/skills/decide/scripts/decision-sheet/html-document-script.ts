/**
 * The script of the document template: light interactivity that
 * enhances a sheet which already holds all of its content. With JavaScript
 * off, every section, option and matrix cell is visible, and the controls
 * that need a script (picks, the tray, the time left) stay hidden.
 *
 * What it does: traces one option, call or owner across the sheet on hover and
 * focus; marks the current section in the top bar and shows the time left;
 * lets the reader pick one option per open call and copy the picks as text.
 *
 * It reads the embedded source (`#decision-source`), never the page, for what
 * a call holds, and the `labels.ts` table for every word it writes, so the
 * sheet says nothing the source or the label table does not. It makes no
 * network request. Picks live in `localStorage`, keyed by decision id, and are
 * not a ruling: the decision record stays canonical.
 *
 * A pick is dropped on load when its call has a ruling, or names an option
 * that is no longer there: a sheet regenerated after a ruling must not show
 * a stored pick for a ruled call, in the top bar, the call index or the tray.
 *
 * This is plain script text, not TypeScript. It must hold no backtick and no
 * dollar-brace, because the module wraps it in a template literal.
 */

import { embedJson } from "../sheet-kit/html.ts";
import { KIT_SCRIPT as KS } from "../sheet-kit/script.ts";
import { DOCUMENT_LABEL, LABEL } from "./labels.ts";
import { REF_PATTERN } from "./refs.ts";

/** What starts a trace: an option chip, a call chip, a reference, a call in the bar, an owner. */
const TRACE_FROM = ".chip,.cchip,.ref,.bar-c,.own[tabindex]";

const SCRIPT_BODY = String.raw`
var d=document,W=window,D;
try{D=JSON.parse(d.getElementById('decision-source').textContent)}catch(e){return}
var multi=D.calls.length>1,KEY='decision-sheet:'+D.id,S={p:Object.create(null),why:false,open:false,note:''};
${KS.helpers}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function words(call,opt){return [call===undefined?'':'('+call+')',opt===undefined?'':L.refOption+' '+opt].filter(Boolean).join(' ')}
function plain(s){return String(s||'').replace(new RegExp(REF,'g'),function(m,c,o1,o2){return words(c,o1===undefined?o2:o1)})}
var byId=Object.create(null);D.calls.forEach(function(c){byId[c.id]=c});
var calls=D.calls,open=calls.filter(function(c){return !c.ruling});
function opt(c,id){return c.options.filter(function(o){return o.id===id})[0]}
try{var sv=JSON.parse(localStorage.getItem(KEY));if(sv&&typeof sv==='object')for(var x in sv)S[x]=sv[x]}catch(e){}
function save(){try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}}
// Keep only picks that still mean something: an open call and an option it still has.
function clean(){var p=Object.create(null),bad=false,stored=S.p&&typeof S.p==='object'?S.p:{};
 if(stored!==S.p)bad=true;
 Object.keys(stored).forEach(function(k){var c=byId[k];if(c&&!c.ruling&&typeof stored[k]==='string'&&opt(c,stored[k]))p[k]=stored[k];else bad=true});
 S.p=p;S.why=!!S.why;S.open=!!S.open;S.note=typeof S.note==='string'?S.note:'';return bad}
if(clean())save();
// tracing: one option, call or owner, wherever it appears
${KS.trace(TRACE_FROM)}
${KS.tips}
${KS.barHeight}
${KS.progress}
${KS.inView}
// picks
var btn=d.querySelector('.bar-picks'),tray=null,list,pre,done;
$$('[data-js]').forEach(function(e){e.hidden=false});
$$('.pick').forEach(function(b){b.hidden=false});
function setPick(k,id){if(!byId[k]||byId[k].ruling||!opt(byId[k],id))return;if(S.p[k]===id)delete S.p[k];else S.p[k]=id;save();sync()}
function mentions(k,id){var seen={},out=[],n=0;
 $$('.ref[data-t="o-'+k+'-'+id+'"]').forEach(function(r){if(r.closest('#o-'+k+'-'+id))return;var p=r.closest('[data-place]');var lab=p?p.getAttribute('data-place'):'';if(!lab||seen[lab])return;seen[lab]=1;
  if(!r.id)r.id='ref-'+k+'-'+id+'-'+(++n);out.push('<a href="#'+esc(r.id)+'">'+esc(lab)+'</a>')});return out.join(', ')}
// The text names every pick by call id and option id, so the agent that records the ruling never has to guess.
function text(){var out=[D.id+': '+D.title,D.url,'',multi?L.copyPicksHead:L.copyPickHead];
 calls.forEach(function(c){var o,line=multi?'('+c.id+') ':'';
  if(c.ruling){o=opt(c,c.ruling.option);line+=L.copyRuled+' '+c.ruling.ruledAt+': '+words(undefined,o.id)+': '+o.name}
  else if(S.p[c.id]){o=opt(c,S.p[c.id]);line+=words(undefined,o.id)+': '+o.name;
   if(c.recommended)line+=c.recommended===o.id?' ('+L.copyRecommendedPick+')':' ('+L.copyRecommended+': '+words(undefined,c.recommended)+')';
   if(S.why)line+='\n    '+L.copyRightWhen+' '+plain(o.rightWhen)}
  else{line+=L.copyNoPick;if(c.recommended)line+=' ('+L.copyRecommended+': '+words(undefined,c.recommended)+')'}
  if(S.open&&c.openInput&&!c.ruling)line+='\n    '+L.copyOpenInput+' '+plain(c.openInput);
  out.push(line)});
 if(S.open&&open.length&&D.hiddenBranches&&D.hiddenBranches.length){out.push('',L.copyNextSteps);D.hiddenBranches.forEach(function(b){out.push('- '+plain(b.action))})}
 if(S.note&&S.note.trim())out.push('',L.copyNote+' '+S.note.trim());
 return out.join('\n')}
function renderTray(){if(!tray)return;
 // Rebuilding the list destroys the focused button, so remember it and focus its twin.
 var ae=d.activeElement,fk=ae&&tray.contains(ae)&&ae.hasAttribute('data-call')?{c:ae.getAttribute('data-call'),o:ae.getAttribute('data-opt'),rm:ae.classList.contains('rm')}:null;
 list.innerHTML=calls.map(function(c){var h='<li>'+(multi?'<span class="t">('+esc(c.id)+') '+esc(c.title)+'</span>':'');
  if(c.ruling){var r=opt(c,c.ruling.option);return h+'<span class="nm">'+L.stateDone+' '+esc(LRULED)+' '+esc(c.ruling.ruledAt)+': '+esc(r.id+'. '+r.name)+'</span></li>'}
  h+='<span class="row" role="group" aria-label="'+esc(L.refOption+(multi?' ('+c.id+')':''))+'">'+c.options.map(function(o){
   return '<button type="button" class="o" data-call="'+esc(c.id)+'" data-opt="'+esc(o.id)+'" aria-pressed="'+(S.p[c.id]===o.id)+'" title="'+esc(o.name)+'"><span class="vh">'+esc(L.refOption)+' </span>'+esc(o.id)+'</button>'}).join('')+'</span>';
  if(S.p[c.id]){var o=opt(c,S.p[c.id]),m=mentions(c.id,o.id);h+='<span class="nm">'+esc(o.id+'. '+o.name)+'</span><button type="button" class="tbtn rm" data-call="'+esc(c.id)+'" data-opt="'+esc(o.id)+'">'+esc(L.removePick)+'</button>'+(m?'<span class="ment">'+esc(L.alsoMentioned)+': '+m+'</span>':'')}
  else h+='<span class="nm none">'+esc(L.noPickYet)+'</span>';
  return h+'</li>'}).join('');
 pre.textContent=text();
 if(fk){var back=tray.querySelector('.o[data-call="'+fk.c+'"][data-opt="'+fk.o+'"]');if(fk.rm)back=tray.querySelector('.rm[data-call="'+fk.c+'"]')||back;if(back)back.focus()}}
function sync(){
 $$('.pick').forEach(function(b){var on=S.p[b.getAttribute('data-call')]===b.getAttribute('data-opt');b.setAttribute('aria-pressed',on);b.querySelector('.pl').textContent=on?L.yourPick:L.pick;b.title=on?L.unpickTitle:''});
 $$('.mine').forEach(function(e){e.classList.remove('mine')});
 Object.keys(S.p).forEach(function(k){$$('[data-t="o-'+k+'-'+S.p[k]+'"]').forEach(function(e){e.classList.add('mine')})});
 $$('[data-pick-for]').forEach(function(e){var v=S.p[e.getAttribute('data-pick-for')];e.hidden=!v;e.innerHTML=v?'<span class="vh">'+esc(L.yourPick)+' </span>'+esc(v):''});
 $$('[data-pick-long]').forEach(function(e){var k=e.getAttribute('data-pick-long'),v=S.p[k],c=byId[k],o=v&&opt(c,v);
  e.innerHTML=o?'<a class="chip mine" href="#o-'+esc(k)+'-'+esc(o.id)+'" data-t="o-'+esc(k)+'-'+esc(o.id)+'">'+esc(o.id)+'</a> '+esc(o.name):'<span class="none">–</span>'});
 if(btn){var n=open.filter(function(c){return S.p[c.id]}).length;btn.querySelector('b').textContent=multi?n+' '+L.of+' '+open.length:(S.p[calls[0].id]||'')}
 renderTray()}
function toggle(on,keep){if(!tray)return;tray.hidden=!on;btn.setAttribute('aria-expanded',on);if(on){var f=tray.querySelector('.o[aria-pressed="true"]')||tray.querySelector('.o,.x');if(f)f.focus()}else if(!keep)btn.focus()}
if(btn&&open.length){btn.hidden=false;tray=d.createElement('aside');tray.id='tray';tray.className='tray';tray.hidden=true;tray.setAttribute('role','dialog');tray.setAttribute('aria-label',multi?L.myPicks:L.myPick);
 tray.innerHTML='<div class="tray-h"><h2>'+esc(multi?L.myPicks:L.myPick)+'</h2><button type="button" class="tbtn x">'+esc(L.close)+'</button></div>'+
 '<p class="tray-sub">'+esc(L.trayNote)+'</p><ol class="tray-list"></ol>'+
 '<label class="ck"><input type="checkbox" data-s="why"> '+esc(L.addRightWhen)+'</label><label class="ck"><input type="checkbox" data-s="open"> '+esc(L.addOpenInputs)+'</label>'+
 '<label class="nt"><span>'+esc(L.note)+'</span><textarea rows="2"></textarea></label><h3 class="lab">'+esc(L.textToCopy)+'</h3><pre class="preview" tabindex="0"></pre>'+
 '<div class="tray-a"><button type="button" class="copy">'+esc(L.copyText)+'</button><span class="done" role="status"></span><button type="button" class="tbtn clear">'+esc(L.clearPicks)+'</button></div>';
 d.body.appendChild(tray);list=tray.querySelector('.tray-list');pre=tray.querySelector('.preview');done=tray.querySelector('.done');
 $$('input[data-s]',tray).forEach(function(i){var k=i.getAttribute('data-s');i.checked=!!S[k];i.addEventListener('change',function(){S[k]=i.checked;save();renderTray()})});
 var ta=tray.querySelector('textarea');ta.value=S.note||'';ta.addEventListener('input',function(){S.note=ta.value;save();pre.textContent=text()});
 btn.addEventListener('click',function(){toggle(tray.hidden)});
 tray.querySelector('.x').addEventListener('click',function(){toggle(false)});
 tray.querySelector('.clear').addEventListener('click',function(){S.p=Object.create(null);save();sync()});
 tray.querySelector('.copy').addEventListener('click',function(){var t=text();function ok(){done.textContent=L.copied;setTimeout(function(){done.textContent=''},2500)}
  function fb(){var ae=d.activeElement,a=d.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';d.body.appendChild(a);a.select();try{if(d.execCommand('copy'))ok();else done.textContent=L.copyFallback}catch(e){done.textContent=L.copyFallback}d.body.removeChild(a);if(ae&&ae.focus)ae.focus()}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(ok,fb);else fb()});
 tray.addEventListener('click',function(e){if(e.target.closest('.ment a')&&W.innerWidth<=720)toggle(false,true)});
 d.addEventListener('mousedown',function(e){if(!tray.hidden&&!tray.contains(e.target)&&!btn.contains(e.target)&&!e.target.closest('.pick'))toggle(false,true)})}
d.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.pick,.o,.rm');if(b)setPick(b.getAttribute('data-call'),b.getAttribute('data-opt'))});
d.addEventListener('keydown',function(e){if(e.key==='Escape'){d.documentElement.classList.add('notip');if(tray&&!tray.hidden)toggle(false)}});
sync();
`;

/**
 * The script as it goes into the page. The label table and the token grammar
 * are data it is given, so neither is written twice.
 */
export const DOCUMENT_SCRIPT = `(function(){var L=${embedJson({ ...DOCUMENT_LABEL, refOption: LABEL.refOption })},LRULED=${embedJson(LABEL.ruledOn)},REF=${embedJson(REF_PATTERN)};${SCRIPT_BODY}})();`;
