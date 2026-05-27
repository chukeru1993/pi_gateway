import type { ServerResponse } from "node:http";

export interface SSEWriter {
  write(event: string, data: unknown): void;
  end(): void;
  heartbeat(): void;
}

export function createSSEWriter(res: ServerResponse): SSEWriter {
  let ended = false;
  return {
    write(event: string, data: unknown) {
      if (ended) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (ended) return;
      ended = true;
      res.end();
    },
    heartbeat() {
      if (ended) return;
      res.write(": heartbeat\n\n");
    },
  };
}
