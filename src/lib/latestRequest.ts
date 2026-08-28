export class LatestRequest {
  private sequence = 0;

  begin(): number {
    this.sequence += 1;
    return this.sequence;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.sequence;
  }

  invalidate(): void {
    this.sequence += 1;
  }
}
