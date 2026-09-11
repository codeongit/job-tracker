// Keep IME candidate text inside the native input until the user commits it.
export function bindCommittedTextInput(input, onValue) {
  let composing = false,
    lastValue = input.value;
  const commit = () => {
    if (composing || input.value === lastValue) return;
    lastValue = input.value;
    onValue(lastValue);
  };
  const start = () => {
    composing = true;
  };
  const end = () => {
    composing = false;
    commit();
  };
  const update = (event) => {
    if (!event.isComposing) commit();
  };
  input.addEventListener('compositionstart', start);
  input.addEventListener('compositionend', end);
  input.addEventListener('input', update);
  return () => {
    input.removeEventListener('compositionstart', start);
    input.removeEventListener('compositionend', end);
    input.removeEventListener('input', update);
  };
}

// A background sync must not replace an input while the system IME owns it.
export function trackComposition(root, onSettled) {
  let active = false,
    timer;
  const start = () => {
    active = true;
    clearTimeout(timer);
  };
  const end = () => {
    active = false;
    clearTimeout(timer);
    // Allow the final input event to run before any deferred page render.
    timer = setTimeout(() => {
      if (!active) onSettled();
    }, 0);
  };
  root.addEventListener('compositionstart', start, true);
  root.addEventListener('compositionend', end, true);
  return {
    get active() {
      return active;
    },
    dispose() {
      clearTimeout(timer);
      root.removeEventListener('compositionstart', start, true);
      root.removeEventListener('compositionend', end, true);
    },
  };
}
