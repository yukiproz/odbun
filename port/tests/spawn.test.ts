import { describe, expect, test } from "bun:test";
import { spawnCapture } from "../runtime/proc/bun-spawn.ts";

describe("Bun.spawn helper", () => {
  test("captures stdout and exit code", async () => {
    const r = await spawnCapture(["printf", "hello-bun"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello-bun");
  });

  test("PWD env carries the cwd (OpenCode v2 directory contract)", async () => {
    const r = await spawnCapture(["pwd"], { cwd: "/tmp" });
    expect(r.stdout.trim()).toBe("/tmp");
    const r2 = await spawnCapture(["bash", "-c", "echo $PWD"], { cwd: "/tmp" });
    expect(r2.stdout.trim()).toBe("/tmp");
  });

  test("non-zero exit is reported, not thrown", async () => {
    const r = await spawnCapture(["bash", "-c", "exit 7"]);
    expect(r.exitCode).toBe(7);
  });
});
