// A form control owns some arrow keys, and the d-pad must not take them.
//
// Before this guard, every arrow moved focus, whatever had it. In Search,
// LEFT/RIGHT jumped out of the box instead of moving the caret, and UP/DOWN on
// the quality select moved focus instead of changing the value. So:
//
//   text box (input)     LEFT/RIGHT move the caret. UP/DOWN leave the box.
//   slider (range)       LEFT/RIGHT change the value. UP/DOWN leave it.
//   select               every arrow changes the value.
//   textarea, editable   every arrow moves the caret.
//
// And ONE way out of any control: Escape or the remote's Back leaves it, to the
// nearest control below (or above). That press is not swallowed, so a dialog or
// panel that closes on Back still closes.
const NOT_TEXT = ['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'color', 'hidden'];

function controlKind(el) {
  if (!el) return null;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return 'multiline';
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName !== 'INPUT') return null;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (type === 'range') return 'range';
  return NOT_TEXT.includes(type) ? null : 'text';
}

// webOS sends Back as keyCode 461, Tizen as 10009. A desktop sends Escape.
function isBackKey(e) {
  return e.key === 'Escape' || e.key === 'Back' || e.key === 'GoBack' || e.keyCode === 461 || e.keyCode === 10009;
}

function focusables() {
  return Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.hasAttribute('disabled') && !el.closest('[hidden]') && el.offsetParent !== null);
}

function nearest(key, current, focusable) {
  const rect = current.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

  let best = null;
  let minDistance = Infinity;

  focusable.forEach(candidate => {
    if (candidate === current) return;
    const crect = candidate.getBoundingClientRect();
    const ccenter = { x: crect.left + crect.width / 2, y: crect.top + crect.height / 2 };

    let isCandidate = false;
    let dist = 0;

    if (key === 'ArrowUp' && ccenter.y < center.y) {
      isCandidate = true;
      dist = Math.abs(ccenter.y - center.y) * 2 + Math.abs(ccenter.x - center.x);
    } else if (key === 'ArrowDown' && ccenter.y > center.y) {
      isCandidate = true;
      dist = Math.abs(ccenter.y - center.y) * 2 + Math.abs(ccenter.x - center.x);
    } else if (key === 'ArrowLeft' && ccenter.x < center.x && Math.abs(ccenter.y - center.y) < rect.height) {
      isCandidate = true;
      dist = Math.abs(ccenter.x - center.x);
    } else if (key === 'ArrowRight' && ccenter.x > center.x && Math.abs(ccenter.y - center.y) < rect.height) {
      isCandidate = true;
      dist = Math.abs(ccenter.x - center.x);
    }

    if (isCandidate && dist < minDistance) {
      minDistance = dist;
      best = candidate;
    }
  });
  return best;
}

function moveTo(el) {
  el.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
}

document.addEventListener('keydown', (e) => {
  const current = document.activeElement;
  const kind = controlKind(current);

  if (isBackKey(e)) {
    if (!kind) return;
    const focusable = focusables();
    const out = nearest('ArrowDown', current, focusable) || nearest('ArrowUp', current, focusable);
    if (out) moveTo(out);
    else current.blur();
    return;
  }

  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

  const sideways = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (kind === 'select' || kind === 'multiline') return;
  if ((kind === 'text' || kind === 'range') && sideways) return;

  const focusable = focusables();
  if (!focusable.includes(current)) {
    if (focusable.length) focusable[0].focus();
    return;
  }

  const best = nearest(e.key, current, focusable);
  if (best) {
    moveTo(best);
    e.preventDefault();
  }
});
