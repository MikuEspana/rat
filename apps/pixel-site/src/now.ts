// The site's clock. Normally the wall clock; the launch simulator swaps in its own time, so "5m ago", the
// next-hire countdown and new feed lines follow the simulated launch at any speed.
let source: () => number = () => Date.now();

export function now(): number {
  return source();
}

export function setNowSource(fn: () => number): void {
  source = fn;
}
