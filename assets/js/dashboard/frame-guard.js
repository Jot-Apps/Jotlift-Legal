/* Refuse to run inside a frame.
 *
 * The dashboard is the one page that holds a session, and that session lives in
 * localStorage, so a page that can get a reader to click inside it can act as
 * them. `frame-ancestors` is the directive for this and it is unavailable to
 * us: browsers ignore it in a `<meta>` policy, and GitHub Pages serves this
 * repository's files with no headers we control. So the refusal is made here,
 * in the one place that can actually make it.
 *
 * IT IS AN IMPORT, NOT A FUNCTION CALL, and that is the whole design. A module
 * that throws while evaluating aborts every module that imports it, so
 * `dashboard/index.js` naming this file on its first import line cannot render,
 * bind a listener, or read a token when the check fails. A function would have
 * had to be called, and a guard you can forget to call is not a guard.
 *
 * Reading `self !== top` is allowed across origins. WRITING `top.location` is
 * not always: a sandboxed frame without allow-top-navigation throws. So the
 * break-out is attempted and its failure ignored; the blanked document below is
 * the part that has to hold either way, and it does not depend on it.
 */

function framed() {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent that makes even the comparison throw is a frame.
    return true;
  }
}

if (framed()) {
  try {
    document.documentElement.textContent = '';
  } catch {
    /* Nothing left to clear. The throw below is what stops the dashboard. */
  }
  try {
    window.top.location.replace(window.self.location.href);
  } catch {
    /* Sandboxed: we cannot leave the frame. Staying blank is the answer. */
  }
  throw new Error('jotlift: the dashboard does not run in a frame');
}
