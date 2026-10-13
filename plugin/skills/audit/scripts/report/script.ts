/**
 * The script of the audit sheet: light interactivity on a sheet that already
 * holds all of its content. With JavaScript off every section is visible and
 * the choices, the profile selector, the copy buttons and the tray stay
 * hidden.
 *
 * What it does: shows each recommendation's choices (accept, the lighter
 * option where the card has one, refine, decline, this is wrong) and the
 * fields a choice opens; keeps the choices in `localStorage`, keyed by repository,
 * commit and the report's fingerprint, so a sheet rendered for another commit
 * or another version of the report starts clean; shows the
 * tray once any choice exists, with the counts, what is still missing, the
 * text to copy and the copy button; folds the later and optional
 * recommendations away (they render open, for print and for a reader without
 * JavaScript); and copies the starter configuration.
 * The sheet kit's fragments mark the section in view and show the time left.
 *
 * It reads the embedded data block, never the page, for the recommendations
 * and the record, and the label table for every word it writes. It makes no
 * network request.
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
var KINDS=CHOICES,S={c:{},profile:''},byId={};
recs.forEach(function(r){byId[r.id]=r});
${KS.helpers}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function str(v){return typeof v==='string'?v:''}
var sel=d.getElementById('profile-pick'),known={};
if(sel)$$('option',sel).forEach(function(o){if(o.value)known[o.value]=1});
// Keep only choices that still mean something: a recommendation this sheet has, a known choice, a shipped profile.
(function(){var sv;try{sv=JSON.parse(localStorage.getItem(KEY))}catch(e){sv=null}
 if(!sv||typeof sv!=='object')return;
 var c=sv.c&&typeof sv.c==='object'?sv.c:{};
 Object.keys(c).forEach(function(id){var x=c[id];if(byId[id]&&x&&KINDS.indexOf(x.k)>=0&&(x.k!=='lighter'||byId[id].lighter))S.c[id]={k:x.k,note:str(x.note),reason:str(x.reason),when:str(x.when)}});
 if(known[sv.profile])S.profile=sv.profile})();
function save(){try{if(chosen())localStorage.setItem(KEY,JSON.stringify(S));else localStorage.removeItem(KEY)}catch(e){}}
function profileChanged(){return !!S.profile&&S.profile!==(R.profile||'')}
function chosen(){return Object.keys(S.c).length>0||profileChanged()}
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
 var acc=of('accept');if(acc.length)out.push('  accept: ['+acc.map(function(r){return r.id}).join(', ')+']');
 ['refine','decline','wrong'].forEach(function(k){var l=of(k);if(!l.length)return;out.push('  '+k+':');l.forEach(function(r){out.push(entry(r,S.c[r.id]))})});
 return out.join('\n')}
function noted(k){return k==='refine'||k==='wrong'}
function needs(c){if(c.k==='decline')return [c.reason.trim()?'':L.needReason,c.when.trim()?'':L.needWhen].filter(Boolean);return noted(c.k)&&!c.note.trim()?[L.needNote]:[]}
function missing(){return recs.filter(function(r){return S.c[r.id]&&needs(S.c[r.id]).length}).map(function(r){return r.id+' '+L.needs+' '+needs(S.c[r.id]).join(' '+L.and+' ')})}
${KS.tips}
${KS.barHeight}
${KS.progress}
${KS.inView}
// choices
$$('[data-js]').forEach(function(e){e.hidden=false});
var cards=$$('.rec[data-rec]'),tray=d.getElementById('tray'),anyLighter=recs.some(function(r){return r.lighter});
// Later and optional recommendations fold away, except a group holding a choice; print opens them all.
var folds=$$('details[data-fold]');
folds.forEach(function(f){f.open=$$('.rec[data-rec]',f).some(function(c){return S.c[c.getAttribute('data-rec')]})});
W.addEventListener('beforeprint',function(){folds.forEach(function(f){f.open=true})});
function paintCard(card){var id=card.getAttribute('data-rec'),c=S.c[id],k=c?c.k:'',more=card.querySelector('.more');
 if(k)card.setAttribute('data-choice',k);else card.removeAttribute('data-choice');
 $$('input[type=radio]',card).forEach(function(i){i.checked=i.value===k});
 card.querySelector('.clr').hidden=!k;more.hidden=!k||k==='accept';
 $$('[data-for]',more).forEach(function(l){var on=(' '+l.getAttribute('data-for')+' ').indexOf(' '+k+' ')>=0,f=l.querySelector('[data-f]');l.hidden=!on;l.classList.toggle('need',on&&(k==='decline'||noted(k))&&!f.value.trim())})}
function fill(card){var c=S.c[card.getAttribute('data-rec')];$$('[data-f]',card).forEach(function(f){f.value=c?c[f.getAttribute('data-f')]:''})}
function paintTray(){if(!tray)return;var on=chosen();tray.hidden=!on;d.documentElement.classList.toggle('has-tray',on);if(!on)return;
 var n={};KINDS.forEach(function(k){n[k]=0});Object.keys(S.c).forEach(function(id){n[S.c[id].k]++});
 var h=KINDS.filter(function(k){return k!=='lighter'||anyLighter}).map(function(k){return '<span>'+esc(L.choice[k])+' <b>'+n[k]+'</b></span>'}).join('');
 if(profileChanged())h+='<span>'+esc(L.profileChosen)+' <b>'+esc(S.profile)+'</b></span>';
 tray.querySelector('.counts').innerHTML=h;
 var m=missing(),miss=tray.querySelector('.miss');miss.hidden=!m.length;miss.textContent=m.length?L.notReady+' '+m.join('; ')+'.':'';
 tray.querySelector('[data-act=copy]').disabled=m.length>0;
 tray.querySelector('.preview').textContent=text();
 d.documentElement.style.setProperty('--tray-h',tray.offsetHeight+'px')}
function sync(){cards.forEach(paintCard);paintTray()}
cards.forEach(function(card){var id=card.getAttribute('data-rec');fill(card);
 card.addEventListener('change',function(e){var t=e.target;if(t.type!=='radio')return;S.c[id]=S.c[id]||{k:t.value,note:'',reason:'',when:''};S.c[id].k=t.value;save();sync()});
 card.addEventListener('input',function(e){var f=e.target.getAttribute&&e.target.getAttribute('data-f');if(!f||!S.c[id])return;S.c[id][f]=e.target.value;save();paintCard(card);paintTray()});
 card.querySelector('.clr').addEventListener('click',function(){delete S.c[id];fill(card);save();sync()})});
if(sel){sel.value=S.profile;sel.addEventListener('change',function(){S.profile=sel.value;save();paintTray()})}
function copy(t,done){function ok(){done.textContent=L.copied;setTimeout(function(){done.textContent=''},2500)}
 function fb(){var ae=d.activeElement,a=d.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';d.body.appendChild(a);a.select();
  try{if(d.execCommand('copy'))ok();else done.textContent=L.copyFallback}catch(e){done.textContent=L.copyFallback}d.body.removeChild(a);if(ae&&ae.focus)ae.focus()}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(ok,fb);else fb()}
function showText(on){var b=tray.querySelector('[data-act=show]');tray.querySelector('.preview').hidden=!on;b.setAttribute('aria-expanded',on);b.textContent=on?L.hideText:L.showText;paintTray()}
if(tray){
 tray.querySelector('[data-act=show]').addEventListener('click',function(){showText(tray.querySelector('.preview').hidden)});
 tray.querySelector('[data-act=copy]').addEventListener('click',function(){if(missing().length)return;showText(true);copy(text(),tray.querySelector('.done'))});
 tray.querySelector('[data-act=reset]').addEventListener('click',function(){S={c:{},profile:''};cards.forEach(fill);if(sel)sel.value='';save();showText(false);sync()})}
$$('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var from=d.getElementById(b.getAttribute('data-copy'));if(from)copy(from.textContent,b.parentNode.querySelector('.done'))})});
d.addEventListener('keydown',function(e){if(e.key==='Escape')d.documentElement.classList.add('notip')});
sync();
`;

export const REPORT_SCRIPT = `(function(){var L=${embedJson(SHEET_LABEL)},DATA=${embedJson(DATA_BLOCK_ID)},CHOICES=${embedJson(CHOICES)},LIGHTER=${embedJson(LIGHTER_PREFIX)};${SCRIPT_BODY}})();`;
