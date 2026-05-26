import type { ServerResponse } from "node:http";

export interface SSEWriter {
  write(event: string, data: unknown): void;
  end(): void;
  heartbeat(): void;
}

export function createSSEWriter(res: ServerResponse): SSEWriter {
  return {
    write(event: string, data: unknown) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    },
    heartbeat() {
      res.write(": heartbeat\n\n");
    },
  };
}
