export class BossInboxError extends Error {
  constructor(message, status = 400, code = 'BOSS_INBOX_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(message, status, code) {
  throw new BossInboxError(message, status, code);
}
