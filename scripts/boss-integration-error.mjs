export class BossIntegrationError extends Error {
  constructor(code, message = code, { status = 1, fatal = false, nextAllowedAt = '', usage } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.fatal = fatal;
    this.nextAllowedAt = nextAllowedAt;
    if (usage) this.usage = usage;
  }
}

export function integrationFail(code, options) {
  throw new BossIntegrationError(code, code, options);
}
