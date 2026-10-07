// Readiness describes initial workspace/UI setup, not background collection or sync.
// Keep errors with the caller so the existing recovery/export UI remains available.
export async function runAppStartup(initialize, root) {
  root.dataset.appState = 'starting';
  try {
    const result = await initialize();
    root.dataset.appState = 'ready';
    return result;
  } catch (error) {
    root.dataset.appState = 'failed';
    throw error;
  }
}
