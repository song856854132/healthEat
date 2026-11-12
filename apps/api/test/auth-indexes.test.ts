import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { User } from "../src/models/index.js";

// Own file on purpose: ensureIndexes() caches its promise at module level, so the very first
// register() of this worker is the only one that can observe a failed index build.
describe("register when the index build fails once", () => {
  // Value: protects=a transient index-build failure answers one 500 and the next register() retries and
  //   succeeds, instead of the rejection being cached as a permanent 5xx on this warm instance;
  //   fails_when=the .catch that clears indexesReady in services/auth.ts is removed (the second register
  //   keeps failing with the same cached rejection); why_new=no test exercised ensureIndexes' rejection
  //   path, and the same bug class is what db.ts guards against; seam=none; no_claim=connect-mongo's own
  //   cached collection promise (session.ts) is not exercised here; vi.spyOn stands in for an Atlas error
  it("answers 500 once, then registers normally on the next request", async () => {
    vi.spyOn(User, "createIndexes").mockRejectedValueOnce(new Error("index build timed out"));
    const body = {
      username: "retry_user",
      email: "retry@example.com",
      password: "correct horse battery",
      timezone: "UTC",
    };
    const failed = await request(app).post("/api/auth/register").send(body).expect(500);
    expect(failed.body.error).toBe("internal");
    expect(failed.headers["set-cookie"]).toBeUndefined();
    expect(await User.countDocuments()).toBe(0);
    const ok = await request(app).post("/api/auth/register").send(body).expect(201);
    expect(ok.body.user.username).toBe("retry_user");
    expect(await User.countDocuments()).toBe(1);
  });
});
