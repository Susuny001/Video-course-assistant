export interface BatchRepairOptions<T> {
  label: string;
  onRetry?: (message: string) => void;
  onFailure: (items: T[], error: Error, label: string) => Promise<void>;
  maxDepth?: number;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function retryable(error: Error): boolean {
  const details = error as Error & {status?: number; statusCode?: number};
  const status = details.status ?? details.statusCode;
  if ([400, 401, 403, 429].includes(status || 0)) return false;
  return status === 422 || /超时|timeout|JSON|格式|引用|截断|长度|length|不完整|\bID\b|模型没有返回/i.test(error.message);
}

/** Retry failed model work without discarding successful leaves or any source item. */
export async function repairModelBatch<T>(
  items: T[],
  process: (items: T[], label: string) => Promise<void>,
  options: BatchRepairOptions<T>,
): Promise<void> {
  const maxDepth = Number.isFinite(options.maxDepth)
    ? Math.max(0, Math.floor(options.maxDepth!))
    : 6;

  const run = async (batch: T[], label: string, depth: number): Promise<void> => {
    if (!batch.length) return;
    let failure: Error;
    try {
      await process([...batch], label);
      return;
    } catch (error) {
      failure = asError(error);
    }
    if (!retryable(failure)) {
      await options.onFailure([...batch], failure, label);
      return;
    }
    if (batch.length > 1 && depth < maxDepth) {
      const middle = Math.floor(batch.length / 2);
      options.onRetry?.(`第 ${label} 批返回不完整或无效内容，拆分来源后自动重试。`);
      await run(batch.slice(0, middle), label + ".1", depth + 1);
      await run(batch.slice(middle), label + ".2", depth + 1);
      return;
    }
    if (batch.length === 1) {
      options.onRetry?.(`第 ${label} 批已缩小至单段，再次核查模型输出。`);
      try {
        await process([...batch], label + ".retry");
        return;
      } catch (error) {
        failure = asError(error);
      }
    }
    await options.onFailure([...batch], failure, label);
  };

  await run([...items], options.label, 0);
}
