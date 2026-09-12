/**
 * Worker script for 7-minute native execution smoke test.
 * Runs as a real OS child process and emits streaming JSON protocol lines
 * at designated intervals to test execution watchdog, heartbeat resets,
 * progress prose non-transition, and final contract completion.
 */
const fs = require('fs');

const startTime = Date.now();
const log = (msg) => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  const timeStr = `${m}m${s.toString().padStart(2, '0')}s`;
  process.stderr.write(`[Worker PID ${process.pid} @ ${timeStr}] ${msg}\n`);
};

log('Started worker process');

// Immediately emit init event
const convId = 'conv-native-7min-' + Date.now();
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: convId }) + '\n');
log('Emitted init event');

const scheduleAt = (seconds, fn) => {
  const delay = Math.max(0, seconds * 1000 - (Date.now() - startTime));
  setTimeout(fn, delay);
};

// At 60s (1m)
scheduleAt(60, () => {
  log('Emitting step_update @ 1m');
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'tool_call', text_delta: 'Executing long-running regression test suites...' }
  }) + '\n');
});

// At 180s (3m)
scheduleAt(180, () => {
  log('Emitting step_update @ 3m');
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 2, step_type: 'tool_call', text_delta: 'Regression tests actively running...' }
  }) + '\n');
});

// At 305s (5m05s): emit progress prose that previously triggered premature WAITING
scheduleAt(305, () => {
  log('Emitting progress prose result event @ 5m05s ("I will wait for the test suite...")');
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: convId,
      status: 'SUCCESS',
      response: 'I have launched the test command for test:persistence and test:antigravity and will wait for it to complete.'
    }
  }) + '\n');
});

// At 360s (6m00s): emit background command exit collection
scheduleAt(360, () => {
  log('Emitting background command completion @ 6m00s');
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 3,
      step_type: 'tool_call',
      state: 'DONE',
      text_delta: 'Background command npm run test:persistence and test:antigravity exited with code 0: 93 passed, 0 failed.'
    }
  }) + '\n');
});

// At 425s (7m05s): step update past 7 minutes
scheduleAt(425, () => {
  log('Emitting step_update @ 7m05s');
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 4, step_type: 'agent_response', text_delta: 'Validating all test results and preparing final completion contract.' }
  }) + '\n');
});

// At 435s (7m15s): emit explicit structured completion contract
scheduleAt(435, () => {
  log('Emitting explicit structured completion contract @ 7m15s');
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: convId,
      status: 'SUCCESS',
      response: '```json\n{"status":"completed","summary":"All 200 regression tests passed successfully."}\n```'
    }
  }) + '\n');

  // Exit cleanly shortly after
  setTimeout(() => {
    log('Worker exiting with code 0 @ 7m17s');
    process.exit(0);
  }, 2000);
});
