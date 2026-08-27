document.addEventListener('keydown', (e) => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  
  const focusable = Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.hasAttribute('disabled') && !el.closest('[hidden]') && el.offsetParent !== null);
  
  let current = document.activeElement;
  if (!focusable.includes(current)) {
    if (focusable.length) focusable[0].focus();
    return;
  }
  
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
    
    if (e.key === 'ArrowUp' && ccenter.y < center.y) {
      isCandidate = true;
      dist = Math.abs(ccenter.y - center.y) * 2 + Math.abs(ccenter.x - center.x);
    } else if (e.key === 'ArrowDown' && ccenter.y > center.y) {
      isCandidate = true;
      dist = Math.abs(ccenter.y - center.y) * 2 + Math.abs(ccenter.x - center.x);
    } else if (e.key === 'ArrowLeft' && ccenter.x < center.x && Math.abs(ccenter.y - center.y) < rect.height) {
      isCandidate = true;
      dist = Math.abs(ccenter.x - center.x);
    } else if (e.key === 'ArrowRight' && ccenter.x > center.x && Math.abs(ccenter.y - center.y) < rect.height) {
      isCandidate = true;
      dist = Math.abs(ccenter.x - center.x);
    }
    
    if (isCandidate && dist < minDistance) {
      minDistance = dist;
      best = candidate;
    }
  });
  
  if (best) {
    best.focus();
    best.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    e.preventDefault();
  }
});
