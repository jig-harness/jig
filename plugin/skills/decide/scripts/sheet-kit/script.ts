/**
 * Script fragments of the sheet kit: light interactivity on a
 * sheet that already holds all of its content. With JavaScript off, every
 * section is visible; the time left and other script-only controls stay
 * hidden.
 *
 * Each fragment is plain script text, not TypeScript, run inside a genre's
 * `(function(){ ... })()` wrapper. They expect `d` (the document), `W` (the
 * window) and `L` (the genre's label table, with `timeLeft` and `timeEnd`) in
 * scope, and read nothing from the page that the sheet did not render. None
 * makes a network request. A fragment must hold no backtick and no
 * dollar-brace, because a genre wraps its script in a template literal; one
 * that holds a backslash is a `String.raw` literal, so it reaches the page as
 * written.
 *
 * The decision sheet's document template is rebuilt from these fragments
 * byte for byte.
 */

/** `$$(selector, root)`: every match, as an array. */
const helpers = `function $$(q,r){return Array.prototype.slice.call((r||d).querySelectorAll(q))}`;

/**
 * Tracing: hover or focus on an element carrying `data-t` lights every
 * element with the same `data-t` (class `hl`). `selector` names what starts
 * a trace.
 */
const trace = (
  selector: string,
) => `function key(e){var t=e.target&&e.target.closest&&e.target.closest('${selector}');return t&&t.getAttribute('data-t')}
// Hover and focus each keep their own key, so leaving one never clears the other; hover wins while it lasts and focus shows again after it, so one option is lit at a time.
var H={m:null,f:null};
function paint(){$$('.hl').forEach(function(e){e.classList.remove('hl')});var k=H.m||H.f;if(k)$$('[data-t="'+k+'"]').forEach(function(e){e.classList.add('hl')})}
d.addEventListener('mouseover',function(e){H.m=key(e)||null;paint()});
d.addEventListener('mouseout',function(){H.m=null;paint()});
d.addEventListener('focusin',function(e){H.f=key(e)||null;paint()});
d.addEventListener('focusout',function(){H.f=null;paint()});`;

/** Escape hides the term tips; moving the mouse or the focus brings them back. The genre's own keydown handler adds the class. */
const tips = `// Escape hides the tips; moving the mouse or the focus brings them back.
d.addEventListener('mousemove',function(){d.documentElement.classList.remove('notip')});
d.addEventListener('focusin',function(){d.documentElement.classList.remove('notip')});`;

/** The bar may wrap onto a second row, so the sticky offsets follow its real height. */
const barHeight = `// the bar may wrap onto a second row, so sticky offsets follow its real height
var bar=d.querySelector('.bar');
function barH(){if(bar)d.documentElement.style.setProperty('--bar-h',bar.offsetHeight+'px')}
barH();W.addEventListener('resize',barH);if(bar&&W.ResizeObserver)new W.ResizeObserver(barH).observe(bar);`;

/** Reading progress and the time left, at 230 words a minute. */
const progress = String.raw`// progress and time left
var prog=d.querySelector('.prog i'),left=d.querySelector('.bar-left'),count=(d.querySelector('main').textContent.match(/\S+/g)||[]).length;
if(left)left.hidden=false;
function onScroll(){var h=d.documentElement,max=h.scrollHeight-h.clientHeight,f=max>0?Math.min(1,Math.max(0,h.scrollTop/max)):1;
 if(prog)prog.style.width=(f*100).toFixed(2)+'%';
 if(left)left.textContent=f>.995?L.timeEnd:L.timeLeft.replace('{n}',Math.max(1,Math.ceil(count*(1-f)/230)))}
W.addEventListener('scroll',onScroll,{passive:true});W.addEventListener('resize',onScroll);onScroll();`;

/** The section in view, marked in the bar's contents. */
const inView = `// the section in view, marked in the bar
var map={},cur=null;$$('.bar nav a[href^="#"]').forEach(function(a){map[a.getAttribute('href').slice(1)]=a});
if('IntersectionObserver' in W){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;var a=map[e.target.id];if(!a)return;
 if(cur)cur.removeAttribute('aria-current');cur=a;a.setAttribute('aria-current','location')})},{rootMargin:'-'+(bar?bar.offsetHeight+8:64)+'px 0px -70% 0px'});
 Object.keys(map).forEach(function(id){var el=d.getElementById(id);if(el)io.observe(el)})}`;

export const KIT_SCRIPT = {
  helpers,
  trace,
  tips,
  barHeight,
  progress,
  inView,
} as const;
