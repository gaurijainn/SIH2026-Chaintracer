/**
 * Max-heap keyed by taint value, so the tracer always expands the highest-tainted frontier node
 * next (plan B4: "not plain breadth-first"). Lazy deletion: a node's taint can only grow while it
 * waits in the queue (multiple parents can feed it before it is popped), so every increase pushes a
 * fresh entry instead of reheapifying in place; a pop checks the entry against the caller's current
 * authoritative value for that key and is discarded as stale if it no longer matches.
 */
export interface HeapEntry<K> {
  key: K;
  taint: number;
}

export class TaintPriorityQueue<K> {
  private heap: HeapEntry<K>[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(key: K, taint: number): void {
    this.heap.push({ key, taint });
    this.bubbleUp(this.heap.length - 1);
  }

  /** Removes and returns the entry with the highest taint, or undefined if empty. */
  pop(): HeapEntry<K> | undefined {
    const top = this.heap[0];
    if (top === undefined) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.heap[parent].taint >= this.heap[idx].taint) break;
      [this.heap[parent], this.heap[idx]] = [this.heap[idx], this.heap[parent]];
      idx = parent;
    }
  }

  private bubbleDown(i: number): void {
    let idx = i;
    for (;;) {
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;
      let largest = idx;
      if (left < this.heap.length && this.heap[left].taint > this.heap[largest].taint) largest = left;
      if (right < this.heap.length && this.heap[right].taint > this.heap[largest].taint) largest = right;
      if (largest === idx) break;
      [this.heap[largest], this.heap[idx]] = [this.heap[idx], this.heap[largest]];
      idx = largest;
    }
  }
}
