export type CaptureEvent = {
  at: string;
  title: string;
  source: string;
  tenantId: string;
  principalId: string;
};

/** In-memory ring buffer for the product capture timeline UI. */
export class CaptureLog {
  private readonly events: CaptureEvent[] = [];
  constructor(private readonly max = 200) {}

  record(event: CaptureEvent): void {
    this.events.unshift(event);
    if (this.events.length > this.max) this.events.length = this.max;
  }

  list(limit = 50): CaptureEvent[] {
    return this.events.slice(0, Math.min(limit, this.max));
  }
}
