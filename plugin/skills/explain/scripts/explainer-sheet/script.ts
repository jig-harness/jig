/**
 * The script of the explainer sheet, built from the sheet kit's
 * fragments: hover or focus on a step reference lights the step it names;
 * the top bar marks the section in view and shows the time left; Escape
 * hides the term tips. With JavaScript off every section is visible and only
 * the time left stays hidden. It makes no network request and stores
 * nothing.
 */
import { embedJson } from "../../../decide/scripts/sheet-kit/html.ts";
import { KIT_SCRIPT as KS } from "../../../decide/scripts/sheet-kit/script.ts";
import { SHEET_LABEL } from "./labels.ts";

/** What starts a trace: a step reference in the text, or a step's own number. */
const TRACE_FROM = ".ref,.sn";

const BODY = `
var d=document,W=window;
${KS.helpers}
${KS.trace(TRACE_FROM)}
${KS.tips}
${KS.barHeight}
${KS.progress}
${KS.inView}
d.addEventListener('keydown',function(e){if(e.key==='Escape')d.documentElement.classList.add('notip')});
`;

export const EXPLAINER_SCRIPT = `(function(){var L=${embedJson(SHEET_LABEL)};${BODY}})();`;
