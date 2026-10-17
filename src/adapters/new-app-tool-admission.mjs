// Admission is shared by executor reads and sends. A remote rate limit is not
// evidence of a broken pipe, a failed task, or a successful model response.
export function isAppToolRateLimit(error) {
  if (error?.deliveryState === 'unknown') return false;
  return Number(error?.status ?? error?.statusCode) === 429 ||
    /too many requests|\bHTTP\s*429\b|\brate_limit(?:ed|_exceeded)?\b/i.test(String(error?.message || ''));
}

export class NewAppToolAdmission {
  #tail = Promise.resolve();
  constructor(db, { clock = Date.now } = {}) {
    this.db = db;
    this.clock = clock;
    db.exec(`create table if not exists new_app_tool_admission (
      id integer primary key check(id=1), blocked_until integer not null default 0,
      failures integer not null default 0, revision integer not null default 0,
      last_operation text, last_error text, last_failure_at text
    ); insert or ignore into new_app_tool_admission(id) values(1);`);
  }

  status() {
    const row = this.db.prepare('select * from new_app_tool_admission where id=1').get();
    const retryAfterMs = Math.max(0, row.blocked_until - this.clock());
    return {
      blocked: retryAfterMs > 0, reason: retryAfterMs > 0 ? 'rate_limit' : null,
      retryAfterMs, retryAt: retryAfterMs > 0 ? new Date(row.blocked_until).toISOString() : null,
      failures: row.failures, lastOperation: row.last_operation,
      lastError: row.last_error, lastFailureAt: row.last_failure_at,
    };
  }

  recordFailure(error, operation) {
    if (!isAppToolRateLimit(error)) return false;
    const row = this.db.prepare('select * from new_app_tool_admission where id=1').get();
    const nowMs = this.clock();
    const failures = row.failures + 1;
    const retryAfter = Number(error.retryAfterMs);
    const delay = Math.max(Math.min(120_000 * 2 ** Math.min(failures - 1, 3), 900_000),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0);
    this.db.prepare(`update new_app_tool_admission set blocked_until=?,failures=?,revision=revision+1,
      last_operation=?,last_error=?,last_failure_at=? where id=1`)
      .run(Math.max(row.blocked_until, nowMs + delay), failures, operation,
        String(error.message || 'Too many requests').slice(0, 1200), new Date(nowMs).toISOString());
    return true;
  }

  run(operation, invoke) {
    const result = this.#tail.catch(() => {}).then(async () => {
      const status = this.status();
      if (status.blocked) {
        const error = new Error(`App tool requests are cooling down until ${status.retryAt}`);
        error.code = 'DEVSPACE_NEW_APP_RATE_LIMITED';
        error.retryAfterMs = status.retryAfterMs;
        error.retryAt = status.retryAt;
        error.stage = 'app_tool_admission';
        throw error;
      }
      const revision = this.db.prepare('select revision from new_app_tool_admission where id=1').get().revision;
      try {
        const value = await invoke();
        // A successful RPC releases the transport cooldown; it never renews a
        // task lease, counts as business work, or verifies the selected model.
        this.db.prepare('update new_app_tool_admission set blocked_until=0,failures=0 where id=1 and revision=?').run(revision);
        return value;
      } catch (error) {
        this.recordFailure(error, operation);
        throw error;
      }
    });
    this.#tail = result;
    return result;
  }
}
