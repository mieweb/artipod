(() => {
  const retained = [];
  const incrementBytes = 16 * 1024;
  const limitBytes = 8 * 1024 * 1024;
  let activeMs = 0;
  let runningSince = performance.now();
  let timer = null;
  let retainedBytes = 0;
  let count = 0;
  const elapsed = document.querySelector('#elapsed');
  const memory = document.querySelector('#memory');
  const allocation = document.querySelector('#allocation');
  const allocationState = document.querySelector('#allocation-state');
  const counter = document.querySelector('#count');
  const increment = document.querySelector('#increment');
  increment.onclick = () => { count += 1; counter.textContent = String(count); };

  const elapsedMs = () => Math.max(0, activeMs + (runningSince === null ? 0 : performance.now() - runningSince));
  const state = () => (runningSince === null ? 'suspended' : 'running');
  const telemetry = () => ({ elapsedMs: elapsedMs(), retainedBytes, limitBytes });

  function render() {
    elapsed.textContent = `${Math.floor(elapsedMs() / 1000)} s`;
    memory.textContent = retainedBytes < 1024 * 1024
      ? `${retainedBytes / 1024} KiB`
      : `${(retainedBytes / (1024 * 1024)).toFixed(2)} MiB`;
    allocation.value = retainedBytes;
    allocationState.textContent = state() === 'suspended' ? 'Suspended'
      : retainedBytes === limitBytes ? 'Allocation limit reached' : 'Allocating 16 KiB / second';
  }

  function report() {
    render();
    parent.postMessage({ type: 'artipod:runtime-telemetry/v1', ...telemetry() }, location.origin);
  }

  function tick() {
    if (runningSince === null) return;
    if (retainedBytes < limitBytes) {
      const buffer = new Uint8Array(Math.min(incrementBytes, limitBytes - retainedBytes));
      buffer.fill(1);
      retained.push(buffer);
      retainedBytes += buffer.byteLength;
    }
    report();
  }

  function suspend() {
    if (runningSince === null) return;
    activeMs += performance.now() - runningSince;
    runningSince = null;
    clearInterval(timer);
    timer = null;
    increment.disabled = true;
    render();
  }

  function resume() {
    if (runningSince !== null) return;
    runningSince = performance.now();
    increment.disabled = false;
    timer = setInterval(tick, 1000);
    render();
  }

  function onMessage(event) {
    if (event.source !== parent || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'artipod:runtime-lifecycle/v1/query') {
      parent.postMessage({ type: 'artipod:runtime-lifecycle/v1/ready', state: state(), telemetry: telemetry() }, location.origin);
      return;
    }
    if (data.type !== 'artipod:runtime-lifecycle/v1/request' || typeof data.id !== 'string') return;
    if (data.command === 'suspend') suspend();
    else if (data.command === 'resume') resume();
    else return;
    parent.postMessage({ type: 'artipod:runtime-lifecycle/v1/ack', id: data.id, state: state(), telemetry: telemetry() }, location.origin);
  }

  report();
  timer = setInterval(tick, 1000);
  addEventListener('message', onMessage);
  parent.postMessage({ type: 'artipod:runtime-lifecycle/v1/ready', state: state(), telemetry: telemetry() }, location.origin);

  addEventListener('pagehide', () => {
    clearInterval(timer);
    removeEventListener('message', onMessage);
    retained.length = 0;
    retainedBytes = 0;
    increment.onclick = null;
  }, { once: true });
})();