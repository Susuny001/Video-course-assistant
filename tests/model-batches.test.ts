import test from "node:test";
import assert from "node:assert/strict";
import { repairModelBatch } from "../server/model-batches.ts";

test("failed batches split while successful leaves and unresolved single-source evidence are retained", async () => {
  const original = ["first", "invalid", "last"];
  const completed: string[] = [], failed: string[] = [], attempts: string[][] = [];
  const retries: string[] = [];
  await repairModelBatch(original, async (items) => {
    attempts.push([...items]);
    if (items.length > 1) throw new Error("invalid JSON");
    if (items[0] === "invalid") throw Object.assign(new Error("引用无效"), {status: 422});
    completed.push(items[0]);
    // A consumer cannot remove siblings from subsequent retries by mutating its batch array.
    items.length = 0;
  }, {
    label: "1", onRetry: (message) => { retries.push(message); },
    onFailure: async (items) => { failed.push(...items); },
  });
  assert.deepEqual(completed, ["first", "last"]);
  assert.deepEqual(failed, ["invalid"]);
  assert.deepEqual(original, ["first", "invalid", "last"]);
  assert.equal(attempts.filter((items) => items.length === 1 && items[0] === "invalid").length, 2);
  assert.ok(retries.length > 0);
  assert.ok(attempts.length <= original.length * 4);
});

test("credentials, limits and unrelated storage failures are not multiplied into split requests", async () => {
  for (const error of [
    Object.assign(new Error("模型拒绝访问"), {status: 401}),
    Object.assign(new Error("模型服务限流"), {status: 429}),
    Object.assign(new Error("no space left on device"), {code: "ENOSPC"}),
  ]) {
    let calls = 0;
    const failed: number[][] = [];
    await repairModelBatch([1, 2, 3], async () => { calls++; throw error; }, {
      label: "1", onFailure: async (items) => { failed.push(items); },
    });
    assert.equal(calls, 1);
    assert.deepEqual(failed, [[1, 2, 3]]);
  }
});

test("repair depth is bounded and failures while persisting unresolved evidence propagate", async () => {
  const failed: number[][] = [];
  await repairModelBatch([1, 2, 3, 4], async () => { throw new Error("JSON无效"); }, {
    label: "1", maxDepth: 1, onFailure: async (items) => { failed.push(items); },
  });
  assert.deepEqual(failed, [[1, 2], [3, 4]]);
  await assert.rejects(repairModelBatch([1], async () => { throw new Error("JSON无效"); }, {
    label: "1", onFailure: async () => { throw new Error("cannot persist evidence"); },
  }), /cannot persist evidence/);
});
