export class OpslingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OpslingError';
  }
}

export class ConfigError extends OpslingError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

export class CollectorError extends OpslingError {
  constructor(
    public readonly collector: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${collector}] ${message}`, options);
    this.name = 'CollectorError';
  }
}

export class NotifierError extends OpslingError {
  constructor(
    public readonly notifier: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${notifier}] ${message}`, options);
    this.name = 'NotifierError';
  }
}
