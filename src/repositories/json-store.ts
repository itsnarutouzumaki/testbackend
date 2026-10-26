import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "../types";

export class JsonStoreRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly emptyStoreFactory: () => Promise<Store>) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write(await this.emptyStoreFactory());
    }
  }

  async read(): Promise<Store> {
    await this.initialize();
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as Store;
  }

  async mutate<T>(operation: (store: Store) => Promise<T> | T): Promise<T> {
    let result!: T;
    const task = this.queue.then(async () => {
      const state = await this.read();
      result = await operation(state);
      await this.write(state);
    });
    this.queue = task.then(() => undefined, () => undefined);
    await task;
    return result;
  }

  async replace(store: Store): Promise<void> {
    const task = this.queue.then(() => this.write(store));
    this.queue = task.then(() => undefined, () => undefined);
    await task;
  }

  private async write(store: Store): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }
}
