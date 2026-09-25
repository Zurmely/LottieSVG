import type { ConversionWarning, WarningSeverity } from './types.js';

export class WarningCollector {
  private readonly seen = new Set<string>();
  readonly list: ConversionWarning[] = [];

  add(code: string, message: string, element?: string, severity: WarningSeverity = 'warning'): void {
    const key = `${code}|${element ?? ''}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ code, message, severity, ...(element ? { element } : {}) });
  }

  info(code: string, message: string, element?: string): void {
    this.add(code, message, element, 'info');
  }
}
