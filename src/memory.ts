/** What we remember about the first time a given content hash was seen. */
export interface SeenEntry {
  /** Human-readable description of where this content was first seen, e.g. "request #1, message[0] (user text)". */
  turnLabel: string;
  /** UTF-8 byte size of the original content the first time it was seen. */
  sizeBytes: number;
  /** ISO-8601 timestamp of when it was first seen. */
  firstSeenAt: string;
}

/**
 * Tracks content hashes seen so far per conversation, so that identical
 * content blocks — whether repeated later in the *same* request's message
 * array, or resent in full in a *later* HTTP request as part of the growing
 * conversation history — can be replaced with a short reference instead of
 * being forwarded to the upstream API again.
 *
 * State is in-memory and per-process (see README Limitations): restarting
 * the proxy clears all history, and running multiple proxy instances behind
 * a load balancer would not share dedup state.
 */
export class DedupMemory {
  private readonly conversations = new Map<string, Map<string, SeenEntry>>();

  private seenFor(conversationKey: string): Map<string, SeenEntry> {
    let seen = this.conversations.get(conversationKey);
    if (!seen) {
      seen = new Map();
      this.conversations.set(conversationKey, seen);
    }
    return seen;
  }

  /** Returns the entry for `hash` if this exact content was already sent earlier in this conversation. */
  lookup(conversationKey: string, hash: string): SeenEntry | undefined {
    return this.conversations.get(conversationKey)?.get(hash);
  }

  /** Records that `hash` was sent (in full) as described by `entry`. No-op if already recorded. */
  remember(conversationKey: string, hash: string, entry: SeenEntry): void {
    const seen = this.seenFor(conversationKey);
    if (!seen.has(hash)) {
      seen.set(hash, entry);
    }
  }

  /** Number of distinct content hashes remembered for a conversation. */
  size(conversationKey: string): number {
    return this.conversations.get(conversationKey)?.size ?? 0;
  }

  /** Number of distinct conversations tracked. */
  get conversationCount(): number {
    return this.conversations.size;
  }
}
